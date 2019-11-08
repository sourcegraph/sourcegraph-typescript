import { MessageConnection } from 'vscode-jsonrpc'
import { LogMessageNotification } from 'vscode-languageserver-protocol'
import { AbstractLogger, format, LOG_LEVEL_TO_LSP, LogLevel } from '../../common/src/logging'

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

    protected logType(type: LogLevel, values: unknown[]): void {
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
