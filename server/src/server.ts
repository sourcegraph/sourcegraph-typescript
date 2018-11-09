import 'source-map-support/register'

// Polyfill
import { AbortController } from 'abort-controller'
Object.assign(global, { AbortController })

import {
    createMessageConnection,
    isNotificationMessage,
    isRequestMessage,
    isResponseMessage,
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
import LightstepSpan from 'lightstep-tracer/lib/imp/span_imp'
import { noop } from 'lodash'
import mkdirp from 'mkdirp-promise'
import { createWriteStream } from 'mz/fs'
import * as fs from 'mz/fs'
import { Span, Tracer } from 'opentracing'
import { ERROR } from 'opentracing/lib/ext/tags'
import { tmpdir } from 'os'
import * as path from 'path'
import request from 'request'
import rmfr from 'rmfr'
import stripJsonComments from 'strip-json-comments'
import { pathToFileURL } from 'url'
import relativeUrl from 'url-relative'
import uuid = require('uuid')
import { ErrorCodes, InitializeParams } from 'vscode-languageserver-protocol'
import { Server } from 'ws'
import { createAbortError, isAbortError, onAbort, throwIfAborted } from './abort'
import { filterDependencies } from './dependencies'
import { Logger, LSPLogger } from './logging'
import { logErrorEvent, tracePromise } from './tracing'
import { install } from './yarn'

const CACHE_DIR = process.env.CACHE_DIR || tmpdir()
console.log(`Using CACHE_DIR ${CACHE_DIR}`)

/**
 * Rewrites all `uri` properties in an object, recursively
 */
function rewriteUris(obj: any, transform: (uri: URL) => URL): void {
    if (typeof obj !== 'object' || obj === null) {
        return
    }
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

type CleanupFn = () => void | Promise<void>
async function cleanupAll(cleanupFns: Iterable<CleanupFn>): Promise<void> {
    for (const cleanup of cleanupFns) {
        try {
            await cleanup()
        } catch (err) {
            console.error('Error cleaning up', err)
        }
    }
}

const globalCleanupFns = new Set<CleanupFn>()

// Cleanup when receiving signals
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
    process.once(signal, async () => {
        console.log(`Received ${signal}, cleaning up`)
        await cleanupAll(globalCleanupFns)
        process.exit(0)
    })
}

const webSocketServer = new Server({ server: httpServer })

webSocketServer.on('connection', async connection => {
    console.log('New WebSocket connection')
    const webSocket: IWebSocket = {
        onMessage: handler => connection.on('message', handler),
        onClose: handler => connection.on('close', handler),
        onError: handler => connection.on('error', handler),
        send: content => connection.send(content),
        dispose: () => connection.close(),
    }
    const webSocketReader = new WebSocketMessageReader(webSocket)
    const webSocketWriter = new WebSocketMessageWriter(webSocket)
    const webSocketConnection = rpcServer.createConnection(webSocketReader, webSocketWriter, () => webSocket.dispose())
    const webSocketMessageConnection = createMessageConnection(
        webSocketConnection.reader,
        webSocketConnection.writer,
        console
    )
    /** The logger for this connection, loggin to the user's browser console */
    const logger: Logger = new LSPLogger(webSocketMessageConnection)

    const languageServerConnection = rpcServer.createServerProcess('TypeScript language', 'node', [
        path.resolve(__dirname, '..', '..', 'node_modules', 'typescript-language-server', 'lib', 'cli.js'),
        '--stdio',
        // Use local tsserver instead of the tsserver of the repo for security reasons
        '--tsserver-path=' + path.join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsserver'),
        // '--log-level=4',
    ])

    let httpRootUri: URL
    let fileRootUri: URL
    let tempDir: string
    let extractPath: string
    // yarn folders
    let globalFolderRoot: string
    let cacheFolderRoot: string

    const connectionCleanupFns = new Set<CleanupFn>()
    const cleanupConnection = () => cleanupAll(connectionCleanupFns)
    globalCleanupFns.add(cleanupConnection)
    connectionCleanupFns.add(() => languageServerConnection.dispose())
    connection.on('close', async (code, reason) => {
        console.log('WebSocket closed', { code, reason })
        await cleanupAll(connectionCleanupFns)
        globalCleanupFns.delete(cleanupConnection)
    })

    /**
     * @param httpUri Example: `https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/src/schema/graphqlschema.ts`
     */
    const transformHttpToFileUri = (httpUri: URL): URL => {
        // https://github.com/suarasaur/url-relative/issues/3
        if (httpUri.href === httpRootUri.href) {
            return fileRootUri
        }
        const relative = relativeUrl(httpRootUri.href, httpUri.href)
        const fileUri = new URL(relative, fileRootUri.href)
        return fileUri
    }
    const transformFileToHttpUri = (fileUri: URL): URL => {
        // https://github.com/suarasaur/url-relative/issues/3
        if (fileUri.href === fileRootUri.href) {
            return httpRootUri
        }
        const relative = relativeUrl(fileRootUri.href, fileUri.href)
        const httpUri = new URL(relative, httpRootUri.href)
        return httpUri
    }

    /** OpenTracing spans for pending requests by message ID */
    const requestSpans = new Map<string | number, Span>()
    const requestAbortFns = new Map<string | number, () => void>()

    webSocketReader.listen(async message => {
        let signal: AbortSignal
        {
            const abortController = new AbortController()
            signal = abortController.signal
            // Make sure that all request handling is cancelled if the connection is closed by the client
            const messageCleanupFn = () => abortController.abort()
            connectionCleanupFns.add(messageCleanupFn)
        }
        let span = new Span()
        try {
            // If a request or notification, start a span
            if (isRequestMessage(message) || isNotificationMessage(message)) {
                span = tracer.startSpan('Handle ' + message.method)
                // Log the trace URL for this request in the client
                // if (span instanceof LightstepSpan) {
                //     const traceUrl = span.generateTraceURL()
                //     logger.log(`Trace ${message.method} ${traceUrl}`)
                // }
                span.setTag('method', message.method)
                if (isRequestMessage(message)) {
                    span.setTag('id', message.id)
                    requestSpans.set(message.id, span)
                }
            }
            if (httpRootUri) {
                span.setTag('rootUri', httpRootUri.href)
            }

            // Intercept initialize
            if (isRequestMessage(message) && message.method === 'initialize') {
                const params: InitializeParams = message.params
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
                connectionCleanupFns.add(async () => {
                    logger.log('Deleting temp dir ', tempDir)
                    await rmfr(tempDir)
                })
                extractPath = path.join(tempDir, 'repo')
                cacheFolderRoot = path.join(tempDir, 'cache')
                globalFolderRoot = path.join(tempDir, 'global')
                await Promise.all([fs.mkdir(extractPath), fs.mkdir(cacheFolderRoot), fs.mkdir(globalFolderRoot)])

                // Fetch zip and extract into temp folder
                logger.log('Fetching zip from', httpRootUri.href)
                const archivePath = path.join(tempDir, 'archive.zip')
                await tracePromise('Fetch source archive', span, async span => {
                    let removeAbortListener = noop
                    try {
                        span.setTag('url', httpRootUri.href)
                        let bytes = 0
                        await new Promise<void>((resolve, reject) => {
                            const archiveRequest = request(httpRootUri.href, {
                                headers: {
                                    Accept: 'application/zip',
                                    'User-Agent': 'TypeScript language server',
                                },
                            })
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
                            removeAbortListener = onAbort(signal, () => {
                                archiveRequest.abort()
                                reject(createAbortError())
                            })
                        })
                        span.setTag('bytes', bytes)
                    } finally {
                        removeAbortListener()
                    }
                })

                // Extract archive
                throwIfAborted(signal)
                logger.log('Extracting archive to ' + extractPath)
                await tracePromise('Extract source archive', span, async span => {
                    await decompress(archivePath, extractPath)
                })

                // Find package.jsons to install
                throwIfAborted(signal)
                const packageJsonPaths = await tracePromise('Find package.jsons', span, span =>
                    glob('**/package.json', { cwd: extractPath })
                )
                logger.log('package.jsons found:', packageJsonPaths)

                // Install dependencies
                await tracePromise('Install dependencies', span, async span => {
                    await Promise.all(
                        packageJsonPaths.map(async relPackageJsonPath => {
                            try {
                                await tracePromise('Install dependencies for package', span, async span => {
                                    span.setTag('packageJsonPath', relPackageJsonPath)
                                    const absPackageJsonPath = path.join(extractPath, relPackageJsonPath)
                                    await filterDependencies(absPackageJsonPath, { logger, span, signal })

                                    // It's important that each concurrent yarn process has their own global and cache folders
                                    const relPackageJsonDirName = path.dirname(relPackageJsonPath)
                                    const globalFolder = path.join(globalFolderRoot, relPackageJsonDirName)
                                    const cacheFolder = path.join(cacheFolderRoot, relPackageJsonDirName)
                                    const cwd = path.join(extractPath, relPackageJsonDirName)

                                    await Promise.all([mkdirp(path.join(globalFolder)), mkdirp(path.join(cacheFolder))])

                                    await install({ cwd, globalFolder, cacheFolder, logger, span, signal })
                                })
                            } catch (err) {
                                logger.error(`Installation for ${relPackageJsonPath} failed`, err)
                            }
                        })
                    )
                })

                // Sanitize tsconfig.json files
                throwIfAborted(signal)
                await tracePromise('Sanitize tsconfig.jsons', span, async span => {
                    const tsconfigPaths = await glob('**/tsconfig.json', { cwd: extractPath })
                    logger.log('tsconfig.jsons found:', tsconfigPaths)
                    span.setTag('count', tsconfigPaths.length)
                    await Promise.all(
                        tsconfigPaths.map(async relTsconfigPath => {
                            throwIfAborted(signal)
                            try {
                                const absTsconfigPath = path.join(extractPath, relTsconfigPath)
                                const tsconfig = JSON.parse(
                                    stripJsonComments(await fs.readFile(absTsconfigPath, 'utf-8'))
                                )
                                if (tsconfig && tsconfig.compilerOptions && tsconfig.compilerOptions.plugins) {
                                    // Remove plugins for security reasons (they get loaded from node_modules)
                                    tsconfig.compilerOptions.plugins = undefined
                                    await fs.writeFile(absTsconfigPath, JSON.stringify(tsconfig))
                                }
                            } catch (err) {
                                logger.error('Error sanitizing tsconfig.json', relTsconfigPath, err)
                                logErrorEvent(span, err)
                            }
                        })
                    )
                })

                // The trailing slash is important for resolving URL relatively to it
                fileRootUri = pathToFileURL(extractPath + '/')
                // URIs are rewritten by rewriteUris below, but it doesn't touch rootPath
                params.rootPath = extractPath
            }

            rewriteUris(message, transformHttpToFileUri)

            // Forward message to language server
            languageServerConnection.writer.write(message)

            // Cancel any request handling
            if (isNotificationMessage(message) && message.method === '$/cancelRequest') {
                const requestAbortFn = requestAbortFns.get(message.params.id)
                if (requestAbortFn) {
                    requestAbortFn()
                }
            }
        } catch (err) {
            span.setTag(ERROR, true)
            logErrorEvent(span, err)

            if (!isAbortError(err)) {
                logger.error('Error handling message\n', message, '\n', err)
            }
            if (isRequestMessage(message)) {
                const code = isAbortError(err)
                    ? ErrorCodes.RequestCancelled
                    : typeof err.code === 'number'
                        ? err.code
                        : ErrorCodes.UnknownErrorCode
                const errResponse = {
                    jsonrpc: '2.0',
                    id: message.id,
                    error: {
                        message: err.message,
                        code,
                        data: {
                            stack: err.stack,
                            ...err,
                        },
                    },
                }
                webSocketConnection.writer.write(errResponse)
            }
        }
    })

    languageServerConnection.forward(webSocketConnection, message => {
        if (isResponseMessage(message) && message.id !== null) {
            // If there is a span for the request, finish it
            const span = requestSpans.get(message.id)
            if (span) {
                // const meta = {}
                // span.tracer().inject(span, FORMAT_TEXT_MAP, meta)
                // ;(message as any).meta = meta
                if (span instanceof LightstepSpan) {
                    // Add trace URL to message for easy access in the WebSocket frame inspector
                    ;(message as any)._trace = span.generateTraceURL()
                }
                span.finish()
                requestSpans.delete(message.id)
            }
            // The request is finished, so it cannot be aborted anymore
            const requestAbortFn = requestAbortFns.get(message.id)
            if (requestAbortFn) {
                // The request no longer needs to be aborted when the connection closes
                connectionCleanupFns.delete(requestAbortFn)
                requestAbortFns.delete(message.id)
            }
        }
        rewriteUris(message, transformFileToHttpUri)
        return message
    })
})

httpServer.listen(port, () => {
    console.log(`WebSocket server listening on port ${port}`)
})
