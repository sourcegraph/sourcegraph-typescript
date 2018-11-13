import glob from 'globby'
import { readFile, writeFile } from 'mz/fs'
import { Span } from 'opentracing'
import * as path from 'path'
import stripJsonComments from 'strip-json-comments'
import { CancellationToken } from 'vscode-jsonrpc'
import { throwIfCancelled } from './cancellation'
import { Logger } from './logging'
import { logErrorEvent, tracePromise } from './tracing'

export async function sanitizeTsConfigs({
    cwd,
    span,
    token,
    logger,
}: {
    cwd: string
    span: Span
    logger: Logger
    token: CancellationToken
}): Promise<void> {
    throwIfCancelled(token)
    await tracePromise('Sanitize tsconfig.jsons', span, async span => {
        const tsconfigPaths = await glob('**/tsconfig.json', { cwd })
        logger.log('tsconfig.jsons found:', tsconfigPaths)
        span.setTag('count', tsconfigPaths.length)
        await Promise.all(
            tsconfigPaths.map(async relTsconfigPath => {
                throwIfCancelled(token)
                try {
                    const absTsconfigPath = path.join(cwd, relTsconfigPath)
                    const tsconfig = JSON.parse(stripJsonComments(await readFile(absTsconfigPath, 'utf-8')))
                    if (tsconfig && tsconfig.compilerOptions && tsconfig.compilerOptions.plugins) {
                        // Remove plugins for security reasons (they get loaded from node_modules)
                        tsconfig.compilerOptions.plugins = undefined
                        await writeFile(absTsconfigPath, JSON.stringify(tsconfig))
                    }
                } catch (err) {
                    logger.error('Error sanitizing tsconfig.json', relTsconfigPath, err)
                    logErrorEvent(span, err)
                }
            })
        )
    })
}
