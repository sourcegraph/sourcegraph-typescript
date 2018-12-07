import glob from 'globby'
import JSON5 from 'json5'
import { readFile, writeFile } from 'mz/fs'
import { Span, Tracer } from 'opentracing'
import { CancellationToken } from 'vscode-jsonrpc'
import { throwIfCancelled } from './cancellation'
import { Logger } from './logging'
import { logErrorEvent, tracePromise } from './tracing'

export async function sanitizeTsConfigs({
    cwd,
    tracer,
    span,
    token,
    logger,
}: {
    cwd: string
    tracer: Tracer
    span?: Span
    logger: Logger
    token: CancellationToken
}): Promise<void> {
    throwIfCancelled(token)
    await tracePromise('Sanitize tsconfig.jsons', tracer, span, async span => {
        const tsconfigPaths = await glob('**/tsconfig.json', { cwd, absolute: true })
        span.setTag('count', tsconfigPaths.length)
        await Promise.all(
            tsconfigPaths.map(async tsConfigPath => {
                throwIfCancelled(token)
                let json: string | undefined
                try {
                    json = await readFile(tsConfigPath, 'utf-8')
                    const tsconfig = JSON5.parse(json)
                    if (tsconfig && tsconfig.compilerOptions && tsconfig.compilerOptions.plugins) {
                        // Remove plugins for security reasons (they get loaded from node_modules)
                        tsconfig.compilerOptions.plugins = undefined
                        await writeFile(tsConfigPath, JSON.stringify(tsconfig))
                    }
                } catch (err) {
                    throwIfCancelled(token)
                    logger.error('Error sanitizing tsconfig.json at', tsConfigPath, json, err)
                    logErrorEvent(span, err)
                }
            })
        )
    })
}
