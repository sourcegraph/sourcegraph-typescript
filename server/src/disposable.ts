import { Unsubscribable } from 'rxjs'
import { Logger } from './logging'

export interface Disposable {
    dispose(): void
}

export interface AsyncDisposable {
    disposeAsync(): Promise<void>
}
export const isAsyncDisposable = (val: any): val is AsyncDisposable =>
    typeof val === 'object' && val !== null && typeof val.disposeAsync === 'function'

/**
 * Disposes all provided Disposables, sequentially, in order.
 * Disposal is best-effort, meaning if any Disposable fails to dispose, the error is logged and the function proceeds to the next one.
 *
 * @throws never
 */
export function disposeAll(disposables: Iterable<Disposable>, logger: Logger = console): void {
    for (const disposable of disposables) {
        try {
            disposable.dispose()
        } catch (err) {
            logger.error('Error disposing', disposable, err)
        }
    }
}

/**
 * Disposes all provided Disposables, sequentially, in order.
 * Disposal is best-effort, meaning if any Disposable fails to dispose, the error is logged and the function proceeds to the next one.
 * An AsyncDisposable is given 20 seconds to dispose, otherwise the function proceeds to the next disposable.
 *
 * @throws never
 */
export async function disposeAllAsync(
    disposables: Iterable<Disposable | AsyncDisposable>,
    { logger = console, timeout = 20000 }: { logger?: Logger; timeout?: number } = {}
): Promise<void> {
    for (const disposable of disposables) {
        try {
            if (isAsyncDisposable(disposable)) {
                await Promise.race([
                    disposable.disposeAsync(),
                    new Promise<void>((_, reject) =>
                        setTimeout(
                            () => reject(new Error(`AsyncDisposable did not dispose within ${timeout}ms`)),
                            timeout
                        )
                    ),
                ])
            } else {
                disposable.dispose()
            }
        } catch (err) {
            logger.error('Error disposing', disposable, err)
        }
    }
}

/**
 * Converts an RxJS Subscription to a Disposable.
 */
export const subscriptionToDisposable = (subscription: Unsubscribable): Disposable => ({
    dispose: () => subscription.unsubscribe(),
})
