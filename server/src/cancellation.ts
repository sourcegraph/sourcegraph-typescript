import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc'

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
export function throwIfCancelled(token: CancellationToken): void {
    if (token.isCancellationRequested) {
        throw createAbortError()
    }
}

export function tryCancel(token: CancellationTokenSource): void {
    try {
        token.cancel()
    } catch (err) {
        // ignore
    }
}
