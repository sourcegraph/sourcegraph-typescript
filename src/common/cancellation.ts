import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc'
import { createAbortError } from '@sourcegraph/basic-code-intel'

export { AbortError, createAbortError, isAbortError, throwIfAbortError } from '@sourcegraph/basic-code-intel'

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
