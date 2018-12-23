import { flatMap, share } from 'ix/asynciterable'
import { MergeAsyncIterable } from 'ix/asynciterable/merge'
import { noop } from 'lodash'
import { Observable } from 'rxjs'

export const isAbortError = (val: any) => typeof val === 'object' && val !== null && val.name === 'AbortError'

export function throwIfAbortError(err: any): void {
    if (isAbortError(err)) {
        throw err
    }
}

export const createAbortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' })

export const observableFromAsyncIterable = <T>(iterable: AsyncIterable<T>): Observable<T> =>
    new Observable(observer => {
        const iterator = iterable[Symbol.asyncIterator]()
        let unsubscribed = false
        let iteratorDone = false
        function next(): void {
            iterator.next().then(
                ({ value, done }) => {
                    if (unsubscribed) {
                        return
                    }
                    if (done) {
                        iteratorDone = true
                        observer.complete()
                    } else {
                        observer.next(value)
                        next()
                    }
                },
                err => {
                    observer.error(err)
                }
            )
        }
        next()
        return () => {
            unsubscribed = true
            if (!iteratorDone && iterator.throw) {
                iterator.throw(createAbortError()).catch(err => {
                    // ignore
                })
            }
        }
    })

/**
 * Similar to Rx `switchMap`, finishes the generator returned from the previous call whenever the function is called again.
 *
 * Workaround for https://github.com/sourcegraph/sourcegraph/issues/1190
 */
export const abortPrevious = <P extends any[], R>(
    fn: (...args: P) => AsyncIterable<R>
): ((...args: P) => AsyncIterable<R>) => {
    let abort = noop
    return async function*(...args) {
        abort()
        let aborted = false
        abort = () => {
            aborted = true
        }
        for await (const element of fn(...args)) {
            if (aborted) {
                return
            }
            yield element
            if (aborted) {
                return
            }
        }
    }
}

export const asArray = <T>(val: T[] | T | null): T[] => (!val ? [] : Array.isArray(val) ? val : [val])

/** Workaround for https://github.com/sourcegraph/sourcegraph/issues/1321 */
export function distinctUntilChanged<P extends any[], R>(
    compare: (a: P, b: P) => boolean,
    fn: (...args: P) => R
): ((...args: P) => R) {
    let previousResult: R
    let previousArgs: P
    return (...args) => {
        if (previousArgs && compare(previousArgs, args)) {
            return previousResult
        }
        previousArgs = args
        previousResult = fn(...args)
        return previousResult
    }
}

/**
 * Flatmaps the source iterable with `selector`, `concurrency` times at a time.
 */
export const flatMapConcurrent = <T, R>(
    source: AsyncIterable<T>,
    concurrency: number,
    selector: (value: T) => AsyncIterable<R>
): AsyncIterable<R> =>
    new MergeAsyncIterable(new Array<AsyncIterable<R>>(concurrency).fill(share(flatMap(source, selector))))
