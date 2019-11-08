import JSON5 from 'json5'
import { writeFile } from 'mz/fs'
import { Span, Tracer } from 'opentracing'
import { fileURLToPath, URL } from 'url'
import { CancellationToken } from 'vscode-jsonrpc'
import { throwIfCancelled } from '../../common/src/cancellation'
import { flatMapConcurrent } from '../../common/src/ix'
import { Logger } from '../../common/src/logging'
import { logErrorEvent, tracePromise } from '../../common/src/tracing'
import { ResourceRetrieverPicker } from './resources'

export async function sanitizeTsConfigs({
    dir,
    pickResourceRetriever,
    tracer,
    span,
    token,
    logger,
}: {
    dir: URL
    pickResourceRetriever: ResourceRetrieverPicker
    tracer: Tracer
    span?: Span
    logger: Logger
    token: CancellationToken
}): Promise<void> {
    throwIfCancelled(token)
    await tracePromise('Sanitize tsconfig.jsons', tracer, span, async span => {
        const pattern = new URL('**/tsconfig.json', dir)
        flatMapConcurrent(pickResourceRetriever(pattern).glob(pattern), 10, async function*(
            tsconfigUri
        ): AsyncIterable<never> {
            throwIfCancelled(token)
            let json: string | undefined
            try {
                json = await pickResourceRetriever(tsconfigUri).fetch(tsconfigUri)
                const tsconfig = JSON5.parse(json)
                if (tsconfig && tsconfig.compilerOptions && tsconfig.compilerOptions.plugins) {
                    // Remove plugins for security reasons (they get loaded from node_modules)
                    tsconfig.compilerOptions.plugins = undefined
                    await writeFile(fileURLToPath(tsconfigUri), JSON.stringify(tsconfig))
                }
            } catch (err) {
                throwIfCancelled(token)
                logger.error('Error sanitizing tsconfig.json at', tsconfigUri, json, err)
                logErrorEvent(span, err)
            }
        })
    })
}
