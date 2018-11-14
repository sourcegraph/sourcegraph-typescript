import glob from 'globby'
import { readFile, writeFile } from 'mz/fs'
import { Span } from 'opentracing'
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
        const tsconfigPaths = await glob('**/tsconfig.json', { cwd, absolute: true })
        logger.log('tsconfig.jsons found:', tsconfigPaths)
        span.setTag('count', tsconfigPaths.length)
        await Promise.all(
            tsconfigPaths.map(async tsConfigPath => {
                throwIfCancelled(token)
                let json: string | undefined
                try {
                    json = stripJsonComments(await readFile(tsConfigPath, 'utf-8'))
                    const tsconfig = JSON.parse(json)
                    if (tsconfig && tsconfig.compilerOptions && tsconfig.compilerOptions.plugins) {
                        // Remove plugins for security reasons (they get loaded from node_modules)
                        tsconfig.compilerOptions.plugins = undefined
                        await writeFile(tsConfigPath, JSON.stringify(tsconfig))
                    }
                } catch (err) {
                    logger.error('Error sanitizing tsconfig.json at', tsConfigPath, json, err)
                    logErrorEvent(span, err)
                }
            })
        )
    })
}
