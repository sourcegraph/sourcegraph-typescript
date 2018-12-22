import { ChildProcess, spawn } from 'child_process'
// import { exec } from 'mz/child_process'
import { Span, Tracer } from 'opentracing'
import * as path from 'path'
import { combineLatest, concat, fromEvent, merge, Unsubscribable } from 'rxjs'
import { filter, map, switchMap, withLatestFrom } from 'rxjs/operators'
import { Readable } from 'stream'
import { CancellationToken, Disposable } from 'vscode-jsonrpc'
import { createAbortError, throwIfCancelled } from './cancellation'
import { disposeAll } from './disposable'
import { Logger, NoopLogger } from './logging'
import { Progress, ProgressProvider } from './progress'
import { tracePromise } from './tracing'

export interface YarnStep {
    message: string
    current: number
    total: number
}
export interface YarnProgressStart {
    id: number
    total: number
}
export interface YarnProgressTick {
    id: number
    current: number
}
export interface YarnProgressFinish {
    id: number
}
export interface YarnActivityStart {
    id: number
}
export interface YarnActivityTick {
    id: number
    name: string
}
export interface YarnActivityEnd {
    id: number
}

/**
 * Child process that emits additional events from yarn's JSON stream
 */
export interface YarnProcess extends ChildProcess {
    /** Emitted for verbose logs */
    on(event: 'verbose', listener: (log: string) => void): this
    /** Emitted on a yarn step (e.g. Resolving, Fetching, Linking) */
    on(event: 'step', listener: (step: YarnStep) => void): this

    on(event: 'activityStart', listener: (step: YarnActivityStart) => void): this
    on(event: 'activityTick', listener: (step: YarnActivityTick) => void): this
    on(event: 'activityEnd', listener: (step: YarnActivityEnd) => void): this

    on(event: 'progressStart', listener: (step: YarnProgressStart) => void): this
    on(event: 'progressTick', listener: (step: YarnProgressTick) => void): this
    on(event: 'progressFinish', listener: (step: YarnProgressFinish) => void): this

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

    once(event: 'activityStart', listener: (step: YarnActivityStart) => void): this
    once(event: 'activityTick', listener: (step: YarnActivityTick) => void): this
    once(event: 'activityEnd', listener: (step: YarnActivityEnd) => void): this

    once(event: 'progressStart', listener: (step: YarnProgressStart) => void): this
    once(event: 'progressTick', listener: (step: YarnProgressTick) => void): this
    once(event: 'progressFinish', listener: (step: YarnProgressFinish) => void): this

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

const YARN_BIN_JS = path.resolve(__dirname, '..', '..', 'node_modules', 'yarn', 'lib', 'cli.js')

/**
 * Spawns a yarn child process.
 * The returned child process emits additional events from the streamed JSON events yarn writes to STDIO.
 * An exit code of 0 causes a `success` event to be emitted, any other an `error` event
 *
 * @param options
 */
export function spawnYarn({ span = new Span(), logger = new NoopLogger(), ...options }: YarnSpawnOptions): YarnProcess {
    const args = [
        YARN_BIN_JS,
        '--ignore-scripts', // Don't run package.json scripts
        '--ignore-platform', // Don't error on failing platform checks
        '--ignore-engines', // Don't check package.json engines field
        '--no-bin-links', // Don't create bin symlinks
        '--no-emoji', // Don't use emojis in output
        '--non-interactive', // Don't ask for any user input
        '--json', // Output a newline-delimited JSON stream
        '--link-duplicates', // Use hardlinks instead of copying
        '--pure-lockfile', // Trust the lockfile if exists

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
    logger.log(`Starting yarn install`)
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
                    if (event.type === 'error') {
                        // Only emit error event if non-zero exit code
                        logger.error('yarn: ', event.data)
                        errors.push(event.data)
                    } else if (event.type !== 'success') {
                        yarn.emit(event.type, event.data)
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
    withProgress: ProgressProvider
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
    withProgress,
    ...spawnOptions
}: YarnInstallOptions): Promise<void> {
    throwIfCancelled(token)
    await tracePromise('yarn install', tracer, span, async span => {
        await withProgress('Dependency installation', async reporter => {
            const using: (Disposable | Unsubscribable)[] = []
            try {
                // const [stdout] = await exec(`node ${YARN_BIN_JS} config list`, { cwd })
                // logger.log('yarn config', stdout)
                await new Promise<void>((resolve, reject) => {
                    const yarn = spawnYarn({ ...spawnOptions, cwd, tracer, span, logger })
                    const steps = fromEvent<YarnStep>(yarn, 'step')
                    using.push(
                        merge<Progress>(
                            combineLatest(
                                concat([''], fromEvent<YarnActivityTick>(yarn, 'activityTick').pipe(map(a => a.name))),
                                steps
                            ).pipe(
                                map(([activityName, step]) => ({
                                    message: [step.message, activityName].filter(Boolean).join(' - '),
                                    percentage: Math.round(((step.current - 1) / step.total) * 100),
                                }))
                            ),
                            // Only listen to the latest progress
                            fromEvent<YarnProgressStart>(yarn, 'progressStart').pipe(
                                withLatestFrom(steps),
                                switchMap(([{ total, id }, step]) =>
                                    fromEvent<YarnProgressTick>(yarn, 'progressTick').pipe(
                                        filter(progress => progress.id === id),
                                        map(progress => ({
                                            percentage: Math.round(
                                                ((step.current - 1 + progress.current / total) / step.total) * 100
                                            ),
                                        }))
                                    )
                                )
                            )
                        ).subscribe(reporter)
                    )

                    yarn.on('success', resolve)
                    yarn.on('error', reject)
                    using.push(
                        token.onCancellationRequested(() => {
                            logger.log('Killing yarn process in ', cwd)
                            yarn.kill()
                            reject(createAbortError())
                        })
                    )
                })
            } finally {
                disposeAll(using)
            }
        })
    })
}
