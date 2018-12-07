import { Observable } from 'rxjs'
import * as sourcegraph from 'sourcegraph'

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
            if (!iteratorDone && iterator.return) {
                console.warn('Observable was unsubscribed from before Iterator finished')
                iterator.return().catch(err => {
                    // ignore
                })
            }
        }
    })

export const asArray = <T>(val: T[] | T | null): T[] => (!val ? [] : Array.isArray(val) ? val : [val])
