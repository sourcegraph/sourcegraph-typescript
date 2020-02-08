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
