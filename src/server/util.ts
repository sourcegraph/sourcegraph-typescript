import { Logger } from '../common/logging'

export function tryLogError(logger: Logger, func: () => void): void {
    try {
        func()
    } catch (err) {
        logger.error(err)
    }
}
