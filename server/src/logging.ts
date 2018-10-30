export interface Logger {
    log(...values: any[]): void
    info(...values: any[]): void
    warn(...values: any[]): void
    error(...values: any[]): void
}

/**
 * Logger implementation that does nothing
 */
export class NoopLogger {
    public log(...values: any[]): void {
        // empty
    }

    public info(...values: any[]): void {
        // empty
    }

    public warn(...values: any[]): void {
        // empty
    }

    public error(...values: any[]): void {
        // empty
    }
}
