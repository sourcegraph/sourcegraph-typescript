import { ChildProcess, spawn } from 'child_process'
import { exec } from 'mz/child_process'
import { Span, Tracer } from 'opentracing'
import * as path from 'path'
import { Readable } from 'stream'
import { CancellationToken, Disposable } from 'vscode-jsonrpc'
import { createAbortError, throwIfCancelled } from './cancellation'
import { disposeAll } from './disposable'
import { Logger, NoopLogger } from './logging'
import { tracePromise } from './tracing'

/**
 * Emitted value for a `step` event
 */
export interface YarnStep {
    message: string
    current: number
    total: number
}

/**
 * Child process that emits additional events from yarn's JSON stream
 */
export interface YarnProcess extends ChildProcess {
    /** Emitted for verbose logs */
    on(event: 'verbose', listener: (log: string) => void): this
    /** Emitted on a yarn step (e.g. Resolving, Fetching, Linking) */
    on(event: 'step', listener: (step: YarnStep) => void): this
    /** Emitted if the process exited successfully */
    on(event: 'success', listener: () => void): this
    /** Emitted on error event or non-zero exit code */
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'exit', listener: (code: number, signal: string) => void): this
    on(event: string | symbol, listener: (...args: any[]) => void): this

    /** Emitted for verbose logs */
    once(event: 'verbose', listener: (log: string) => void): this
    /** Emitted on a yarn step (e.g. Resolving, Fetching, Linking) */
    once(event: 'step', listener: (step: YarnStep) => void): this
    /** Emitted if the process exited successfully */
    once(event: 'success', listener: () => void): this
    /** Emitted on error event or non-zero exit code */
    once(event: 'error', listener: (err: Error) => void): this
    once(event: 'exit', listener: (code: number, signal: string) => void): this
    once(event: string | symbol, listener: (...args: any[]) => void): this
}

export interface YarnSpawnOptions {
    /** The folder to run yarn in */
    cwd: string

    /** The global directory to use (`--global-folder`) */
    globalFolder: string

    /** The cache directory to use (`--cache-folder`) */
    cacheFolder: string

    /** Whether to run yarn in verbose mode (`--verbose`) to get verbose events (e.g. "Copying file from A to B") */
    verbose?: boolean

    /** Logger to use */
    logger: Logger

    /** OpenTracing tracer */
    tracer: Tracer

    /** OpenTracing parent span */
    span?: Span
}

/**
 * Spawns a yarn child process.
 * The returned child process emits additional events from the streamed JSON events yarn writes to STDIO.
 * An exit code of 0 causes a `success` event to be emitted, any other an `error` event
 *
 * @param options
 */
export function spawnYarn({
    span = new Span(),
    logger = new NoopLogger(),
    ...options
}: YarnInstallOptions): YarnProcess {
    const args = [
        path.resolve(__dirname, '..', '..', 'node_modules', 'yarn', 'lib', 'cli.js'),
        '--ignore-scripts', // Don't run package.json scripts
        '--ignore-platform', // Don't error on failing platform checks
        '--ignore-engines', // Don't check package.json engines field
        '--no-bin-links', // Don't create bin symlinks
        '--no-emoji', // Don't use emojis in output
        '--non-interactive', // Don't ask for any user input
        '--no-progress', // Don't report progress events
        '--json', // Output a newline-delimited JSON stream
        '--link-duplicates', // Use hardlinks instead of copying

        // Use a separate global and cache folders per package.json
        // that we can clean up afterwards and don't interfere with concurrent installations
        '--global-folder',
        options.globalFolder,
        '--cache-folder',
        options.cacheFolder,
    ]
    if (options.verbose) {
        args.push('--verbose')
    }
    const yarn: YarnProcess = spawn(process.execPath, args, { cwd: options.cwd })

    /** Emitted error messages by yarn */
    const errors: string[] = []

    function parseStream(stream: Readable): void {
        let buffer = ''
        stream.on('data', chunk => {
            try {
                buffer += chunk
                const lines = buffer.split('\n')
                buffer = lines.pop()!
                for (const line of lines) {
                    const event = JSON.parse(line)
                    switch (event.type) {
                        case 'error':
                            // Only emit error event if non-zero exit code
                            logger.error('yarn: ', event.data)
                            errors.push(event.data)
                            break
                        case 'step':
                        case 'verbose':
                            yarn.emit(event.type, event.data)
                            break
                    }
                }
            } catch (err) {
                // E.g. JSON parse error
                yarn.emit('error', err)
                logger.error('yarn install', err, buffer)
            }
        })
    }

    // Yarn writes JSON messages to both STDOUT and STDERR depending on event type
    parseStream(yarn.stdout)
    parseStream(yarn.stderr)

    yarn.on('exit', (code, signal) => {
        if (code === 0) {
            logger.log('yarn install done')
            yarn.emit('success')
        } else if (!signal) {
            const error = Object.assign(new Error(`yarn install failed: ${errors.join(', ')}`), {
                code,
                errors,
            })
            logger.error(error)
            yarn.emit('error', error)
        }
        span.finish()
    })

    // Trace steps, e.g. Resolving, Fetching, Linking
    yarn.on('step', step => {
        span.log({ event: 'step', message: step.message })
        logger.log(`${step.current}/${step.total} ${step.message}`)
    })

    return yarn
}

interface YarnInstallOptions extends YarnSpawnOptions {
    token: CancellationToken
}

/**
 * Wrapper around `spawnYarn()` returning a Promise and accepting an CancellationToken.
 */
export async function install({
    logger,
    tracer,
    span,
    token,
    cwd,
    ...spawnOptions
}: YarnInstallOptions): Promise<void> {
    await tracePromise('yarn install', tracer, span, async span => {
        throwIfCancelled(token)
        const using: Disposable[] = []
        try {
            const [stdout] = await exec('yarn config list', { cwd })
            logger.log('yarn config', stdout)
            await new Promise<void>((resolve, reject) => {
                const yarnProcess = spawnYarn({ ...spawnOptions, cwd, tracer, span, token, logger })
                yarnProcess.on('success', resolve)
                yarnProcess.on('error', reject)
                using.push(
                    token.onCancellationRequested(() => {
                        logger.log('Killing yarn process in ', cwd)
                        yarnProcess.kill()
                        reject(createAbortError())
                    })
                )
            })
        } finally {
            disposeAll(using)
        }
    })
}
