// Polyfill
import { URL as _URL, URLSearchParams as _URLSearchParams } from 'whatwg-url'
// @ts-ignore
Object.assign(_URL, self.URL)
Object.assign(self, { URL: _URL, URLSearchParams: _URLSearchParams })

import {
    createMessageConnection,
    MessageConnection,
    toSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import { AsyncIterableX, merge } from 'ix/asynciterable/index'
import { MergeAsyncIterable } from 'ix/asynciterable/merge'
import { filter, flatMap, map, scan } from 'ix/asynciterable/pipe/index'
import { fromPairs } from 'lodash'
import * as sourcegraph from 'sourcegraph'
import {
    DefinitionRequest,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    HoverRequest,
    ImplementationRequest,
    InitializeParams,
    InitializeRequest,
    LogMessageNotification,
    PublishDiagnosticsNotification,
    ReferenceContext,
    ReferenceParams,
    ReferencesRequest,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { getOrCreateAccessToken } from './auth'
import {
    findPackageDependentsWithNpm,
    findPackageDependentsWithSourcegraphExtensionRegistry as findDependentsWithSourcegraphExtensionRegistry,
    findPackageDependentsWithSourcegraphSearch,
    findPackageName,
} from './dependencies'
import { resolveRev, SourcegraphInstance } from './graphql'
import { Logger, LSP_TO_LOG_LEVEL, RedactingLogger } from './logging'
import { convertHover, convertLocation, convertLocations } from './lsp-conversion'
import { resolveServerRootUri, rewriteUris, toServerTextDocumentUri, toSourcegraphTextDocumentUri } from './uris'
import { asArray, observableFromAsyncIterable, throwIfAbortError } from './util'

const connectionsByRootUri = new Map<string, Promise<MessageConnection>>()

const isTypeScriptFile = (textDocumentUri: URL): boolean => /\.m?(?:t|j)sx?$/.test(textDocumentUri.hash)

const documentSelector: sourcegraph.DocumentSelector = [
    { language: 'typescript' },
    { language: 'javascript' },
    { language: 'json' },
]

const logger: Logger = new RedactingLogger(console)

export async function activate(ctx: sourcegraph.ExtensionContext): Promise<void> {
    const accessToken = await getOrCreateAccessToken()

    /** Adds the access token to the given server raw HTTP API URI, if available */
    function authenticateUri(uri: URL): URL {
        const authenticatedUri = new URL(uri.href)
        if (accessToken) {
            authenticatedUri.username = accessToken
        }
        return authenticatedUri
    }

    /**
     * @param rootUri The server HTTP root URI
     */
    async function connect(rootUri: URL): Promise<MessageConnection> {
        const serverUrl: unknown = sourcegraph.configuration.get().get('typescript.serverUrl')
        if (typeof serverUrl !== 'string') {
            throw new Error(
                'Setting typescript.serverUrl must be set to the WebSocket endpoint of the TypeScript language service'
            )
        }
        const socket = new WebSocket(serverUrl)
        ctx.subscriptions.add(() => socket.close())
        socket.addEventListener('close', event => {
            logger.warn('WebSocket connection to TypeScript backend closed', event)
        })
        socket.addEventListener('error', event => {
            logger.error('WebSocket error', event)
        })
        const rpcWebSocket = toSocket(socket)
        const connection = createMessageConnection(
            new WebSocketMessageReader(rpcWebSocket),
            new WebSocketMessageWriter(rpcWebSocket),
            logger
        )
        ctx.subscriptions.add(() => connection.dispose())
        connection.onNotification(LogMessageNotification.type, ({ type, message }) => {
            // Blue background for the "TypeScript server" prefix
            const method = LSP_TO_LOG_LEVEL[type]
            const args = [
                new Date().toLocaleTimeString() + ' %cTypeScript backend%c %s',
                'background-color: blue; color: white',
                '',
                message,
            ]
            logger[method](...args)
        })
        connection.listen()
        const event = await new Promise<Event>(resolve => {
            socket.addEventListener('open', resolve, { once: true })
            socket.addEventListener('error', resolve, { once: true })
        })
        if (event.type === 'error') {
            throw new Error(`The WebSocket to the TypeScript backend at ${serverUrl} could not not be opened`)
        }
        logger.log(`WebSocket connection to TypeScript backend at ${serverUrl} opened`)
        const initializeParams: InitializeParams = {
            processId: 0,
            rootUri: rootUri.href,
            workspaceFolders: [{ name: '', uri: rootUri.href }],
            capabilities: {},
            initializationOptions: {
                // until workspace/configuration is allowed during initialize
                configuration: {
                    // The server needs to use the API to resolve repositories
                    'sourcegraph.url': sourcegraph.internal.sourcegraphURL.toString(),
                    ...fromPairs(
                        Object.entries(sourcegraph.configuration.get().value).filter(([key]) =>
                            key.startsWith('typescript.')
                        )
                    ),
                },
            },
        }
        logger.log('Initializing TypeScript backend...')
        const initResult = await connection.sendRequest(InitializeRequest.type, initializeParams)
        logger.log('TypeScript backend initialized', initResult)
        // Tell language server about all currently open text documents under this root
        for (const textDocument of sourcegraph.workspace.textDocuments) {
            if (!isTypeScriptFile(new URL(textDocument.uri))) {
                continue
            }
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(new URL(textDocument.uri)))
            if (!serverTextDocumentUri.href.startsWith(rootUri.href)) {
                continue
            }
            const didOpenParams: DidOpenTextDocumentParams = {
                textDocument: {
                    uri: serverTextDocumentUri.href,
                    languageId: textDocument.languageId,
                    text: textDocument.text,
                    version: 1,
                },
            }
            connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
        }
        // Log diagnostics
        connection.onNotification(PublishDiagnosticsNotification.type, params => {
            logger.log('Diagnostics', params)
        })
        return connection
    }

    /**
     * @param rootUri The server HTTP root URI
     */
    async function getOrCreateConnection(rootUri: URL): Promise<MessageConnection> {
        let connectionPromise = connectionsByRootUri.get(rootUri.href)
        if (!connectionPromise) {
            connectionPromise = connect(rootUri)
            connectionsByRootUri.set(rootUri.href, connectionPromise)
        }
        const connection = await connectionPromise
        connection.onClose(() => {
            connectionsByRootUri.delete(rootUri.href)
        })
        return connection
    }

    // Forward didOpen notifications
    ctx.subscriptions.add(
        sourcegraph.workspace.onDidOpenTextDocument.subscribe(async textDocument => {
            try {
                const textDocumentUri = new URL(textDocument.uri)
                if (!isTypeScriptFile(textDocumentUri)) {
                    return
                }

                const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                const connection = await getOrCreateConnection(serverRootUri)
                const didOpenParams: DidOpenTextDocumentParams = {
                    textDocument: {
                        uri: serverTextDocumentUri.href,
                        languageId: textDocument.languageId,
                        text: textDocument.text,
                        version: 1,
                    },
                }
                connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
            } catch (err) {
                logger.error('Error handling didOpenTextDocument event', err)
            }
        })
    )

    /** Workaround for https://github.com/sourcegraph/sourcegraph/issues/1321 */
    function distinctUntilChanged<P extends any[], R>(
        compare: (a: P, b: P) => boolean,
        fn: (...args: P) => R
    ): ((...args: P) => R) {
        let previousResult: R
        let previousArgs: P
        return (...args) => {
            if (previousArgs && compare(previousArgs, args)) {
                return previousResult
            }
            previousArgs = args
            previousResult = fn(...args)
            return previousResult
        }
    }

    const areProviderParamsEqual = (
        [doc1, pos1]: [sourcegraph.TextDocument, sourcegraph.Position],
        [doc2, pos2]: [sourcegraph.TextDocument, sourcegraph.Position]
    ): boolean => doc1.uri === doc2.uri && pos1.isEqual(pos2)

    // Hover
    ctx.subscriptions.add(
        sourcegraph.languages.registerHoverProvider(documentSelector, {
            provideHover: distinctUntilChanged(areProviderParamsEqual, async (textDocument, position) => {
                const startTime = Date.now()
                try {
                    const textDocumentUri = new URL(textDocument.uri)
                    const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                    const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                    const connection = await getOrCreateConnection(serverRootUri)
                    const hoverResult = await connection.sendRequest(HoverRequest.type, {
                        textDocument: { uri: serverTextDocumentUri.href },
                        position,
                    })
                    rewriteUris(hoverResult, toSourcegraphTextDocumentUri)
                    return convertHover(hoverResult)
                } finally {
                    logger.log(`Hover result after ${((Date.now() - startTime) / 1000).toFixed(3)}s`)
                }
            }),
        })
    )

    // Definition
    ctx.subscriptions.add(
        sourcegraph.languages.registerDefinitionProvider(documentSelector, {
            provideDefinition: distinctUntilChanged(areProviderParamsEqual, async (textDocument, position) => {
                const textDocumentUri = new URL(textDocument.uri)
                const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                const connection = await getOrCreateConnection(serverRootUri)
                const definitionResult = await connection.sendRequest(DefinitionRequest.type, {
                    textDocument: { uri: serverTextDocumentUri.href },
                    position,
                })
                rewriteUris(definitionResult, toSourcegraphTextDocumentUri)
                return convertLocations(definitionResult)
            }),
        })
    )

    // References
    ctx.subscriptions.add(
        sourcegraph.languages.registerReferenceProvider(documentSelector, {
            provideReferences: (textDocument, position) =>
                observableFromAsyncIterable(
                    (async function*() {
                        const textDocumentUri = new URL(textDocument.uri)
                        const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                        const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                        const connection = await getOrCreateConnection(serverRootUri)

                        const context: ReferenceContext = {
                            includeDeclaration: false,
                        }

                        yield* merge(
                            // Same-repo references
                            (async function*() {
                                logger.log('Searching for same-repo references')
                                const sameRepoReferences = asArray(
                                    await connection.sendRequest(ReferencesRequest.type, {
                                        textDocument: { uri: serverTextDocumentUri.href },
                                        position,
                                        context,
                                    })
                                )
                                logger.log(`Found ${sameRepoReferences.length} same-repo references`)
                                yield sameRepoReferences
                            })(),
                            // Cross-repo references
                            // Find canonical source location
                            (async function*() {
                                logger.log('Getting canonical definition for cross-repo references')
                                const definitions = asArray(
                                    await connection.sendRequest(DefinitionRequest.type, {
                                        textDocument: { uri: serverTextDocumentUri.href },
                                        position,
                                    })
                                )
                                logger.log(`Got ${definitions.length} definitions`)
                                const instanceUrl = new URL(sourcegraph.internal.sourcegraphURL.toString())
                                const sgInstance: SourcegraphInstance = {
                                    accessToken,
                                    instanceUrl,
                                }
                                const findPackageDependents =
                                    instanceUrl.hostname === 'sourcegraph.com'
                                        ? findPackageDependentsWithNpm
                                        : findPackageDependentsWithSourcegraphSearch

                                yield* new MergeAsyncIterable(
                                    definitions.map(async function*(definition) {
                                        try {
                                            logger.log(`Getting external references for definition`, definition)

                                            const definitionUri = new URL(definition.uri)

                                            const referenceParams: ReferenceParams = {
                                                textDocument: { uri: definitionUri.href },
                                                position: definition.range.start,
                                                context,
                                            }

                                            const packageName = await findPackageName(definitionUri, { logger })

                                            // Find dependent packages on the package
                                            const dependents =
                                                packageName === 'sourcegraph'
                                                    ? // If the package name is "sourcegraph", we are looking for references to a symbol in the Sourcegraph extension API
                                                      // Extensions are not published to npm, so search the extension registry
                                                      findDependentsWithSourcegraphExtensionRegistry(sgInstance, {
                                                          logger,
                                                      })
                                                    : findPackageDependents(packageName, sgInstance, { logger })

                                            // Search for references in each dependent
                                            yield* AsyncIterableX.from(dependents).pipe(
                                                flatMap(async function*(repoName) {
                                                    try {
                                                        const commitID = await resolveRev(repoName, 'HEAD', sgInstance)
                                                        const dependentRootUri = authenticateUri(
                                                            new URL(`${repoName}@${commitID}/-/raw/`, instanceUrl)
                                                        )
                                                        logger.log(
                                                            `Looking for external references in dependent repo ${repoName}`
                                                        )
                                                        const dependentConnection = await getOrCreateConnection(
                                                            dependentRootUri
                                                        )
                                                        const referencesInDependent = asArray(
                                                            await dependentConnection.sendRequest(
                                                                ReferencesRequest.type,
                                                                referenceParams
                                                            )
                                                        )
                                                        logger.log(
                                                            `Found ${
                                                                referencesInDependent.length
                                                            } references in dependent repo ${repoName}`
                                                        )
                                                        yield referencesInDependent
                                                    } catch (err) {
                                                        throwIfAbortError(err)
                                                        logger.error(
                                                            `Error searching dependent repo "${repoName}" for references`,
                                                            err
                                                        )
                                                    }
                                                })
                                            )
                                            logger.log('Done going through dependents')
                                        } catch (err) {
                                            throwIfAbortError(err)
                                            logger.error(
                                                `Error searching for external references for definition`,
                                                definition,
                                                err
                                            )
                                        }
                                    })
                                )
                            })()
                        ).pipe(
                            filter(chunk => chunk.length > 0),
                            // Rewrite URIs and convert from LSP to Sourcegraph Location
                            map(chunk =>
                                chunk
                                    .map(location => {
                                        try {
                                            return convertLocation({
                                                ...location,
                                                uri: toSourcegraphTextDocumentUri(new URL(location.uri)).href,
                                            })
                                        } catch (err) {
                                            return undefined
                                        }
                                    })
                                    .filter((location): location is Exclude<typeof location, undefined> => !!location)
                            ),
                            // Aggregate individual chunks into a growing array (which is what Sourcegraph expects)
                            scan((allReferences, chunk) => allReferences.concat(chunk), [])
                        )
                    })()
                ),
        })
    )

    // Implementations
    ctx.subscriptions.add(
        sourcegraph.languages.registerImplementationProvider(documentSelector, {
            provideImplementation: async (textDocument, position) => {
                const textDocumentUri = new URL(textDocument.uri)
                const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                const connection = await getOrCreateConnection(serverRootUri)
                const implementationParams: TextDocumentPositionParams = {
                    textDocument: { uri: serverTextDocumentUri.href },
                    position,
                }
                const implementationResult = await connection.sendRequest(
                    ImplementationRequest.type,
                    implementationParams
                )
                rewriteUris(implementationResult, toSourcegraphTextDocumentUri)
                return convertLocations(implementationResult)
            },
        })
    )
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
