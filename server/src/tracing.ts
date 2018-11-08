import { Span } from 'opentracing'

/**
 * Traces a synchronous function by passing it a new child span.
 * The span is finished when the function returns.
 * If the function throws an Error, it is logged and the `error` tag set.
 *
 * @param operationName The operation name for the new span
 * @param childOf The parent span
 * @param operation The function to call
 */
export function traceSync<T>(operationName: string, childOf: Span, operation: (span: Span) => T): T {
    const span = childOf.tracer().startSpan(operationName, { childOf })
    try {
        return operation(span)
    } catch (err) {
        span.setTag('error', true)
        span.log({ event: 'error', 'error.object': err, stack: err.stack, message: err.message })
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
 * @param childOf The parent span
 * @param operation The function to call
 */
export async function tracePromise<T>(
    operationName: string,
    childOf: Span,
    operation: (span: Span) => Promise<T>
): Promise<T> {
    const span = childOf.tracer().startSpan(operationName, { childOf })
    try {
        return await operation(span)
    } catch (err) {
        span.setTag('error', true)
        span.log({ event: 'error', 'error.object': err, stack: err.stack, message: err.message })
        throw err
    } finally {
        span.finish()
    }
}
