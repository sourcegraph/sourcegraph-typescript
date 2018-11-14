import 'source-map-support/register'

// Polyfill
import { AbortController } from 'abort-controller'
Object.assign(global, { AbortController })

import {
    createMessageConnection,
    IWebSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import * as rpcServer from '@sourcegraph/vscode-ws-jsonrpc/lib/server'
import decompress from 'decompress'
import glob from 'globby'
import * as http from 'http'
import * as https from 'https'
import { Tracer as LightstepTracer } from 'lightstep-tracer'
import { cloneDeep, noop } from 'lodash'
import mkdirp from 'mkdirp-promise'
import * as fs from 'mz/fs'
import { createWriteStream, realpathSync } from 'mz/fs'
import { FORMAT_HTTP_HEADERS, Span, Tracer } from 'opentracing'
import { tmpdir } from 'os'
import * as path from 'path'
import RelateUrl from 'relateurl'
import request from 'request'
import rmfr from 'rmfr'
import { pathToFileURL } from 'url'
import uuid = require('uuid')
import {
    CancellationToken,
    Definition,
    DefinitionRequest,
    DidOpenTextDocumentNotification,
    HoverRequest,
    ImplementationRequest,
    InitializeRequest,
    ReferencesRequest,
    TextDocumentPositionParams,
    TypeDefinitionRequest,
} from 'vscode-languageserver-protocol'
import { Server } from 'ws'
import { createAbortError, throwIfCancelled } from './cancellation'
import { filterDependencies } from './dependencies'
import { createDispatcher, NotificationType, RequestType } from './dispatcher'
import { AsyncDisposable, Disposable, disposeAll, disposeAllAsync } from './disposable'
import { Logger, LSPLogger } from './logging'
import { tracePromise } from './tracing'
import { sanitizeTsConfigs } from './tsconfig'
import { install } from './yarn'
import * as prometheus from 'prom-client'

const RELATE_URL_OPTIONS: RelateUrl.Options = {
    output: RelateUrl.PATH_RELATIVE,
    removeRootTrailingSlash: false,
    defaultPorts: {},
}

const CACHE_DIR = process.env.CACHE_DIR || realpathSync(tmpdir())
console.log(`Using CACHE_DIR ${CACHE_DIR}`)

/**
 * Rewrites all `uri` properties in an object, recursively
 */
function rewriteUris(obj: any, transform: (uri: URL) => URL): void {
    // Scalar
    if (typeof obj !== 'object' || obj === null) {
        return
    }
    // Array
    if (Array.isArray(obj)) {
        for (const element of obj) {
            rewriteUris(element, transform)
        }
        return
    }
    // Object
    if ('uri' in obj) {
        obj.uri = transform(new URL(obj.uri)).href
    }
    for (const key of Object.keys(obj)) {
        rewriteUris(obj[key], transform)
    }
}

let tracer = new Tracer()
if (process.env.LIGHTSTEP_ACCESS_TOKEN) {
    console.log('LightStep tracing enabled')
    tracer = new LightstepTracer({
        access_token: process.env.LIGHTSTEP_ACCESS_TOKEN,
        component_name: 'lang-typescript',
    })
}

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080

let httpServer: http.Server | https.Server
if (process.env.TLS_CERT && process.env.TLS_KEY) {
    console.log('TLS encryption enabled')
    httpServer = https.createServer({
        cert: process.env.TLS_CERT,
        key: process.env.TLS_KEY,
    })
} else {
    httpServer = http.createServer()
}

/** Disposables to be disposed when the whole server is shutting down */
const globalDisposables = new Set<Disposable | AsyncDisposable>()

// Cleanup when receiving signals
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
    process.once(signal, async () => {
        console.log(`Received ${signal}, cleaning up`)
        await disposeAllAsync(globalDisposables)
        process.exit(0)
    })
}

const webSocketServer = new Server({ server: httpServer })

const openConnectionsMetric = new prometheus.Gauge({
    name: 'typescript_open_websocket_connections',
    help: 'Open WebSocket connections to the TypeScript server',
})
let openConnections = 0
prometheus.collectDefaultMetrics()

webSocketServer.on('connection', async connection => {
    openConnectionsMetric.inc()
    openConnections++
    console.log(`New WebSocket connection, ${openConnections} open`)

    /** Functions to run when this connection is closed (or the server shuts down) */
    const connectionDisposables = new Set<AsyncDisposable | Disposable>()
    {
        const connectionDisposable: AsyncDisposable = {
            disposeAsync: async () => await disposeAllAsync([...connectionDisposables].reverse()),
        }
        globalDisposables.add(connectionDisposable)
        connectionDisposables.add({ dispose: () => globalDisposables.delete(connectionDisposable) })
        const closeListener = async () => {
            openConnections--
            openConnectionsMetric.dec()
            console.log(`WebSocket closed, ${openConnections} open`)
            await connectionDisposable.disposeAsync()
        }
        connection.on('close', closeListener)
        connectionDisposables.add({ dispose: () => connection.removeEventListener('close', closeListener) })
    }

    const webSocket: IWebSocket = {
        onMessage: handler => connection.on('message', handler),
        onClose: handler => connection.on('close', handler),
        onError: handler => connection.on('error', handler),
        send: content => connection.send(content),
        dispose: () => connection.close(),
    }
    connectionDisposables.add(webSocket)
    const webSocketReader = new WebSocketMessageReader(webSocket)
    connectionDisposables.add(webSocketReader)
    const webSocketWriter = new WebSocketMessageWriter(webSocket)
    connectionDisposables.add(webSocketWriter)
    const webSocketConnection = rpcServer.createConnection(webSocketReader, webSocketWriter, noop)
    const webSocketMessageConnection = createMessageConnection(
        webSocketConnection.reader,
        webSocketConnection.writer,
        console
    )
    /** The logger for this connection, loggin to the user's browser console */
    const logger: Logger = new LSPLogger(webSocketMessageConnection)

    const languageServerConnection = rpcServer.createServerProcess('TypeScript language', process.execPath, [
        path.resolve(__dirname, '..', '..', 'node_modules', 'typescript-language-server', 'lib', 'cli.js'),
        '--stdio',
        // Use local tsserver instead of the tsserver of the repo for security reasons
        '--tsserver-path=' + path.join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsserver'),
        // '--tsserver-log-file',
        // path.resolve(__dirname, '..', '..', 'tsserver.log'),
        // '--tsserver-log-verbosity',
        // 'verbose',
        // '--log-level=4',
    ])
    connectionDisposables.add(languageServerConnection)

    // Connection state set on initialize
    let httpRootUri: URL
    let fileRootUri: URL
    let tempDir: string
    let extractPath: string
    // yarn folders
    let globalFolderRoot: string
    let cacheFolderRoot: string
    /** Map from URI for directory of package.json to Promise for its installation */
    const dependencyInstallationPromises = new Map<string, Promise<void>>()
    /** Whether all dependency installation is done */
    let dependencyInstallationDone = false

    const serverMessageConnection = createMessageConnection(
        languageServerConnection.reader,
        languageServerConnection.writer,
        logger
    )
    connectionDisposables.add(serverMessageConnection)
    serverMessageConnection.listen()

    const dispatcher = createDispatcher(webSocketConnection, { tracer, logger })
    connectionDisposables.add({ dispose: () => dispatcher.dispose() })

    /**
     * @param httpUri Example: `https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/src/schema/graphqlschema.ts`
     */
    const transformHttpToFileUri = (httpUri: URL): URL => {
        const relative = RelateUrl.relate(httpRootUri.href, httpUri.href, RELATE_URL_OPTIONS)
        const fileUri = new URL(relative, fileRootUri.href)
        // Security check to prevent access from one connection into
        // other files on the container or other connection's directories
        if (!fileUri.href.startsWith(fileRootUri.href)) {
            throw new Error(`URI ${httpUri} is not under rootUri ${httpRootUri}`)
        }
        return fileUri
    }
    const transformFileToHttpUri = (fileUri: URL): URL => {
        const relative = RelateUrl.relate(fileRootUri.href, fileUri.href, RELATE_URL_OPTIONS)
        const httpUri = new URL(relative, httpRootUri.href)
        if (!httpUri.href.startsWith(httpRootUri.href)) {
            // Should never happen, since these are outgoing URIs
            // This check may need to be removed in the future for xrepo codeintel
            // For now, it's a sanity check against bugs (e.g. not realpath()ing the temp dir)
            throw new Error(`URI ${httpUri} is not under rootUri ${httpRootUri}`)
        }
        return httpUri
    }

    dispatcher.setRequestHandler(InitializeRequest.type, async (params, token, span) => {
        if (!params.rootUri) {
            throw new Error('No rootUri given as initialize parameter')
        }
        if (params.workspaceFolders && params.workspaceFolders.length > 1) {
            throw new Error(
                'More than one workspace folder given. The TypeScript server only supports a single workspace folder.'
            )
        }
        httpRootUri = new URL(params.rootUri)
        span.setTag('rootUri', httpRootUri.href)
        if (httpRootUri.protocol !== 'http:' && httpRootUri.protocol !== 'https:') {
            throw new Error('rootUri protocol must be http or https, got ' + httpRootUri)
        }
        // Create temp folders
        tempDir = path.join(CACHE_DIR, uuid.v1())
        await mkdirp(tempDir)
        connectionDisposables.add({
            disposeAsync: async () => {
                console.log('Deleting temp dir ', tempDir)
                await rmfr(tempDir)
            },
        })
        extractPath = path.join(tempDir, 'repo')
        cacheFolderRoot = path.join(tempDir, 'cache')
        globalFolderRoot = path.join(tempDir, 'global')
        await Promise.all([fs.mkdir(extractPath), fs.mkdir(cacheFolderRoot), fs.mkdir(globalFolderRoot)])

        // Fetch zip and extract into temp folder
        logger.log('Fetching zip from', httpRootUri.href)
        const archivePath = path.join(tempDir, 'archive.zip')
        await tracePromise('Fetch source archive', span, async span => {
            const using: Disposable[] = []
            try {
                span.setTag('url', httpRootUri.href)
                let bytes = 0
                await new Promise<void>((resolve, reject) => {
                    const headers = {
                        Accept: 'application/zip',
                        'User-Agent': 'TypeScript language server',
                    }
                    span.tracer().inject(span, FORMAT_HTTP_HEADERS, headers)
                    const archiveRequest = request(httpRootUri.href, { headers })
                    using.push(
                        token.onCancellationRequested(() => {
                            archiveRequest.abort()
                            reject(createAbortError())
                        })
                    )
                    archiveRequest
                        .once('error', reject)
                        .once('response', ({ statusCode, statusMessage }) => {
                            if (statusCode >= 400) {
                                archiveRequest.abort()
                                reject(
                                    new Error(
                                        `Archive fetch of ${httpRootUri} failed with ${statusCode} ${statusMessage}`
                                    )
                                )
                            }
                        })
                        .on('data', (chunk: Buffer) => {
                            bytes += chunk.byteLength
                        })
                        .pipe(createWriteStream(archivePath))
                        .once('finish', resolve)
                        .once('error', reject)
                })
                span.setTag('bytes', bytes)
            } finally {
                disposeAll(using, logger)
            }
        })

        // Extract archive
        throwIfCancelled(token)
        logger.log('Extracting archive to ' + extractPath)
        await tracePromise('Extract source archive', span, async span => {
            await decompress(archivePath, extractPath)
        })

        // Find package.jsons to install
        throwIfCancelled(token)
        const packageJsonPaths = await tracePromise('Find package.jsons', span, span =>
            glob('**/package.json', { cwd: extractPath })
        )
        logger.log('package.jsons found:', packageJsonPaths)

        // Sanitize tsconfig.json files
        await sanitizeTsConfigs({ cwd: extractPath, logger, span, token })

        // Install dependencies in the background
        // tslint:disable-next-line no-floating-promises
        tracePromise('Install dependencies', span, async span => {
            await Promise.all(
                packageJsonPaths.map(async relPackageJsonPath => {
                    const installationPromise = tracePromise('Install dependencies for package', span, async span => {
                        try {
                            span.setTag('packageJsonPath', relPackageJsonPath)
                            const absPackageJsonPath = path.join(extractPath, relPackageJsonPath)
                            await filterDependencies(absPackageJsonPath, { logger, span, token })

                            // It's important that each concurrent yarn process has their own global and cache folders
                            const relPackageJsonDirName = path.dirname(relPackageJsonPath)
                            const globalFolder = path.join(globalFolderRoot, relPackageJsonDirName)
                            const cacheFolder = path.join(cacheFolderRoot, relPackageJsonDirName)
                            const cwd = path.join(extractPath, relPackageJsonDirName)

                            await Promise.all([mkdirp(path.join(globalFolder)), mkdirp(path.join(cacheFolder))])

                            await install({ cwd, globalFolder, cacheFolder, logger, span, token })

                            await sanitizeTsConfigs({ cwd: path.join(cwd, 'node_modules'), logger, span, token })
                        } catch (err) {
                            logger.error(`Installation for ${relPackageJsonPath} failed`, err)
                        }
                    })
                    // Save Promise so requests can wait for the installation to finish
                    dependencyInstallationPromises.set(
                        new URL(path.dirname(relPackageJsonPath) + '/', httpRootUri.href).href,
                        installationPromise
                    )
                    await installationPromise
                })
            )
            dependencyInstallationDone = true
        })

        // The trailing slash is important for resolving URL relatively to it
        fileRootUri = pathToFileURL(extractPath + '/')
        // URIs are rewritten by rewriteUris below, but it doesn't touch rootPath
        params = { ...params, rootPath: extractPath }

        return await callServer(InitializeRequest.type, params, token)
    })

    /** Sends a request to the server, rewriting URIs in the parameters and result. */
    async function callServer<P, R>(type: RequestType<P, R>, params: P, token: CancellationToken): Promise<R> {
        throwIfCancelled(token)
        params = cloneDeep(params)
        rewriteUris(params, transformHttpToFileUri)
        const result = await serverMessageConnection.sendRequest(type, params, token)
        rewriteUris(result, transformFileToHttpUri)
        return result
    }

    /**
     * Waits for the installation of all package.jsons in parent directories of the given text document.
     */
    async function waitForDependencies(
        textDocumentUri: URL,
        { span, token }: { span: Span; token: CancellationToken }
    ): Promise<void> {
        throwIfCancelled(token)
        await tracePromise('Wait for dependency installation', span, async span => {
            span.setTag('textDocument', textDocumentUri.href)
            const installations = [...dependencyInstallationPromises].filter(([packageJsonDirUri]) =>
                textDocumentUri.href.startsWith(packageJsonDirUri)
            )
            const packageJsonLocations = installations.map(([uri]) => uri)
            span.setTag('packageJsonLocations', packageJsonLocations)
            logger.log('Waiting for dependency installations of package.json locations:', packageJsonLocations)
            await Promise.all(installations.map(([, promise]) => promise))
        })
    }

    /**
     * Forwards all requests of a certain method to the server, rewriting URIs.
     * It blocks on dependency installation if the function in the second parameter returns true.
     */
    function forwardRequests<P extends TextDocumentPositionParams, R>(
        type: RequestType<P, R>,
        shouldWaitForDependencies: (params: P, result: R) => boolean = () => false
    ): void {
        dispatcher.setRequestHandler(type, async (params, token, span) => {
            const result = await callServer(type, params, token)
            if (shouldWaitForDependencies(params, result)) {
                await waitForDependencies(new URL(params.textDocument.uri), { span, token })
                return await callServer(type, params, token)
            }
            return result
        })
    }

    dispatcher.setRequestHandler(HoverRequest.type, async (params, token, span) => {
        const hover = await callServer(HoverRequest.type, params, token)
        const contents = !hover ? [] : Array.isArray(hover.contents) ? hover.contents : [hover.contents]
        const contentStrings = contents.map(c => (typeof c === 'string' ? c : c.value)).filter(s => !!s.trim())
        // Check if the type is `any` or the import is shown as the declaration
        if (contentStrings.length === 0 || contentStrings.some(s => /\b(any|import)\b/.test(s))) {
            await waitForDependencies(new URL(params.textDocument.uri), { span, token })
            return await callServer(HoverRequest.type, params, token)
        }
        if (!dependencyInstallationDone) {
            contents.push(
                'ℹ️ _Dependency installation is still in progress. The information shown might be missing type information._'
            )
        }
        return { ...hover, contents }
    })

    /** Checks if a location result is not satisfactory and should be retried after dependency installation finished */
    const shouldLocationsWaitForDependencies = (params: TextDocumentPositionParams, locations: Definition) => {
        if (!locations) {
            return true
        }
        const locationsArray = Array.isArray(locations) ? locations : [locations]
        if (locationsArray.length === 0) {
            return true
        }
        // Check if the only definition/reference found is the line that was requested
        if (
            locationsArray.length === 1 &&
            locationsArray[0].uri === params.textDocument.uri &&
            locationsArray[0].range.start.line === params.position.line
        ) {
            return true
        }
        // TODO check if location is at import statement
        return false
    }
    forwardRequests(DefinitionRequest.type, shouldLocationsWaitForDependencies)
    forwardRequests(TypeDefinitionRequest.type, shouldLocationsWaitForDependencies)
    forwardRequests(ReferencesRequest.type, shouldLocationsWaitForDependencies)
    forwardRequests(ImplementationRequest.type, shouldLocationsWaitForDependencies)

    /** Sends a notification to the server, rewriting URIs in the parameters and result. */
    function notifyServer<P, R>(type: NotificationType<P>, params: P): void {
        params = cloneDeep(params)
        rewriteUris(params, transformHttpToFileUri)
        serverMessageConnection.sendNotification(type, params)
    }

    function forwardNotifications<P>(type: NotificationType<P>): void {
        const subscription = dispatcher.observeNotification(type).subscribe(params => notifyServer(type, params))
        connectionDisposables.add({ dispose: () => subscription.unsubscribe() })
    }

    forwardNotifications(DidOpenTextDocumentNotification.type)
})

httpServer.listen(port, () => {
    console.log(`WebSocket server listening on port ${port}`)
})

// Prometheus metrics
const metricsPort = process.env.METRICS_PORT || 6060
const metricsServer = http.createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(prometheus.register.metrics())
})
metricsServer.on('error', err => console.error('Metrics server error', err)) // don't crash on metrics
metricsServer.listen(metricsPort, () => {
    console.log(`Prometheus metrics on port ${metricsPort}`)
})
