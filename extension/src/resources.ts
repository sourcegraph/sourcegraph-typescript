import { FORMAT_HTTP_HEADERS, Span, Tracer } from 'opentracing'

export async function fetchResource(
    resource: URL,
    { span = new Span(), tracer = new Tracer() }: { span?: Span; tracer?: Tracer } = {}
): Promise<string> {
    const headers = {
        Accept: 'text/plain',
    }
    tracer.inject(span, FORMAT_HTTP_HEADERS, headers)
    const response = await fetch(resource.href, { headers })
    if (!response.ok) {
        throw new Error(`${response.statusText} ${resource.href}`)
    }
    return await response.text()
}
