import axios, { CancelToken } from 'axios'
import { CancellationToken } from 'vscode-jsonrpc'

export function toAxiosCancelToken(token: CancellationToken): CancelToken {
    const source = axios.CancelToken.source()
    token.onCancellationRequested(() => source.cancel())
    return source.token
}
