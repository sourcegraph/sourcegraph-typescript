import { inspect } from 'util'
import { MessageConnection } from 'vscode-jsonrpc'
import { LogMessageNotification, MessageType } from 'vscode-languageserver-protocol'

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

/**
 * Formats values to a message by pretty-printing objects
 */
function format(values: any[]): string {
    return values.map(value => (typeof value === 'string' ? value : inspect(value, { depth: Infinity }))).join(' ')
}

/**
 * A logger implementation that sends window/logMessage notifications to an LSP client
 */
export class LSPLogger implements Logger {
    /**
     * @param client The client to send window/logMessage notifications to
     */
    constructor(private client: MessageConnection) {}

    private logType(type: MessageType, values: any[]): void {
        try {
            this.client.sendNotification(LogMessageNotification.type, { type, message: format(values) })
        } catch (err) {
            // ignore
        }
    }

    public log(...values: any[]): void {
        this.logType(MessageType.Log, values)
    }

    public info(...values: any[]): void {
        this.logType(MessageType.Info, values)
    }

    public warn(...values: any[]): void {
        this.logType(MessageType.Warning, values)
    }

    public error(...values: any[]): void {
        this.logType(MessageType.Error, values)
    }
}
