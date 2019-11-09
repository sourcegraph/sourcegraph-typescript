import { FORMAT_TEXT_MAP, Span, Tracer } from 'opentracing'
import { ERROR } from 'opentracing/lib/ext/tags'
import * as prometheus from 'prom-client'
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
import { isAbortError, tryCancel } from '../common/cancellation'
import { Logger } from '../common/logging'
import { logErrorEvent } from '../common/tracing'

interface Connection {
    reader: MessageReader
    writer: MessageWriter
}

type RequestId = string | number

type RequestHandler<P, R> = (params: P, token: CancellationToken, span: Span) => PromiseLike<R>

// Aliases because vscode-jsonrpc's interfaces are weird.
export type RequestType<P, R> = RequestType1<P, R, any, any>
export type NotificationType<P> = NotificationType1<P, any>

export interface Dispatcher {
    observeNotification<P>(type: NotificationType<P>): Observable<P>
    setRequestHandler<P, R>(type: RequestType<P, R>, handler: RequestHandler<P, R>): void
    dispose(): void
}

export const createRequestDurationMetric = () =>
    new prometheus.Histogram({
        name: 'jsonrpc_request_duration_seconds',
        help: 'The JSON RPC request latencies in seconds',
        labelNames: ['success', 'method'],
        buckets: [0.1, 0.2, 0.5, 0.8, 1, 1.5, 2, 5, 10, 15, 20, 30],
    })

/**
 * Alternative dispatcher to vscode-jsonrpc that supports OpenTracing and Observables
 */
export function createDispatcher(
    client: Connection,
    {
        tags,
        tracer,
        logger,
        requestDurationMetric,
    }: {
        /** Tags to set on every Span */
        tags: Record<string, any>
        tracer: Tracer
        logger: Logger
        /**
         * Optional prometheus metric that request durations will be logged to.
         * Must have labels `success` and `method`.
         *
         * @see createRequestDurationMetric
         */
        requestDurationMetric?: prometheus.Histogram
    }
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
            const stopTimer = requestDurationMetric && requestDurationMetric.startTimer()
            let success: boolean
            const childOf = tracer.extract(FORMAT_TEXT_MAP, message.params) || undefined
            const span = tracer.startSpan('Handle ' + message.method, { tags, childOf })
            span.setTag('method', message.method)
            if (isRequestMessage(message)) {
                span.setTag('id', message.id)
            }
            const cancellationTokenSource = new CancellationTokenSource()
            cancellationTokenSources.set(message.id, cancellationTokenSource)
            const token = cancellationTokenSource.token
            let response: ResponseMessage | undefined
            try {
                const handler = handlers.get(message.method)
                if (!handler) {
                    throw Object.assign(new Error('No handler for method ' + message.method), {
                        code: ErrorCodes.MethodNotFound,
                    })
                }
                const result = await Promise.resolve(handler(message.params, token, span))
                success = true
                response = {
                    jsonrpc: '2.0',
                    id: message.id,
                    result,
                }
            } catch (err) {
                span.setTag(ERROR, true)
                success = false
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
                    response = {
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
                }
            } finally {
                cancellationTokenSources.delete(message.id)
                span.finish()
            }
            if (response) {
                client.writer.write(response)
            }
            if (stopTimer) {
                stopTimer({ success: success + '', method: message.method })
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
