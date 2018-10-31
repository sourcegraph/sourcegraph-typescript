import decompress from 'decompress'
import glob from 'globby'
import * as https from 'https'
// @ts-ignore
import { Tracer as LightstepTracer } from 'lightstep-tracer'
import * as fs from 'mz/fs'
import { createWriteStream } from 'mz/fs'
import { Span, Tracer } from 'opentracing'
import { tmpdir } from 'os'
import * as path from 'path'
import request from 'request'
import rmfr from 'rmfr'
import 'source-map-support/register'
import uuid = require('uuid')
import { ErrorCodes, InitializeParams } from 'vscode-languageserver-protocol'
import {
    isNotificationMessage,
    isRequestMessage,
    isResponseMessage,
    IWebSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from 'vscode-ws-jsonrpc'
import * as rpcServer from 'vscode-ws-jsonrpc/lib/server'
import { Server } from 'ws'
import { tracePromise } from './tracing'
import { install } from './yarn'

const CACHE_DIR = process.env.CACHE_DIR || tmpdir()

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

const logger = console
const tracer: Tracer = process.env.LIGHTSTEP_ACCESS_TOKEN
    ? new LightstepTracer({
          access_token: process.env.LIGHTSTEP_ACCESS_TOKEN,
          component_name: 'lang-typescript',
          verbosity: 0,
      })
    : new Tracer()

let httpsServer: https.Server | undefined
if (process.env.TLS_CERT && process.env.TLS_KEY) {
    httpsServer = https.createServer({
        cert: process.env.TLS_CERT,
        key: process.env.TLS_KEY,
    })
}

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080
const webSocketServer = new Server({ port, server: httpsServer })

webSocketServer.on('connection', async connection => {
    logger.log('New WebSocket connection')
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
    // const languageServerConnection = rpcServer.createServerProcess('TypeScript language', 'node', [
    //     path.resolve(__dirname, '..', '..', 'node_modules', 'typescript-language-server', 'lib', 'cli.js'),
    //     '--stdio',
    //     // Use local tsserver instead of the tsserver of the repo for security reasons
    //     '--tsserver-path=' + path.join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsserver'),
    //     '--log-level=4',
    // ])
    const languageServerConnection = rpcServer.createServerProcess('TypeScript language', 'node', [
        path.resolve(
            __dirname,
            '..',
            '..',
            'node_modules',
            'javascript-typescript-langserver',
            'lib',
            'language-server-stdio.js'
        ),
    ])

    let zipRootUri: URL
    let fileRootUri: URL
    let tempDir: string
    let extractPath: string
    let yarnGlobalFolder: string
    let yarnCacheFolder: string
    const toDispose: (() => void | Promise<void>)[] = []
    toDispose.push(() => languageServerConnection.dispose())
    connection.on('close', async (code, reason) => {
        logger.log('WebSocket closed', { code, reason })
        for (const dispose of toDispose) {
            try {
                await dispose()
            } catch (err) {
                logger.error('Error disposing', err)
            }
        }
    })

    const transformZipToFileUri = (zipUri: URL): URL => {
        const fileUri = new URL(fileRootUri.href)
        fileUri.pathname = path.posix.join(fileRootUri.pathname, zipUri.hash.substr(1))
        return fileUri
    }
    const transformFileToZipUri = (fileUri: URL): URL => {
        const zipUri = new URL(zipRootUri.href)
        zipUri.hash = path.relative(fileUri.pathname.replace(/\//g, path.sep), extractPath).replace(/\\/g, '/')
        return zipUri
    }

    webSocketReader.listen(async message => {
        let span = new Span()
        try {
            if (isRequestMessage(message) || isNotificationMessage(message)) {
                span = tracer.startSpan('Handle ' + message.method)
            }
            if (isRequestMessage(message) && message.method === 'initialize') {
                const params: InitializeParams = message.params
                if (!params.rootUri) {
                    throw new Error('No rootUri given as initialize parameter')
                }
                zipRootUri = new URL(params.rootUri)
                if (!zipRootUri.pathname.endsWith('.zip')) {
                    throw new Error('rootUri must end with .zip')
                }
                if (zipRootUri.protocol !== 'http:' && zipRootUri.protocol !== 'https:') {
                    throw new Error('Protocol must be http or https')
                }
                // Create temp folders
                tempDir = path.join(
                    CACHE_DIR,
                    (zipRootUri.hostname + zipRootUri.pathname).replace(/\//g, '_') + '_' + uuid.v1()
                )
                await fs.mkdir(tempDir)
                toDispose.push(() => rmfr(tempDir))
                extractPath = path.join(tempDir, 'repo')
                yarnCacheFolder = path.join(tempDir, 'cache')
                yarnGlobalFolder = path.join(tempDir, 'global')
                await Promise.all([fs.mkdir(extractPath), fs.mkdir(yarnCacheFolder), fs.mkdir(yarnGlobalFolder)])
                console.log('Fetching zip from', zipRootUri.href)

                // Fetch zip and extract into temp folder
                const archivePath = path.join(tempDir, 'archive.zip')
                tracePromise('Fetch source archive', span, async span => {
                    span.setTag('url', zipRootUri.href)
                    await new Promise<void>((resolve, reject) => {
                        request(zipRootUri.href)
                            .on('error', reject)
                            .pipe(createWriteStream(archivePath))
                            .on('finish', resolve)
                            .on('error', reject)
                    })
                })
                tracePromise('Extract source archive', span, async span => {
                    await decompress(archivePath, extractPath, {
                        strip: 1,
                    })
                })

                // Find package.jsons to install
                const packageJsons = await tracePromise('Find package.jsons', span, span =>
                    glob('**/package.json', { cwd: extractPath })
                )
                logger.log('package.jsons found:', packageJsons)

                // Install dependencies
                await tracePromise('Install dependencies', span, async span => {
                    await Promise.all(
                        packageJsons.map(
                            packageJson =>
                                new Promise<void>((resolve, reject) => {
                                    const yarnProcess = install(
                                        {
                                            cwd: path.join(extractPath, packageJson),
                                            globalFolder: yarnGlobalFolder,
                                            cacheFolder: yarnCacheFolder,
                                            logger,
                                        },
                                        span
                                    )
                                    yarnProcess.on('success', resolve)
                                    yarnProcess.on('error', reject)
                                    toDispose.push(() => yarnProcess.kill())
                                })
                        )
                    )
                })

                // Rewrite HTTP zip root URI to a file URI pointing to the checkout dir
                fileRootUri = new URL('file:')
                fileRootUri.pathname = extractPath.replace(/\\/g, '/')
                params.rootUri = fileRootUri.href
                params.rootPath = undefined
                params.workspaceFolders = null
            }
            if (isRequestMessage(message) || isNotificationMessage(message)) {
                rewriteUris(message.params, transformZipToFileUri)
            } else if (isResponseMessage(message)) {
                if (message.result) {
                    rewriteUris(message.result, transformFileToZipUri)
                }
                if (message.error) {
                    rewriteUris(message.error.data, transformFileToZipUri)
                }
            }

            // Forward message to language server
            languageServerConnection.writer.write(message)
        } catch (err) {
            span.setTag('error', true)
            span.log({ event: 'error', 'error.object': err, stack: err.stack, message: err.message })

            logger.error('Error handling message', message, err)
            if (isRequestMessage(message)) {
                console.log('is request message')
                const errResponse = {
                    jsonrpc: '2.0',
                    id: message.id,
                    error: {
                        message: err.message,
                        code: typeof err.code === 'number' ? err.code : ErrorCodes.UnknownErrorCode,
                        data: {
                            stack: err.stack,
                            ...err,
                        },
                    },
                }
                webSocketConnection.writer.write(errResponse)
            }
        } finally {
            span.finish()
        }
    })
    languageServerConnection.forward(webSocketConnection)
})

logger.log('WebSocket server listening on port 8080')
