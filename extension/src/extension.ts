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
    ReferenceParams,
    ReferencesRequest,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { getOrCreateAccessToken } from './auth'
import { convertHover, convertLocations } from './lsp-conversion'
import { resolveServerRootUri, rewriteUris, toServerTextDocumentUri, toSourcegraphTextDocumentUri } from './uris'

const connectionsByRootUri = new Map<string, Promise<MessageConnection>>()

async function connect(rootUri: URL): Promise<MessageConnection> {
    const serverUrl: unknown = sourcegraph.configuration.get().get('typescript.serverUrl')
    if (typeof serverUrl !== 'string') {
        throw new Error(
            'Setting typescript.serverUrl must be set to the WebSocket endpoint of the TypeScript language service'
        )
    }
    const socket = new WebSocket(serverUrl)
    const rpcWebSocket = toSocket(socket)
    const connection = createMessageConnection(
        new WebSocketMessageReader(rpcWebSocket),
        new WebSocketMessageWriter(rpcWebSocket),
        console
    )
    connection.onNotification(LogMessageNotification.type, ({ type, message }) => {
        // Blue background for the "TypeScript server" prefix
        const args = [
            // console.info() doesn't get a visual distinction or filter in Chrome anymore
            (type === 3 ? 'ℹ️' : '') + '%cTypeScript backend%c %s',
            'background-color: blue; color: white',
            '',
            message,
        ]
        switch (type) {
            case 1:
                console.error(...args)
                break
            case 2:
                console.warn(...args)
                break
            case 3:
                console.info(...args)
                break
            case 4:
            default:
                console.log(...args)
                break
        }
    })
    connection.listen()
    const event = await new Promise<Event>(resolve => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', resolve, { once: true })
    })
    if (event.type === 'error') {
        throw new Error(`The WebSocket to the TypeScript server at ${serverUrl} could not not be opened`)
    }
    console.log(`WebSocket connection to TypeScript server at ${serverUrl} opened`)
    const initializeParams: InitializeParams = {
        processId: 0,
        rootUri: rootUri.href,
        workspaceFolders: [{ name: '', uri: rootUri.href }],
        capabilities: {},
        initializationOptions: {
            // until workspace/configuration is allowed during initialize
            configuration: fromPairs(
                Object.entries(sourcegraph.configuration.get().value).filter(([key]) => key.startsWith('typescript.'))
            ),
        },
    }
    console.log('Initializing TypeScript server...')
    const initResult = await connection.sendRequest(InitializeRequest.type, initializeParams)
    console.log('TypeScript server initialized', initResult)
    return connection
}

async function getOrCreateConnection(rootUri: URL): Promise<MessageConnection> {
    let connectionPromise = connectionsByRootUri.get(rootUri.href)
    if (!connectionPromise) {
        connectionPromise = connect(rootUri)
        connectionsByRootUri.set(rootUri.href, connectionPromise)
    }
    const connection = await connectionPromise
    connection.onClose(() => {
        console.log('WebSocket connection to TypeScript server closed')
        connectionsByRootUri.delete(rootUri.href)
    })
    return connection
}

const isTypeScriptFile = (textDocumentUri: URL): boolean => /\.m?(?:t|j)sx?$/.test(textDocumentUri.hash)

export async function activate(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, 10))

    const accessToken = await getOrCreateAccessToken()

    /** Adds the access token to the given server raw HTTP API URI */
    function authenticateUri(uri: URL): URL {
        const authenticatedUri = new URL(uri.href)
        authenticatedUri.username = accessToken
        return authenticatedUri
    }

    // Forward didOpen notifications
    const sendDidOpen = async (textDocument: sourcegraph.TextDocument) => {
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
            console.error('Error handling didOpenTextDocument event', err)
        }
    }
    console.log('Currently open textDocuments', sourcegraph.workspace.textDocuments)
    sourcegraph.workspace.onDidOpenTextDocument.subscribe(async textDocument => {
        console.log('onDidOpenTextDocument fired', textDocument)
        await sendDidOpen(textDocument)
    })
    await Promise.all(sourcegraph.workspace.textDocuments.map(sendDidOpen))

    // Example of a Sourcegraph textdocument URI:
    // git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts

    // Hover
    sourcegraph.languages.registerHoverProvider([{ pattern: '**/*.*' }], {
        provideHover: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                return undefined
            }
            const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
            const connection = await getOrCreateConnection(serverRootUri)
            const hoverResult = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            })
            rewriteUris(hoverResult, toSourcegraphTextDocumentUri)
            return convertHover(hoverResult)
        },
    })

    // Definition
    sourcegraph.languages.registerDefinitionProvider([{ pattern: '**/*.*' }], {
        provideDefinition: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                return undefined
            }
            const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
            const connection = await getOrCreateConnection(serverRootUri)
            const definitionResult = await connection.sendRequest(DefinitionRequest.type, {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            })
            rewriteUris(definitionResult, toSourcegraphTextDocumentUri)
            return convertLocations(definitionResult)
        },
    })

    // References
    sourcegraph.languages.registerReferenceProvider([{ pattern: '**/*.*' }], {
        provideReferences: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                return undefined
            }
            const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
            const connection = await getOrCreateConnection(serverRootUri)
            const referenceParams: ReferenceParams = {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
                context: {
                    includeDeclaration: false,
                },
            }
            const referencesResult = await connection.sendRequest(ReferencesRequest.type, referenceParams)
            rewriteUris(referencesResult, toSourcegraphTextDocumentUri)
            return convertLocations(referencesResult)
        },
    })

    // Implementations
    sourcegraph.languages.registerImplementationProvider([{ pattern: '**/*.*' }], {
        provideImplementation: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                return undefined
            }
            const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
            const connection = await getOrCreateConnection(serverRootUri)
            const implementationParams: TextDocumentPositionParams = {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            }
            const implementationResult = await connection.sendRequest(ImplementationRequest.type, implementationParams)
            rewriteUris(implementationResult, toSourcegraphTextDocumentUri)
            return convertLocations(implementationResult)
        },
    })
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
