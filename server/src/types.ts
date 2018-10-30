import { InitializeParams, InitializeResult } from 'vscode-languageserver-protocol'

export type InitializeRequest = JsonRpcRequest<'initialize', InitializeParams>
export type InitializeSuccessResponse = JsonRpcSuccessResponse<InitializeResult>

export type AnyJsonRpcMessage =
    | JsonRpcNotification<string, object | any[]>
    | JsonRpcRequest<string, object | any[]>
    | JsonRpcSuccessResponse<any>
    | JsonRpcErrorResponse
export type LSPMessage = JsonRpcErrorResponse | InitializeRequest | InitializeSuccessResponse

interface JsonRpcBaseMessage {
    jsonrpc: '2.0'
}

export interface JsonRpcNotification<M extends string, P extends object | any[]> {
    jsonrpc: '2.0'
    method: M
    params: P
}

export type JsonRpcMessageId = string | number

export interface JsonRpcRequest<M extends string, P extends object | any[]> extends JsonRpcNotification<M, P> {
    id: JsonRpcMessageId
}

interface JsonRpcBaseResponse extends JsonRpcBaseMessage {
    id: JsonRpcMessageId
}
export type JsonRpcResponse<R> = JsonRpcSuccessResponse<R> | JsonRpcErrorResponse
export const isJsonRpcResponse = (obj: unknown) =>
    typeof obj === 'object' && obj !== null && 'id' in obj && ('result' in obj || 'error' in obj)

export interface JsonRpcSuccessResponse<R> extends JsonRpcBaseResponse {
    result: R
}

export interface JsonRpcErrorResponse extends JsonRpcBaseResponse {
    error: JsonRpcError
}

export interface JsonRpcError {
    code: number
    message: string
    data?: any
}
