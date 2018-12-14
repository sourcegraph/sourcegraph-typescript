import { inspect } from 'util'
import { MessageType } from 'vscode-languageserver-protocol'

export type LogLevel = 'error' | 'warn' | 'info' | 'log'
export type Logger = Record<LogLevel, (...values: any[]) => void>

abstract class AbstractLogger implements Logger {
    protected abstract logType(type: LogLevel, values: any[]): void

    public log(...values: any[]): void {
        this.logType('log', values)
    }

    public info(...values: any[]): void {
        this.logType('info', values)
    }

    public warn(...values: any[]): void {
        this.logType('warn', values)
    }

    public error(...values: any[]): void {
        this.logType('error', values)
    }
}

/**
 * Logger implementation that does nothing
 */
export class NoopLogger extends AbstractLogger {
    protected logType(): void {
        // noop
    }
}

export const LSP_TO_LOG_LEVEL: Record<MessageType, LogLevel> = {
    [MessageType.Log]: 'log',
    [MessageType.Info]: 'info',
    [MessageType.Warning]: 'warn',
    [MessageType.Error]: 'error',
}

/**
 * Formats values to a message by pretty-printing objects
 */
const format = (value: any): string => (typeof value === 'string' ? value : inspect(value, { depth: Infinity }))

/**
 * Removes auth info from URLs
 */
export const redact = (message: string): string => message.replace(/(https?:\/\/)[^@\/]+@([^\s$]+)/g, '$1$2')

/**
 * Logger that formats the logged values and removes any auth info in URLs.
 */
export class RedactingLogger extends AbstractLogger {
    constructor(private logger: Logger) {
        super()
    }

    protected logType(type: LogLevel, values: any[]): void {
        // TODO ideally this would not format the value to a string before redacting,
        // because that prevents expanding objects in devtools
        this.logger[type](...values.map(value => redact(format(value))))
    }
}

export class PrefixedLogger extends AbstractLogger {
    constructor(private logger: Logger, private prefix: string) {
        super()
    }

    protected logType(type: LogLevel, values: any[]): void {
        this.logger[type](`[${this.prefix}]`, ...values)
    }
}
