declare module 'lightstep-tracer' {
    import SpanImp from 'lightstep-tracer/lib/imp/span_imp'
    import * as opentracing from 'opentracing'

    export interface TracerOptions {
        /** the project access token */
        access_token: string

        /** the string identifier for the application, service, or process */
        component_name: string

        /**
         * controls the level of logging to the console
         *
         * - 0 - the client library will never log to the console
         * - 1 - error reporting will be throttled to the first error per minute
         * - 2 - all errors are logged to the console
         * - 3 - all errors, warnings, and info statements are logged to the console
         * - 4 - all log statements, including debugging details
         *
         * @default 1
         */
        verbosity?: number

        /** custom collector hostname */
        collector_host?: string

        /** custom collector port */

        collector_port?: number
        /** custom collector base path (if served behind a reverse proxy) */
        collector_path?: string
    }

    export class Tracer extends opentracing.Tracer {
        constructor(options: TracerOptions)

        public startSpan(name: string, options?: opentracing.SpanOptions): SpanImp
    }
}

declare module 'lightstep-tracer/lib/imp/span_imp' {
    import * as opentracing from 'opentracing'
    export default class SpanImp extends opentracing.Span {
        public generateTraceURL(): string
    }
}
