import { inspect } from 'util'
import { MessageConnection } from 'vscode-jsonrpc'
import { LogMessageNotification, MessageType } from 'vscode-languageserver-protocol'

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

/**
 * Formats values to a message by pretty-printing objects
 */
function format(values: any[]): string {
    return values.map(value => (typeof value === 'string' ? value : inspect(value, { depth: Infinity }))).join(' ')
}

export const LOG_LEVEL_TO_LSP: Record<LogLevel, MessageType> = {
    log: MessageType.Log,
    info: MessageType.Info,
    warn: MessageType.Warning,
    error: MessageType.Error,
}

export const LSP_TO_LOG_LEVEL: Record<MessageType, LogLevel> = {
    [MessageType.Log]: 'log',
    [MessageType.Info]: 'info',
    [MessageType.Warning]: 'warn',
    [MessageType.Error]: 'error',
}

/**
 * Removes auth info from URLs
 */
export const redact = (message: string): string => message.replace(/([\w+]+:\/\/)[^@]+@([^\s$]+)/g, '$1$2')

/**
 * Logger that formats the logged values and removes any auth info in URLs.
 */
export class RedactingLogger extends AbstractLogger {
    constructor(private logger: Logger) {
        super()
    }

    public logType(type: LogLevel, values: any[]): void {
        // TODO ideally this would not format the value to a string before redacting,
        // because that prevents expanding objects in devtools
        this.logger[type](redact(format(values)))
    }
}

/**
 * A logger implementation that sends window/logMessage notifications to an LSP client
 */
export class LSPLogger extends AbstractLogger {
    /**
     * @param client The client to send window/logMessage notifications to
     */
    constructor(private client: MessageConnection) {
        super()
    }

    protected logType(type: LogLevel, values: any[]): void {
        try {
            this.client.sendNotification(LogMessageNotification.type, {
                type: LOG_LEVEL_TO_LSP[type],
                message: format(values),
            })
        } catch (err) {
            // ignore
        }
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

export class MultiLogger extends AbstractLogger {
    constructor(private loggers: Logger[]) {
        super()
    }

    protected logType(type: LogLevel, values: any[]): void {
        for (const logger of this.loggers) {
            logger[type](...values)
        }
    }
}
