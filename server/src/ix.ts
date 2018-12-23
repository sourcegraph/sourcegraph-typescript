import { AsyncIterableX, flatMap, share } from 'ix/asynciterable'
import { MergeAsyncIterable } from 'ix/asynciterable/merge'

/**
 * Flatmaps the source iterable with `selector`, `concurrency` times at a time.
 */
export const flatMapConcurrent = <T, R>(
    source: AsyncIterable<T>,
    concurrency: number,
    selector: (value: T) => AsyncIterable<R>
): AsyncIterableX<R> =>
    new MergeAsyncIterable(new Array<AsyncIterable<R>>(concurrency).fill(share(flatMap(source, selector))))

export const filterConcurrent = <T>(
    source: AsyncIterable<T>,
    concurrency: number,
    predicate: (value: T) => boolean | Promise<boolean>
): AsyncIterableX<T> =>
    flatMapConcurrent(source, concurrency, async function*(value) {
        if (await predicate(value)) {
            yield value
        }
    })

export const findConcurrent = <T>(
    source: AsyncIterable<T>,
    concurrency: number,
    predicate: (value: T) => boolean | Promise<boolean>
): Promise<T | undefined> => filterConcurrent(source, concurrency, predicate).first()
