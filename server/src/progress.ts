import { isEqual } from 'lodash'
import { Observer, Subject } from 'rxjs'
import { distinctUntilChanged, scan, takeWhile, throttleTime } from 'rxjs/operators'
import { MessageConnection } from 'vscode-jsonrpc'
import { MessageType, ShowMessageNotification } from 'vscode-languageserver-protocol'
import { Logger } from './logging'
import { WindowProgressNotification } from './protocol.progress.proposed'
import { tryLogError } from './util'

export interface Progress {
    /** Integer from 0 to 100 */
    percentage?: number
    message?: string
}

/**
 * A ProgressReporter is an Observer for progress reporting.
 * Calling `next()` or `complete()` never throws.
 * `complete()` is idempotent.
 * Emitting a percentage of `100` has the same effect as calling `complete()`.
 */
export type ProgressReporter = Observer<Progress>

let progressIds = 1
const createReporter = (connection: MessageConnection, logger: Logger, title?: string): ProgressReporter => {
    const id = String(progressIds++)
    const subject = new Subject<Progress>()
    let didReport = false
    subject
        .pipe(
            // Convert a next() with percentage >= 100 to a complete() for safety
            // Apply this first because throttleTime() can drop emissions
            takeWhile(progress => !progress.percentage || progress.percentage < 100),
            // Merge progress updates with previous values because otherwise it would not be safe to throttle below (it may drop updates)
            // This way, every message contains the full state and does not depend on the previous state
            scan<Progress, Progress>(
                (state, { percentage = state.percentage, message = state.message }) => ({ percentage, message }),
                {}
            ),
            distinctUntilChanged((a, b) => isEqual(a, b)),
            throttleTime(100, undefined, { leading: true, trailing: true })
        )
        .subscribe({
            next: progress => {
                didReport = true
                tryLogError(logger, () => {
                    connection.sendNotification(WindowProgressNotification.type, {
                        ...progress,
                        id,
                        title,
                    })
                })
            },
            error: err => {
                tryLogError(logger, () => {
                    // window/progress doesn't support erroring the progress,
                    // but we can emulate by hiding the progress and showing an error
                    if (didReport) {
                        connection.sendNotification(WindowProgressNotification.type, { id, done: true })
                    }
                    connection.sendNotification(ShowMessageNotification.type, {
                        message: err.message,
                        type: MessageType.Error,
                    })
                })
            },
            complete: () => {
                if (!didReport) {
                    return
                }
                tryLogError(logger, () => {
                    connection.sendNotification(WindowProgressNotification.type, { id, percentage: 100, done: true })
                })
            },
        })
    return subject
}

/**
 * Creates a progress display with the given title,
 * then calls the function with a ProgressReporter.
 * Once the task finishes, completes the progress display.
 */
export type ProgressProvider = <R>(
    title: string | undefined,
    fn: (reporter: ProgressReporter) => Promise<R>
) => Promise<R>

export const createProgressProvider = (connection: MessageConnection, logger: Logger): ProgressProvider => async (
    title,
    fn
) => {
    const reporter = createReporter(connection, logger, title)
    try {
        const result = await fn(reporter)
        reporter.complete()
        return result
    } catch (err) {
        reporter.error(err)
        throw err
    }
}

export const noopProgressProvider: ProgressProvider = (_title, fn) => fn(new Subject())
