import { noop } from 'lodash'
import { Observable } from 'rxjs'
import * as sourcegraph from 'sourcegraph'
import { createAbortError } from '../common/cancellation'

export interface SourcegraphEndpoint {
    url: URL
    accessToken?: string
}

export const areProviderParamsEqual = (
    [doc1, pos1]: [sourcegraph.TextDocument, sourcegraph.Position],
    [doc2, pos2]: [sourcegraph.TextDocument, sourcegraph.Position]
): boolean => doc1.uri === doc2.uri && pos1.isEqual(pos2)

export const observableFromAsyncGenerator = <T>(generator: () => AsyncGenerator<T, unknown, void>): Observable<T> =>
    new Observable(observer => {
        const iterator = generator()
        let unsubscribed = false
        let iteratorDone = false
        function next(): void {
            iterator.next().then(
                result => {
                    if (unsubscribed) {
                        return
                    }
                    if (result.done) {
                        iteratorDone = true
                        observer.complete()
                    } else {
                        observer.next(result.value)
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
                iterator.throw(createAbortError()).catch(() => {
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
    fn: (...args: P) => AsyncGenerator<R, void, void>
): ((...args: P) => AsyncGenerator<R, void, void>) => {
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
): (...args: P) => R {
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
