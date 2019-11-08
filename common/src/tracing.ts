import { FORMAT_TEXT_MAP, Span, SpanContext, Tracer } from 'opentracing'
import { ERROR, SPAN_KIND, SPAN_KIND_RPC_CLIENT } from 'opentracing/lib/ext/tags'
import { CancellationToken, MessageConnection, NotificationType1, RequestType1 } from 'vscode-jsonrpc'

export const canGenerateTraceUrl = (val: any): val is { generateTraceURL(): string } =>
    typeof val === 'object' && val !== null && typeof val.generateTraceURL === 'function'

/**
 * Traces a synchronous function by passing it a new child span.
 * The span is finished when the function returns.
 * If the function throws an Error, it is logged and the `error` tag set.
 *
 * @param operationName The operation name for the new span
 * @param childOf The parent span
 * @param operation The function to call
 */
export function traceSync<T>(
    operationName: string,
    tracer: Tracer,
    childOf: Span | undefined,
    operation: (span: Span) => T
): T {
    const span = tracer.startSpan(operationName, { childOf })
    try {
        return operation(span)
    } catch (err) {
        span.setTag(ERROR, true)
        logErrorEvent(span, err)
        throw err
    } finally {
        span.finish()
    }
}

/**
 * Traces a Promise-returning (or async) function by passing it a new child span.
 * The span is finished when the Promise is resolved.
 * If the Promise is rejected, the Error is logged and the `error` tag set.
 *
 * @param operationName The operation name for the new span
 * @param tracer OpenTracing tracer
 * @param childOf The parent span
 * @param operation The function to call
 */
export async function tracePromise<T>(
    operationName: string,
    tracer: Tracer,
    childOf: Span | SpanContext | undefined,
    operation: (span: Span) => Promise<T>
): Promise<T> {
    const span = tracer.startSpan(operationName, { childOf })
    try {
        return await operation(span)
    } catch (err) {
        span.setTag(ERROR, true)
        logErrorEvent(span, err)
        throw err
    } finally {
        span.finish()
    }
}

/**
 * Traces a Promise-returning (or async) function by passing it a new child span.
 * The span is finished when the Promise is resolved.
 * If the Promise is rejected, the Error is logged and the `error` tag set.
 *
 * @param operationName The operation name for the new span
 * @param tracer OpenTracing tracer
 * @param childOf The parent span
 * @param operation The function to call
 */
export async function* traceAsyncGenerator<T>(
    operationName: string,
    tracer: Tracer,
    childOf: Span | undefined,
    asyncGenerator: (span: Span) => AsyncIterable<T>
): AsyncIterable<T> {
    const span = tracer.startSpan(operationName, { childOf })
    try {
        yield* asyncGenerator(span)
    } catch (err) {
        span.setTag(ERROR, true)
        logErrorEvent(span, err)
        throw err
    } finally {
        span.finish()
    }
}

export function logErrorEvent(span: Span, err: Error): void {
    span.log({ event: ERROR, 'error.object': err, stack: err.stack, message: err.message })
}

// Aliases because vscode-jsonrpc's interfaces are weird.
export type RequestType<P, R> = RequestType1<P, R, any, any>
export type NotificationType<P> = NotificationType1<P, any>

/**
 * Sends an LSP request traced with OpenTracing
 */
export async function sendTracedRequest<P, R>(
    connection: Pick<MessageConnection, 'sendRequest'>,
    type: RequestType<P, R>,
    params: P,
    { span, tracer, token }: { span: Span; tracer: Tracer; token: CancellationToken }
): Promise<R> {
    return await tracePromise(
        `Request ${type.method}`,
        tracer,
        {
            childOf: span,
            tags: {
                [SPAN_KIND]: SPAN_KIND_RPC_CLIENT,
            },
        },
        async span => {
            tracer.inject(span, FORMAT_TEXT_MAP, params)
            return await connection.sendRequest(type, params, token)
        }
    )
}
