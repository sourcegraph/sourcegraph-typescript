import * as fs from 'mz/fs'
import { Span } from 'opentracing'
import fetchPackageJson from 'package-json'
import * as semver from 'semver'
import { Logger } from './logging'
import { tracePromise } from './tracing'

/**
 * Removes all dependencies from a package.json that do not contain TypeScript type declaration files.
 *
 * @param packageJsonPath File path to a package.json
 */
export async function filterDependencies(packageJsonPath: string, logger: Logger, span: Span): Promise<void> {
    await tracePromise('Filter dependencies', span, async span => {
        span.setTag('packageJsonPath', packageJsonPath)
        logger.log('Filtering package.json at ', packageJsonPath)
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
        await Promise.all(
            ['dependencies', 'devDependencies', 'optionalDependencies'].map(async dependencyType => {
                const dependencies: { [name: string]: string } = packageJson[dependencyType]
                if (!dependencies) {
                    return
                }
                await Promise.all(
                    Object.entries(dependencies).map(async ([name, range]) => {
                        try {
                            // Keep all @types/ packages
                            if (name.startsWith('@types/')) {
                                return
                            }
                            // Keep other packages only if they have a types or typings field
                            const dependencyPackageJson: any = await fetchPackageJson(name, {
                                version: semver.validRange(range) || 'latest',
                                fullMetadata: true,
                            })
                            if (!dependencyPackageJson.typings && !dependencyPackageJson.types) {
                                logger.log('Excluding dependency', name)
                                dependencies[name] = undefined!
                            }
                        } catch (err) {
                            logger.error(`Error inspecting dependency ${name}@${range} in ${packageJsonPath}`, err)
                        }
                    })
                )
            })
        )
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2))
    })
}
