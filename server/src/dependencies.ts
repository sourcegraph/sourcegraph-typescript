import * as fs from 'mz/fs'
import { Span } from 'opentracing'
import fetchPackageJson from 'package-json'
import * as semver from 'semver'
import { Logger } from './logging'
import { tracePromise } from './tracing'

/**
 * Checks if a dependency from a package.json should be installed or not by checking whether it contains TypeScript typings.
 */
function hasTypes(name: string, range: string, span: Span): Promise<boolean> {
    return tracePromise('Fetch package metadata', span, async span => {
        span.setTag('name', name)
        const version = semver.validRange(range) || 'latest'
        span.setTag('version', version)
        const dependencyPackageJson: any = await fetchPackageJson(name, { version, fullMetadata: true })
        // Keep packages only if they have a types or typings field
        return !!dependencyPackageJson.typings || !!dependencyPackageJson.types
    })
}

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
        const excluded: string[] = []
        const included: string[] = []
        await Promise.all(
            ['dependencies', 'devDependencies', 'optionalDependencies'].map(async dependencyType => {
                const dependencies: { [name: string]: string } = packageJson[dependencyType]
                if (!dependencies) {
                    return
                }
                await Promise.all(
                    Object.entries(dependencies).map(async ([name, range]) => {
                        try {
                            if (name.startsWith('@types/') || (await hasTypes(name, range, span))) {
                                included.push(name)
                            } else {
                                excluded.push(name)
                                dependencies[name] = undefined!
                            }
                        } catch (err) {
                            logger.error(`Error inspecting dependency ${name}@${range} in ${packageJsonPath}`, err)
                            span.log({ event: 'error', 'error.object': err, stack: err.stack, message: err.message })
                        }
                    })
                )
            })
        )
        logger.log('Excluding dependencies', excluded.join(', '))
        logger.log('Keeping dependencies', included.join(', '))
        span.setTag('excluded', excluded.length)
        span.setTag('included', included.length)
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2))
    })
}
