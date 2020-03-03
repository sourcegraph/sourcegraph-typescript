import { fork } from 'child_process'
import { writeFile } from 'mz/fs'
import { Tracer } from 'opentracing'
import { SPAN_KIND, SPAN_KIND_RPC_SERVER } from 'opentracing/lib/ext/tags'
import * as path from 'path'
import { fromEvent, Observable } from 'rxjs'
import { Tail } from 'tail'
import {
    createMessageConnection,
    Disposable,
    IPCMessageReader,
    IPCMessageWriter,
    MessageConnection,
} from 'vscode-jsonrpc'
import { LogMessageNotification } from 'vscode-languageserver-protocol'
import { Settings } from './config'
import { createDispatcher, Dispatcher } from './dispatcher'
import { disposeAll, subscriptionToDisposable } from './disposable'
import { LOG_LEVEL_TO_LSP, Logger, LSP_TO_LOG_LEVEL, PrefixedLogger } from './logging'

const TYPESCRIPT_LANGSERVER_JS_BIN = path.resolve(
    __dirname,
    '..',
    'node_modules',
    '@sourcegraph',
    'typescript-language-server',
    'lib',
    'cli.js'
)

export interface LanguageServer extends Disposable {
    connection: MessageConnection
    dispatcher: Dispatcher
    /** Error events from the process (e.g. spawning failed) */
    errors: Observable<any>
}

export async function spawnLanguageServer({
    tempDir,
    tsserverCacheDir,
    configuration,
    connectionId,
    logger,
    tracer,
}: {
    tempDir: string
    tsserverCacheDir: string
    configuration: Settings
    connectionId: string
    logger: Logger
    tracer: Tracer
}): Promise<LanguageServer> {
    const disposables = new Set<Disposable>()
    const args: string[] = [
        '--node-ipc',
        // Use local tsserver instead of the tsserver of the repo for security reasons
        '--tsserver-path=' + path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsserver'),
    ]
    if (configuration['typescript.langserver.log']) {
        args.push('--log-level=' + LOG_LEVEL_TO_LSP[configuration['typescript.langserver.log'] || 'log'])
    }
    if (configuration['typescript.tsserver.log']) {
        // Prepare tsserver log file
        const tsserverLogFile = path.resolve(tempDir, 'tsserver.log')
        await writeFile(tsserverLogFile, '') // File needs to exist or else Tail will error
        const tsserverLogger = new PrefixedLogger(logger, 'tsserver')
        // Set up a tail -f on the tsserver logfile and forward the logs to the logger
        const tsserverTail = new Tail(tsserverLogFile, { follow: true, fromBeginning: true, useWatchFile: true })
        disposables.add({ dispose: () => tsserverTail.unwatch() })
        tsserverTail.on('line', line => tsserverLogger.log(line + ''))
        tsserverTail.on('error', err => logger.error('Error tailing tsserver logs', err))
        args.push('--tsserver-log-file', tsserverLogFile)
        args.push('--tsserver-log-verbosity', configuration['typescript.tsserver.log'] || 'verbose')
    }
    logger.log('Spawning language server')
    const serverProcess = fork(TYPESCRIPT_LANGSERVER_JS_BIN, args, {
        env: {
            ...process.env,
            XDG_CACHE_HOME: tsserverCacheDir,
        },
        stdio: ['ipc', 'inherit'],
        execArgv: [],
    })
    disposables.add({ dispose: () => serverProcess.kill() })
    // Log language server STDERR output
    const languageServerLogger = new PrefixedLogger(logger, 'langserver')
    serverProcess.stderr!.on('data', chunk => languageServerLogger.log(chunk + ''))
    const languageServerReader = new IPCMessageReader(serverProcess)
    const languageServerWriter = new IPCMessageWriter(serverProcess)
    disposables.add(languageServerWriter)
    const connection = createMessageConnection(languageServerReader, languageServerWriter, logger)
    disposables.add(connection)
    connection.listen()

    // Forward log messages from the language server to the browser
    const dispatcher = createDispatcher(
        {
            reader: languageServerReader,
            writer: languageServerWriter,
        },
        {
            tracer,
            logger,
            tags: {
                connectionId,
                [SPAN_KIND]: SPAN_KIND_RPC_SERVER,
            },
        }
    )
    disposables.add(
        subscriptionToDisposable(
            dispatcher.observeNotification(LogMessageNotification.type).subscribe(params => {
                const type = LSP_TO_LOG_LEVEL[params.type]
                languageServerLogger[type](params.message)
            })
        )
    )
    return {
        connection,
        dispatcher,
        errors: fromEvent<any>(serverProcess, 'error'),
        dispose: () => disposeAll(disposables),
    }
}
