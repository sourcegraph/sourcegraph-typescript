import '@babel/polyfill'

// Polyfill
import { URL as _URL, URLSearchParams as _URLSearchParams } from 'whatwg-url'
// @ts-ignore
Object.assign(_URL, self.URL)
Object.assign(self, { URL: _URL, URLSearchParams: _URLSearchParams })

import { asyncFirst, Handler, initLSIF, wrapMaybe } from '@sourcegraph/basic-code-intel'
import { Tracer as LightstepTracer } from '@sourcegraph/lightstep-tracer-webworker'
import {
    createMessageConnection,
    MessageConnection,
    toSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import delayPromise from 'delay'
import { merge } from 'ix/asynciterable/index'
import { filter, map, scan, tap } from 'ix/asynciterable/pipe/index'
import { fromPairs, isEqual, uniqWith } from 'lodash'
import { Span, Tracer } from 'opentracing'
import * as path from 'path'
import { BehaviorSubject, from, fromEventPattern, Subscription } from 'rxjs'
import * as rxop from 'rxjs/operators'
import * as sourcegraph from 'sourcegraph'
import { Omit } from 'type-zoo'
import {
    CancellationToken,
    CancellationTokenSource,
    ClientCapabilities,
    CodeActionKind,
    CodeActionParams,
    CodeActionRequest,
    DefinitionRequest,
    Diagnostic,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    HoverRequest,
    ImplementationRequest,
    InitializeParams,
    InitializeRequest,
    Location,
    LogMessageNotification,
    PublishDiagnosticsNotification,
    ReferenceParams,
    ReferencesRequest,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { getOrCreateAccessToken } from './auth'
import { LangTypescriptConfiguration } from './config'
import {
    findPackageDependentsWithNpm,
    findPackageDependentsWithSourcegraphExtensionRegistry as findDependentsWithSourcegraphExtensionRegistry,
    findPackageDependentsWithSourcegraphSearch,
    findPackageName,
} from './dependencies'
import { resolveRev } from './graphql'
import { Logger, LSP_TO_LOG_LEVEL, redact, RedactingLogger } from './logging'
import {
    convertDiagnosticToDecoration,
    convertHover,
    convertLocation,
    convertLocations,
    convertRange,
} from './lsp-conversion'
import {
    ProgressParams,
    WindowProgressClientCapabilities,
    WindowProgressNotification,
} from './protocol.progress.proposed'
import { canGenerateTraceUrl, logErrorEvent, sendTracedRequest, traceAsyncGenerator, tracePromise } from './tracing'
import {
    parseSourcegraphRawUrl,
    resolveServerRootUri,
    rewriteUris,
    toServerTextDocumentUri,
    toSourcegraphTextDocumentUri,
} from './uris'
import {
    abortPrevious,
    areProviderParamsEqual,
    asArray,
    distinctUntilChanged,
    flatMapConcurrent,
    observableFromAsyncIterable,
    SourcegraphEndpoint,
    throwIfAbortError,
} from './util'
import { mkIsLSIFAvailable } from '@sourcegraph/basic-code-intel/lib/lsif'

const HOVER_DEF_POLL_INTERVAL = 2000
const EXTERNAL_REFS_CONCURRENCY = 7

const getConfig = () =>
    sourcegraph.configuration.get().value as LangTypescriptConfiguration & { 'codeIntel.lsif': boolean }

type NonDisposableMessageConnection = Omit<MessageConnection, 'dispose'>

const connectionsByRootUri = new Map<string, Promise<NonDisposableMessageConnection>>()

const isTypeScriptFile = (textDocumentUri: URL): boolean => /\.m?(?:t|j)sx?$/.test(textDocumentUri.hash)

const documentSelector: sourcegraph.DocumentSelector = [{ language: 'typescript' }, { language: 'javascript' }]

const logger: Logger = new RedactingLogger(console)

interface Providers {
    hover: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) => Promise<sourcegraph.Hover | null>
    definition: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) => Promise<sourcegraph.Definition | null>
    references: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) => Promise<sourcegraph.Location[] | null>
}

function initBasicCodeIntel(): Providers {
    const handler = new Handler({
        sourcegraph,
        languageID: 'typescript',
        fileExts: ['ts', 'tsx', 'js', 'jsx'],
        commentStyle: {
            lineRegex: /\/\/\s?/,
            block: {
                startRegex: /\/\*\*?/,
                lineNoiseRegex: /(^\s*\*\s?)?/,
                endRegex: /\*\//,
            },
        },
        filterDefinitions: ({ filePath, fileContent, results }) => {
            const imports = fileContent
                .split('\n')
                .map(line => {
                    // Matches the import at index 1
                    const match = /\bfrom ['"](.*)['"];?$/.exec(line) || /\brequire\(['"](.*)['"]\)/.exec(line)
                    return match ? match[1] : undefined
                })
                .filter((x): x is string => Boolean(x))

            const filteredResults = results.filter(result =>
                imports.some(i => path.join(path.dirname(filePath), i) === result.file.replace(/\.[^/.]+$/, ''))
            )

            return filteredResults.length === 0 ? results : filteredResults
        },
    })

    return {
        hover: handler.hover.bind(handler),
        definition: handler.definition.bind(handler),
        references: handler.references.bind(handler),
    }
}

export async function activate(ctx: sourcegraph.ExtensionContext): Promise<void> {
    logger.log('TypeScript extension activated')

    // Cancel everything whene extension is deactivated
    const cancellationTokenSource = new CancellationTokenSource()
    ctx.subscriptions.add(() => cancellationTokenSource.cancel())
    const token = cancellationTokenSource.token

    const config = new BehaviorSubject(getConfig())
    ctx.subscriptions.add(sourcegraph.configuration.subscribe(() => config.next(getConfig())))

    const isLSIFAvailable = mkIsLSIFAvailable()
    const lsif = initLSIF()
    const basicCodeIntel = initBasicCodeIntel()

    const tracer: Tracer = config.value['lightstep.token']
        ? new LightstepTracer({ access_token: config.value['lightstep.token'], component_name: 'ext-lang-typescript' })
        : new Tracer()

    const accessToken = await getOrCreateAccessToken()
    /** The Sourcegraph endpoint contactable by the server */
    const serverSgEndpoint: SourcegraphEndpoint = {
        url: new URL(config.value['typescript.sourcegraphUrl'] || sourcegraph.internal.sourcegraphURL.toString()),
        accessToken,
    }
    /** The Sourcegraph endpoint contactable by the extension  */
    const clientSgEndpoint: SourcegraphEndpoint = {
        url: new URL(sourcegraph.internal.sourcegraphURL.toString()),
        accessToken,
    }

    const diagnosticsDecorationType = sourcegraph.app.createDecorationType()
    const codeActionsDecorationType = sourcegraph.app.createDecorationType()

    sourcegraph.commands.registerCommand('typescript.toggle', async () => {
        const config = sourcegraph.configuration.get<LangTypescriptConfiguration>()
        await config.update('typescript.enable', config.value['typescript.enable'] === false)
    })

    const enabled = new BehaviorSubject(config.value['typescript.enable'] !== false)
    ctx.subscriptions.add(
        from(config)
            .pipe(
                rxop.map(config => config['typescript.enable'] !== false),
                rxop.distinctUntilChanged()
            )
            .subscribe(enabled)
    )

    /**
     * @param rootUri The server HTTP root URI
     */
    async function connect({
        rootUri,
        progressSuffix = '',
        span,
        token,
    }: {
        rootUri: URL
        progressSuffix?: string
        span: Span
        token: CancellationToken
    }): Promise<MessageConnection> {
        return await tracePromise('Connect to language server', tracer, span, async span => {
            const subscriptions = new Subscription()
            token.onCancellationRequested(() => subscriptions.unsubscribe())
            if (typeof config.value['typescript.serverUrl'] !== 'string') {
                throw new Error(
                    'Setting typescript.serverUrl must be set to the WebSocket endpoint of the TypeScript language service'
                )
            }
            const serverUrl = new URL(config.value['typescript.serverUrl'])
            serverUrl.search = rootUri.pathname.substr(1) // For easier debugging in network panel
            const socket = new WebSocket(serverUrl.href)
            subscriptions.add(() => socket.close())
            socket.addEventListener('close', event => {
                logger.warn('WebSocket connection to TypeScript backend closed', event)
                subscriptions.unsubscribe()
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
            connection.onDispose(() => subscriptions.unsubscribe())
            subscriptions.add(() => connection.dispose())
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
            // Display diagnostics as decorations
            /** Diagnostic by Sourcegraph text document URI */
            const diagnosticsByUri = new Map<string, Diagnostic[]>()
            subscriptions.add(() => {
                // Clear all diagnostics held by this connection
                for (const appWindow of sourcegraph.app.windows) {
                    for (const viewComponent of appWindow.visibleViewComponents) {
                        if (diagnosticsByUri.has(viewComponent.document.uri)) {
                            viewComponent.setDecorations(diagnosticsDecorationType, [])
                        }
                    }
                }
            })
            connection.onNotification(PublishDiagnosticsNotification.type, async params => {
                const uri = new URL(params.uri)
                const sourcegraphTextDocumentUri = toSourcegraphTextDocumentUri(uri)
                diagnosticsByUri.set(sourcegraphTextDocumentUri.href, params.diagnostics)
                // Mark quick fixes with a light bulb
                const codeActionDecorations: sourcegraph.TextDocumentDecoration[] = []
                for (const diagnostic of params.diagnostics) {
                    const codeActionParams: CodeActionParams = {
                        textDocument: {
                            uri: uri.href,
                        },
                        range: diagnostic.range,
                        context: {
                            diagnostics: [diagnostic],
                            only: [CodeActionKind.QuickFix],
                        },
                    }
                    try {
                        const codeActions = await connection.sendRequest(CodeActionRequest.type, codeActionParams)
                        codeActionDecorations.push(
                            ...asArray(codeActions).map(
                                (codeAction): sourcegraph.TextDocumentDecoration => ({
                                    range: convertRange(diagnostic.range),
                                    after: {
                                        contentText: '💡',
                                        hoverMessage: codeAction.title,
                                    },
                                })
                            )
                        )
                    } catch (err) {
                        logger.error('Error getting code actions', err)
                    }
                }
                for (const appWindow of sourcegraph.app.windows) {
                    for (const viewComponent of appWindow.visibleViewComponents) {
                        if (viewComponent.document.uri === sourcegraphTextDocumentUri.href) {
                            viewComponent.setDecorations(
                                codeActionsDecorationType,
                                uniqWith(codeActionDecorations, isEqual)
                            )
                            viewComponent.setDecorations(
                                diagnosticsDecorationType,
                                params.diagnostics.map(convertDiagnosticToDecoration)
                            )
                        }
                    }
                }
            })
            subscriptions.add(
                sourcegraph.workspace.onDidOpenTextDocument.subscribe(() => {
                    for (const appWindow of sourcegraph.app.windows) {
                        for (const viewComponent of appWindow.visibleViewComponents) {
                            const diagnostics = diagnosticsByUri.get(viewComponent.document.uri) || []
                            viewComponent.setDecorations(
                                diagnosticsDecorationType,
                                diagnostics.map(convertDiagnosticToDecoration)
                            )
                        }
                    }
                })
            )
            // Show progress reports
            const progressReporters = new Map<string, Promise<sourcegraph.ProgressReporter>>()
            const completeReporters = () => {
                // Cleanup unfinished progress reports
                for (const reporterPromise of progressReporters.values()) {
                    // tslint:disable-next-line:no-floating-promises
                    reporterPromise.then(reporter => {
                        reporter.complete()
                    })
                }
                progressReporters.clear()
            }
            subscriptions.add(completeReporters)
            subscriptions.add(enabled.pipe(rxop.filter(isEnabled => !isEnabled)).subscribe(completeReporters))
            if (config.value['typescript.progress'] !== false) {
                subscriptions.add(
                    fromEventPattern<ProgressParams>(handler =>
                        connection.onNotification(WindowProgressNotification.type, (p: ProgressParams) => handler(p))
                    )
                        .pipe(
                            rxop.withLatestFrom(enabled),
                            rxop.switchMap(async ([{ id, title, message, percentage, done }, isEnabled]) => {
                                try {
                                    if (!sourcegraph.app.activeWindow || !sourcegraph.app.activeWindow.showProgress) {
                                        return
                                    }
                                    let reporterPromise = progressReporters.get(id)
                                    if (!reporterPromise) {
                                        // If the extension is not in active use (i.e. at least one token was hovered on this file),
                                        // don't annoy the user with (new) progress indicators
                                        // (do continue to update old ones though)
                                        if (!isEnabled) {
                                            return
                                        }
                                        if (title) {
                                            title = title + progressSuffix
                                        }
                                        reporterPromise = sourcegraph.app.activeWindow.showProgress({ title })
                                        progressReporters.set(id, reporterPromise)
                                    }
                                    const reporter = await reporterPromise
                                    reporter.next({ percentage, message })
                                    if (done) {
                                        reporter.complete()
                                        progressReporters.delete(id)
                                    }
                                } catch (err) {
                                    logger.error('Error handling progress notification', err)
                                }
                            })
                        )
                        .subscribe()
                )
            }
            connection.listen()
            const event = await new Promise<Event>(resolve => {
                socket.addEventListener('open', resolve, { once: true })
                socket.addEventListener('error', resolve, { once: true })
            })
            if (event.type === 'error') {
                throw new Error(`The WebSocket to the TypeScript backend at ${serverUrl} could not not be opened`)
            }
            logger.log(`WebSocket connection to TypeScript backend at ${serverUrl} opened`)
            const clientCapabilities: ClientCapabilities & WindowProgressClientCapabilities = {
                experimental: {
                    progress: true,
                },
            }
            const initializeParams: InitializeParams = {
                processId: 0,
                rootUri: rootUri.href,
                workspaceFolders: [{ name: '', uri: rootUri.href }],
                capabilities: clientCapabilities,
                initializationOptions: {
                    // until workspace/configuration is allowed during initialize
                    configuration: {
                        // The server needs to use the API to resolve repositories
                        'typescript.sourcegraphUrl': serverSgEndpoint.url.href,
                        ...fromPairs(
                            Object.entries(sourcegraph.configuration.get().value).filter(([key]) =>
                                key.startsWith('typescript.')
                            )
                        ),
                    },
                },
            }
            logger.log('Initializing TypeScript backend...')
            await sendTracedRequest(connection, InitializeRequest.type, initializeParams, {
                span,
                tracer,
                token,
            })
            logger.log('TypeScript backend initialized')
            // Tell language server about all currently open text documents under this root
            for (const textDocument of sourcegraph.workspace.textDocuments) {
                if (!isTypeScriptFile(new URL(textDocument.uri))) {
                    continue
                }
                const serverTextDocumentUri = toServerTextDocumentUri(new URL(textDocument.uri), serverSgEndpoint)
                if (!serverTextDocumentUri.href.startsWith(rootUri.href)) {
                    continue
                }
                const didOpenParams: DidOpenTextDocumentParams = {
                    textDocument: {
                        uri: serverTextDocumentUri.href,
                        languageId: textDocument.languageId,
                        text: textDocument.text || '',
                        version: 1,
                    },
                }
                connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
            }
            return connection
        })
    }

    /**
     * @param rootUri The server HTTP root URI
     */
    async function getOrCreateConnection(
        rootUri: URL,
        { span, token }: { span: Span; token: CancellationToken }
    ): Promise<NonDisposableMessageConnection> {
        return await tracePromise('Get or create connection', tracer, span, async span => {
            const connectionPromise = connectionsByRootUri.get(rootUri.href)
            if (connectionPromise) {
                return await connectionPromise
            }
            const newConnectionPromise = connect({ rootUri, span, token })
            // Cache connection until the extension deactivates
            connectionsByRootUri.set(rootUri.href, newConnectionPromise)
            const connection = await newConnectionPromise
            // When connection gets disposed/closed, delete it from the Map
            connection.onDispose(() => connectionsByRootUri.delete(rootUri.href))
            // Only dispose the connection when extension gets deactivated
            ctx.subscriptions.add(() => connection.dispose())
            return connection
        })
    }

    /**
     * Gets or creates a temporary connection that is not persisted, and passes it to the given function.
     * The connection is closed again after the function finished.
     * The function is not allowed to dispose the connection itself.
     *
     * @param rootUri The server HTTP root URI
     */
    async function withTempConnection<R>(
        rootUri: URL,
        { span, token }: { span: Span; token: CancellationToken },
        fn: (connection: NonDisposableMessageConnection) => Promise<R>
    ): Promise<R> {
        const connection = await connectionsByRootUri.get(rootUri.href)
        if (connection) {
            return await fn(connection)
        }
        const { repoName } = parseSourcegraphRawUrl(rootUri)
        const tempConnection = await connect({
            rootUri,
            progressSuffix: ` for [${repoName}](${rootUri.href.replace(/\/-\/raw\/?$/, '')})`,
            span,
            token,
        })
        try {
            return await fn(tempConnection)
        } finally {
            tempConnection.dispose()
        }
    }

    // Forward didOpen notifications
    ctx.subscriptions.add(
        sourcegraph.workspace.onDidOpenTextDocument.subscribe(async textDocument => {
            try {
                await tracePromise('Handle didOpenTextDocument', tracer, undefined, async span => {
                    if (canGenerateTraceUrl(span)) {
                        logger.log('didOpen trace', span.generateTraceURL())
                    }
                    const textDocumentUri = new URL(textDocument.uri)
                    if (!isTypeScriptFile(textDocumentUri)) {
                        return
                    }

                    // This dummy arg will not be necessary once
                    // https://github.com/sourcegraph/sourcegraph-basic-code-intel/pull/132
                    // is merged.
                    const dummyPosition = new sourcegraph.Position(0, 0)
                    if (!(await isLSIFAvailable(textDocument, dummyPosition)) && config.value['typescript.serverUrl']) {
                        const serverRootUri = resolveServerRootUri(textDocumentUri, serverSgEndpoint)
                        const serverTextDocumentUri = toServerTextDocumentUri(textDocumentUri, serverSgEndpoint)
                        const connection = await getOrCreateConnection(serverRootUri, { token, span })
                        const didOpenParams: DidOpenTextDocumentParams = {
                            textDocument: {
                                uri: serverTextDocumentUri.href,
                                languageId: textDocument.languageId,
                                text: textDocument.text || '',
                                version: 1,
                            },
                        }
                        connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
                    }
                })
            } catch (err) {
                logger.error('Error handling didOpenTextDocument event', err)
            }
        })
    )

    let providers = new Subscription()

    ctx.subscriptions.add(
        enabled.subscribe(isEnabled => {
            if (isEnabled) {
                logger.log('TypeScript support enabled')
                registerProviders()
            } else {
                logger.log('TypeScript support disabled')
                providers.unsubscribe()
            }
        })
    )

    function registerProviders() {
        providers = new Subscription()
        ctx.subscriptions.add(providers)
        // Hover
        const provideHover = abortPrevious((textDocument: sourcegraph.TextDocument, position: sourcegraph.Position) =>
            traceAsyncGenerator('Provide hover', tracer, undefined, async function*(span) {
                if (canGenerateTraceUrl(span)) {
                    logger.log('Hover trace', span.generateTraceURL())
                }

                if (await isLSIFAvailable(textDocument, position)) {
                    const lsifResult = await lsif.hover(textDocument, position)
                    yield lsifResult && lsifResult.value
                } else if (!config.value['typescript.serverUrl']) {
                    yield await basicCodeIntel.hover(textDocument, position)
                } else {
                    const textDocumentUri = new URL(textDocument.uri)
                    const serverRootUri = resolveServerRootUri(textDocumentUri, serverSgEndpoint)
                    const serverTextDocumentUri = toServerTextDocumentUri(textDocumentUri, serverSgEndpoint)

                    const connection = await getOrCreateConnection(serverRootUri, { span, token })
                    // Poll server to get updated results when e.g. dependency installation finished
                    while (true) {
                        const hoverResult = await sendTracedRequest(
                            connection,
                            HoverRequest.type,
                            {
                                textDocument: { uri: serverTextDocumentUri.href },
                                position,
                            },
                            { span, tracer, token }
                        )
                        rewriteUris(hoverResult, toSourcegraphTextDocumentUri)
                        yield convertHover(hoverResult)
                        await delayPromise(HOVER_DEF_POLL_INTERVAL)
                    }
                }
            })
        )
        providers.add(
            sourcegraph.languages.registerHoverProvider(documentSelector, {
                provideHover: distinctUntilChanged(areProviderParamsEqual, (textDocument, position) =>
                    observableFromAsyncIterable(provideHover(textDocument, position))
                ),
            })
        )

        // Definition
        const provideDefinition = abortPrevious(
            (textDocument: sourcegraph.TextDocument, position: sourcegraph.Position) =>
                traceAsyncGenerator('Provide definition', tracer, undefined, async function*(span) {
                    if (canGenerateTraceUrl(span)) {
                        logger.log('Definition trace', span.generateTraceURL())
                    }

                    if (await isLSIFAvailable(textDocument, position)) {
                        const lsifResult = await lsif.definition(textDocument, position)
                        yield lsifResult ? lsifResult.value : null
                    } else if (!config.value['typescript.serverUrl']) {
                        yield await basicCodeIntel.definition(textDocument, position)
                    } else {
                        const textDocumentUri = new URL(textDocument.uri)
                        const serverRootUri = resolveServerRootUri(textDocumentUri, serverSgEndpoint)
                        const serverTextDocumentUri = toServerTextDocumentUri(textDocumentUri, serverSgEndpoint)
                        const connection = await getOrCreateConnection(serverRootUri, { span, token })
                        // Poll server to get updated contents when e.g. dependency installation finished
                        while (true) {
                            const definitionResult = (await sendTracedRequest(
                                connection,
                                DefinitionRequest.type,
                                {
                                    textDocument: { uri: serverTextDocumentUri.href },
                                    position,
                                },
                                { span, tracer, token }
                            )) as Location[] | Location | null
                            rewriteUris(definitionResult, toSourcegraphTextDocumentUri)
                            yield convertLocations(definitionResult)
                            await delayPromise(HOVER_DEF_POLL_INTERVAL)
                        }
                    }
                })
        )
        providers.add(
            sourcegraph.languages.registerDefinitionProvider(documentSelector, {
                provideDefinition: distinctUntilChanged(areProviderParamsEqual, (textDocument, position) =>
                    observableFromAsyncIterable(provideDefinition(textDocument, position))
                ),
            })
        )

        // References
        const provideReferences = (
            textDocument: sourcegraph.TextDocument,
            position: sourcegraph.Position,
            context: sourcegraph.ReferenceContext
        ): AsyncIterable<sourcegraph.Location[]> =>
            traceAsyncGenerator('Provide references', tracer, undefined, async function*(span) {
                if (canGenerateTraceUrl(span)) {
                    logger.log('References trace', span.generateTraceURL())
                }

                if (await isLSIFAvailable(textDocument, position)) {
                    const lsifResult = await lsif.references(textDocument, position)
                    yield (lsifResult && lsifResult.value) || []
                } else if (!config.value['typescript.serverUrl']) {
                    yield (await basicCodeIntel.references(textDocument, position)) || []
                } else {
                    const textDocumentUri = new URL(textDocument.uri)
                    const serverRootUri = resolveServerRootUri(textDocumentUri, serverSgEndpoint)
                    const serverTextDocumentUri = toServerTextDocumentUri(textDocumentUri, serverSgEndpoint)

                    const connection = await getOrCreateConnection(serverRootUri, { span, token })

                    const findLocalReferences = () =>
                        traceAsyncGenerator('Find local references', tracer, span, async function*(span) {
                            logger.log('Searching for same-repo references')
                            const localReferences = asArray(
                                await sendTracedRequest(
                                    connection,
                                    ReferencesRequest.type,
                                    {
                                        textDocument: { uri: serverTextDocumentUri.href },
                                        position,
                                        context,
                                    },
                                    { span, tracer, token }
                                )
                            )
                            logger.log(`Found ${localReferences.length} same-repo references`)
                            yield localReferences
                        })

                    const findExternalReferences = () =>
                        traceAsyncGenerator('Find external references', tracer, span, async function*(span) {
                            try {
                                logger.log('Getting canonical definition for cross-repo references')
                                const definition: Location | undefined = asArray((await sendTracedRequest(
                                    connection,
                                    DefinitionRequest.type,
                                    {
                                        textDocument: { uri: serverTextDocumentUri.href },
                                        position,
                                    },
                                    { span, tracer, token }
                                )) as Location[] | Location | null)[0]
                                if (!definition) {
                                    return
                                }
                                span.setTag('uri', redact(definition.uri))
                                span.setTag('line', definition.range.start.line)

                                const findPackageDependents =
                                    clientSgEndpoint.url.hostname === 'sourcegraph.com'
                                        ? findPackageDependentsWithNpm
                                        : findPackageDependentsWithSourcegraphSearch

                                logger.log(`Getting external references for definition`, definition)

                                const definitionUri = new URL(definition.uri)

                                const referenceParams: ReferenceParams = {
                                    textDocument: { uri: definitionUri.href },
                                    position: definition.range.start,
                                    context: { includeDeclaration: false },
                                }

                                // The definition returned by the server points to the server endpoint, rewrite to the client endpoint
                                const clientDefinitionUrl = new URL(definitionUri.href)
                                clientDefinitionUrl.protocol = clientSgEndpoint.url.protocol
                                clientDefinitionUrl.host = clientSgEndpoint.url.host
                                const packageName = await findPackageName(clientDefinitionUrl, { logger, tracer, span })

                                // Find dependent packages on the package
                                const dependents =
                                    packageName === 'sourcegraph'
                                        ? // If the package name is "sourcegraph", we are looking for references to a symbol in the Sourcegraph extension API
                                          // Extensions are not published to npm, so search the extension registry
                                          findDependentsWithSourcegraphExtensionRegistry(clientSgEndpoint, {
                                              logger,
                                              tracer,
                                              span,
                                          })
                                        : findPackageDependents(packageName, clientSgEndpoint, { logger, tracer, span })

                                // Search for references in each dependent
                                const findExternalRefsInDependent = (repoName: string) =>
                                    traceAsyncGenerator(
                                        'Find external references in dependent',
                                        tracer,
                                        span,
                                        async function*(span) {
                                            try {
                                                logger.log(
                                                    `Looking for external references in dependent repo ${repoName}`
                                                )
                                                span.setTag('repoName', repoName)
                                                const commitID = await resolveRev(repoName, 'HEAD', clientSgEndpoint, {
                                                    span,
                                                    tracer,
                                                })
                                                const rootUri = new URL(
                                                    `${repoName}@${commitID}/-/raw/`,
                                                    serverSgEndpoint.url
                                                )
                                                if (serverSgEndpoint.accessToken) {
                                                    rootUri.username = serverSgEndpoint.accessToken
                                                }

                                                yield await withTempConnection(
                                                    rootUri,
                                                    { span, token },
                                                    async connection => {
                                                        const references = asArray(
                                                            await sendTracedRequest(
                                                                connection,
                                                                ReferencesRequest.type,
                                                                referenceParams,
                                                                {
                                                                    span,
                                                                    tracer,
                                                                    token,
                                                                }
                                                            )
                                                        )
                                                        logger.log(
                                                            `Found ${
                                                                references.length
                                                            } references in dependent repo ${repoName}`
                                                        )
                                                        // Only include references in the external repo, do not duplicate references in the same repo
                                                        return references.filter(location =>
                                                            location.uri.startsWith(rootUri.href)
                                                        )
                                                    }
                                                )
                                            } catch (err) {
                                                throwIfAbortError(err)
                                                logErrorEvent(span, err)
                                                logger.error(
                                                    `Error searching dependent repo ${repoName} for references`,
                                                    err
                                                )
                                            }
                                        }
                                    )
                                yield* flatMapConcurrent(
                                    dependents,
                                    EXTERNAL_REFS_CONCURRENCY,
                                    findExternalRefsInDependent
                                )
                                logger.log('Done going through dependents')
                            } catch (err) {
                                logger.error('Could not find external references', err)
                            }
                        })

                    yield* merge(findLocalReferences(), findExternalReferences()).pipe(
                        // Same-repo references
                        // Cross-repo references
                        // Find canonical source location
                        filter(chunk => chunk.length > 0),
                        tap({
                            next: chunk => {
                                span.log({ event: 'chunk', count: chunk.length })
                            },
                        }),
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
                        scan<sourcegraph.Location[], sourcegraph.Location[]>(
                            (allReferences, chunk) => allReferences.concat(chunk),
                            []
                        )
                    )
                }
            })
        providers.add(
            sourcegraph.languages.registerReferenceProvider(documentSelector, {
                provideReferences: (doc, pos, ctx) => observableFromAsyncIterable(provideReferences(doc, pos, ctx)),
            })
        )

        if (config.value['typescript.serverUrl']) {
            // Implementations
            const IMPL_ID = 'ts.impl' // implementations panel and provider ID
            const provideImpls = (
                textDocument: sourcegraph.TextDocument,
                position: sourcegraph.Position
            ): Promise<sourcegraph.Location[] | null> =>
                tracePromise('Provide implementations', tracer, undefined, async span => {
                    if (canGenerateTraceUrl(span)) {
                        logger.log('Implementation trace', span.generateTraceURL())
                    }

                    if (await isLSIFAvailable(textDocument, position)) {
                        return null
                    }

                    const textDocumentUri = new URL(textDocument.uri)
                    const serverRootUri = resolveServerRootUri(textDocumentUri, serverSgEndpoint)
                    const serverTextDocumentUri = toServerTextDocumentUri(textDocumentUri, serverSgEndpoint)
                    const connection = await getOrCreateConnection(serverRootUri, { span, token })
                    const implementationParams: TextDocumentPositionParams = {
                        textDocument: { uri: serverTextDocumentUri.href },
                        position,
                    }
                    const implementationResult = (await sendTracedRequest(
                        connection,
                        ImplementationRequest.type,
                        implementationParams,
                        { span, tracer, token }
                    )) as Location[] | Location | null
                    rewriteUris(implementationResult, toSourcegraphTextDocumentUri)
                    return convertLocations(implementationResult)
                })
            providers.add(
                sourcegraph.languages.registerLocationProvider(IMPL_ID, documentSelector, {
                    provideLocations: provideImpls,
                })
            )
            const panelView = sourcegraph.app.createPanelView(IMPL_ID)
            panelView.title = 'Implementations'
            panelView.component = { locationProvider: IMPL_ID }
            panelView.priority = 160
            providers.add(panelView)
        }
    }
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
