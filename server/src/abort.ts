import { noop } from 'lodash'

/**
 * Attaches a listener to be called when the given AbortSignal is aborted.
 *
 * @returns A function to remove the listener again (to be called when the operation is done, i.e. cannot be cancelled anymore)
 */
export function onAbort(signal: AbortSignal, listener: () => void): () => void {
    if (signal.aborted) {
        listener()
        return noop
    }
    signal.addEventListener('abort', listener, { once: true })
    return () => signal.removeEventListener('abort', listener)
}

/**
 * Creates an Error with name "AbortError"
 */
export const createAbortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' })

/**
 * Returns true if the given value is an AbortError
 */
export const isAbortError = (err: any) => typeof err === 'object' && err !== null && err.name === 'AbortError'

/**
 * Throws an AbortError if the given AbortSignal is already aborted
 */
export function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw createAbortError()
    }
}
