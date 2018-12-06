import * as fs from 'mz/fs'
import { Span, Tracer } from 'opentracing'
import fetchPackageJson from 'package-json'
import * as semver from 'semver'
import { CancellationToken } from 'vscode-jsonrpc'
import { throwIfCancelled } from './cancellation'
import { Logger } from './logging'
import { ResourceNotFoundError, ResourceRetrieverPicker } from './resources'
import { logErrorEvent, tracePromise } from './tracing'

/**
 * Checks if a dependency from a package.json should be installed or not by checking whether it contains TypeScript typings.
 */
function hasTypes(name: string, range: string, tracer: Tracer, span?: Span): Promise<boolean> {
    return tracePromise('Fetch package metadata', tracer, span, async span => {
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
 * @return Whether the package.json contained any dependencies
 */
export async function filterDependencies(
    packageJsonPath: string,
    { logger, tracer, span, token }: { logger: Logger; tracer: Tracer; span?: Span; token: CancellationToken }
): Promise<boolean> {
    return await tracePromise('Filter dependencies', tracer, span, async span => {
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
                        throwIfCancelled(token)
                        try {
                            if (name.startsWith('@types/') || (await hasTypes(name, range, tracer, span))) {
                                included.push(name)
                            } else {
                                excluded.push(name)
                                dependencies[name] = undefined!
                            }
                        } catch (err) {
                            logger.error(`Error inspecting dependency ${name}@${range} in ${packageJsonPath}`, err)
                            logErrorEvent(span, err)
                        }
                    })
                )
            })
        )
        span.setTag('excluded', excluded.length)
        span.setTag('included', included.length)
        logger.log('Excluding dependencies', excluded.join(', '))
        logger.log('Keeping dependencies', included.join(', '))
        // Only write if there is any change to dependencies
        if (included.length > 0 && excluded.length > 0) {
            await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2))
        }
        return included.length > 0
    })
}

export interface PackageJson {
    name: string
    version: string
    repository?:
        | string
        | {
              type: string
              url: string

              /**
               * https://github.com/npm/rfcs/blob/d39184cdedc000aa8e60b4d63878b834aa5f0ff0/accepted/0000-monorepo-subdirectory-declaration.md
               */
              directory?: string
          }
    /** Commit SHA1 of the repo at the time of publishing */
    gitHead?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
}

/**
 * Finds the closest package.json for a given URL.
 *
 * @param resource The URL from which to walk upwards.
 * @param rootUri A URL at which to stop searching. If not given, defaults to the root of the resource URL.
 */
export async function findClosestPackageJson(
    resource: URL,
    pickResourceRetriever: ResourceRetrieverPicker,
    rootUri: URL = Object.assign(new URL(resource.href), { pathname: '' })
): Promise<[URL, PackageJson]> {
    let parent = resource
    while (true) {
        if (!parent.href.startsWith(rootUri.href)) {
            throw new Error(`No package.json found for ${resource} under root ${rootUri}`)
        }
        const packageJsonUri = new URL('package.json', parent.href)
        try {
            const packageJson = await readPackageJson(packageJsonUri, pickResourceRetriever)
            return [packageJsonUri, packageJson]
        } catch (err) {
            if (err instanceof ResourceNotFoundError) {
                parent = new URL('..', parent.href)
                continue
            }
            throw err
        }
    }
}

export async function readPackageJson(
    pkgJsonUri: URL,
    pickResourceRetriever: ResourceRetrieverPicker
): Promise<PackageJson> {
    return JSON.parse(await pickResourceRetriever(pkgJsonUri).fetch(pkgJsonUri))
}

/**
 * @param filePath e.g. `/foo/node_modules/pkg/dist/bar.ts`
 * @returns e.g. `foo/node_modules/pkg`
 */
export function resolveDependencyRootDir(filePath: string): string {
    const parts = filePath.split('/')
    while (
        parts.length > 0 &&
        !(
            parts[parts.length - 2] === 'node_modules' ||
            (parts[parts.length - 3] === 'node_modules' && parts[parts.length - 2].startsWith('@'))
        )
    ) {
        parts.pop()
    }
    return parts.join('/')
}
