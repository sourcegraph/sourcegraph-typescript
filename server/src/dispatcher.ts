import { Span, Tracer } from 'opentracing'
import { ERROR } from 'opentracing/lib/ext/tags'
import { Observable, Subject } from 'rxjs'
import { filter, map } from 'rxjs/operators'
import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc'
import {
    ErrorCodes,
    isNotificationMessage,
    isRequestMessage,
    NotificationMessage,
    NotificationType1,
    RequestType1,
    ResponseMessage,
} from 'vscode-jsonrpc/lib/messages'
import { MessageReader, MessageWriter } from 'vscode-languageserver-protocol'
import { isAbortError, tryCancel } from './cancellation'
import { Logger } from './logging'
import { logErrorEvent } from './tracing'

interface Connection {
    reader: MessageReader
    writer: MessageWriter
}

type RequestId = string | number

type RequestHandler<P, R> = (params: P, token: CancellationToken, span: Span) => PromiseLike<R>

// Aliases because vscode-jsonrpc's interfaces are weird.
export type RequestType<P, R> = RequestType1<P, R, any, any>
export type NotificationType<P> = NotificationType1<P, any>

interface Dispatcher {
    observeNotification<P>(type: NotificationType<P>): Observable<P>
    setRequestHandler<P, R>(type: RequestType<P, R>, handler: RequestHandler<P, R>): void
    dispose(): void
}

/**
 * Alternative dispatcher to vscode-jsonrpc that supports OpenTracing and Observables
 */
export function createDispatcher(
    client: Connection,
    { tracer, logger }: { tracer: Tracer; logger: Logger }
): Dispatcher {
    const cancellationTokenSources = new Map<RequestId, CancellationTokenSource>()
    const handlers = new Map<string, RequestHandler<any, any>>()
    const notifications = new Subject<NotificationMessage>()

    client.reader.listen(async message => {
        if (isNotificationMessage(message)) {
            if (message.method === '$/cancelRequest') {
                // Cancel the handling of a different request
                const canellationTokenSource = cancellationTokenSources.get(message.params.id)
                if (canellationTokenSource) {
                    canellationTokenSource.cancel()
                }
            } else {
                notifications.next(message)
            }
        } else if (isRequestMessage(message)) {
            const handler = handlers.get(message.method)
            if (handler) {
                const span = tracer.startSpan('Handle ' + message.method)
                // Log the trace URL for this request in the client
                // if (span instanceof LightstepSpan) {
                //     const traceUrl = span.generateTraceURL()
                //     logger.log(`Trace ${message.method} ${traceUrl}`)
                // }
                span.setTag('method', message.method)
                if (isRequestMessage(message)) {
                    span.setTag('id', message.id)
                }
                const cancellationTokenSource = new CancellationTokenSource()
                cancellationTokenSources.set(message.id, cancellationTokenSource)
                const token = cancellationTokenSource.token
                try {
                    const result = await Promise.resolve(handler(message.params, token, span))
                    const response: ResponseMessage = {
                        jsonrpc: '2.0',
                        id: message.id,
                        result,
                    }
                    client.writer.write(response)
                } catch (err) {
                    span.setTag(ERROR, true)
                    logErrorEvent(span, err)

                    if (!isAbortError(err)) {
                        logger.error('Error handling message\n', message, '\n', err)
                    }
                    if (isRequestMessage(message)) {
                        const code = isAbortError(err)
                            ? ErrorCodes.RequestCancelled
                            : typeof err.code === 'number'
                            ? err.code
                            : ErrorCodes.UnknownErrorCode
                        const errResponse = {
                            jsonrpc: '2.0',
                            id: message.id,
                            error: {
                                message: err.message,
                                code,
                                data: {
                                    stack: err.stack,
                                    ...err,
                                },
                            },
                        }
                        client.writer.write(errResponse)
                    }
                } finally {
                    cancellationTokenSources.delete(message.id)
                    span.finish()
                }
            }
        }
    })

    return {
        observeNotification<P>(type: NotificationType<P>): Observable<P> {
            const method = type.method
            return notifications.pipe(
                filter(message => message.method === method),
                map(message => message.params)
            )
        },
        setRequestHandler<P, R>(type: RequestType<P, R>, handler: RequestHandler<P, R>): void {
            handlers.set(type.method, handler)
        },
        dispose(): void {
            for (const cancellationTokenSource of cancellationTokenSources.values()) {
                tryCancel(cancellationTokenSource)
            }
        },
    }
}
