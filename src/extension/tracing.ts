import { FORMAT_HTTP_HEADERS, Span, Tracer } from 'opentracing'
import { HTTP_METHOD, HTTP_STATUS_CODE, HTTP_URL } from 'opentracing/lib/ext/tags'
import { redact } from '../common/logging'

export async function tracedFetch(
    url: string | URL,
    { headers = {}, tracer, span, ...init }: RequestInit & { tracer: Tracer; span: Span }
) {
    span.setTag(HTTP_URL, redact(url.toString()))
    span.setTag(HTTP_METHOD, init.method || 'GET')
    tracer.inject(span, FORMAT_HTTP_HEADERS, headers)
    const response = await fetch(url.toString(), { ...init, headers })
    span.setTag(HTTP_STATUS_CODE, response.status)
    return response
}
