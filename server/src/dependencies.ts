import * as fs from 'mz/fs'
import npmFetch, { NpmOptions } from 'npm-registry-fetch'
import { Span, Tracer } from 'opentracing'
import * as semver from 'semver'
import { CancellationToken } from 'vscode-jsonrpc'
import { throwIfCancelled } from './cancellation'
import { Logger } from './logging'
import { ResourceNotFoundError, ResourceRetrieverPicker } from './resources'
import { logErrorEvent, tracePromise } from './tracing'

export async function fetchPackageMeta(
    packageName: string,
    versionSpec = 'latest',
    npmConfig: NpmOptions
): Promise<PackageJson> {
    const options = { ...npmConfig, spec: packageName }
    if (!packageName.startsWith('@') && (versionSpec === 'latest' || semver.valid(versionSpec))) {
        // Request precise version
        const result = await npmFetch.json(`/${packageName}/${versionSpec}`, options)
        return result
    }
    // Resolve version
    const result = await npmFetch.json(`/${packageName}`, options)
    if (result.versions[result['dist-tags'][versionSpec]]) {
        return result.versions[result['dist-tags'][versionSpec]]
    }
    const versions = Object.keys(result.versions)
    const version = semver.maxSatisfying(versions, versionSpec)
    if (!version) {
        throw new Error(`Version ${packageName}@${versionSpec} does not exist`)
    }
    return result.versions[version]
}

/**
 * Checks if a dependency from a package.json should be installed or not by checking whether it contains TypeScript typings.
 */
function hasTypes(name: string, range: string, npmConfig: NpmOptions, tracer: Tracer, span?: Span): Promise<boolean> {
    return tracePromise('Fetch package metadata', tracer, span, async span => {
        span.setTag('name', name)
        const version = semver.validRange(range) || 'latest'
        span.setTag('version', version)
        const dependencyPackageJson = await fetchPackageMeta(name, version, npmConfig)
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
    {
        npmConfig,
        logger,
        tracer,
        span,
        token,
    }: {
        npmConfig: NpmOptions
        logger: Logger
        tracer: Tracer
        span?: Span
        token: CancellationToken
    }
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
                            if (name.startsWith('@types/') || (await hasTypes(name, range, npmConfig, tracer, span))) {
                                included.push(name)
                            } else {
                                excluded.push(name)
                                dependencies[name] = undefined!
                            }
                        } catch (err) {
                            throwIfCancelled(token)
                            included.push(name)
                            logger.error(`Error inspecting dependency ${name}@${range} in ${packageJsonPath}`, err)
                            logErrorEvent(span, err)
                        }
                    })
                )
            })
        )
        span.setTag('excluded', excluded.length)
        span.setTag('included', included.length)
        logger.log(`Excluding ${excluded.length} dependencies`)
        logger.log(`Keeping ${included.length} dependencies`)
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
    types?: string
    typings?: string
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
    rootUri = Object.assign(new URL(resource.href), { pathname: '' }),
    {
        span = new Span(),
        tracer = new Tracer(),
    }: {
        span?: Span
        tracer?: Tracer
    } = {}
): Promise<[URL, PackageJson]> {
    return await tracePromise(
        'Find closest package.json',
        tracer,
        span,
        async (span): Promise<[URL, PackageJson]> => {
            let parent = resource
            while (true) {
                if (!parent.href.startsWith(rootUri.href)) {
                    throw new Error(`No package.json found for ${resource} under root ${rootUri}`)
                }
                const packageJsonUri = new URL('package.json', parent.href)
                try {
                    const packageJson = await readPackageJson(packageJsonUri, pickResourceRetriever, { span, tracer })
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
    )
}

export const isDefinitelyTyped = (uri: URL): boolean => uri.pathname.includes('DefinitelyTyped/DefinitelyTyped')

/**
 * Finds the package name and package root that the given URI belongs to.
 * Handles special repositories like DefinitelyTyped.
 */
export async function findPackageRootAndName(
    uri: URL,
    pickResourceRetriever: ResourceRetrieverPicker,
    { span, tracer }: { span: Span; tracer: Tracer }
): Promise<[URL, string]> {
    // Special case: if the definition is in DefinitelyTyped, the package name is @types/<subfolder>[/<version>]
    if (isDefinitelyTyped(uri)) {
        const dtMatch = uri.pathname.match(/\/types\/([^\/]+)\//)
        if (dtMatch) {
            const packageRoot = new URL(uri.href)
            // Strip everything after types/ (except the optional version directory)
            packageRoot.pathname = packageRoot.pathname.replace(/\/types\/([^\/]+)\/(v[^\/]+\/)?.*$/, '/types/$1/$2')
            const packageName = '@types/' + dtMatch[1]
            return [packageRoot, packageName]
        }
    }
    // Find containing package
    const [packageJsonUrl, packageJson] = await findClosestPackageJson(uri, pickResourceRetriever, undefined, {
        span,
        tracer,
    })
    if (!packageJson.name) {
        throw new Error(`package.json at ${packageJsonUrl} does not contain a name`)
    }
    const packageRoot = new URL('.', packageJsonUrl)
    return [packageRoot, packageJson.name]
}

export async function readPackageJson(
    pkgJsonUri: URL,
    pickResourceRetriever: ResourceRetrieverPicker,
    options: { span: Span; tracer: Tracer }
): Promise<PackageJson> {
    return JSON.parse(await pickResourceRetriever(pkgJsonUri).fetch(pkgJsonUri, options))
}

export function cloneUrlFromPackageMeta(packageMeta: PackageJson): string {
    if (!packageMeta.repository) {
        throw new Error('Package data does not contain repository field')
    }
    let repoUrl = typeof packageMeta.repository === 'string' ? packageMeta.repository : packageMeta.repository.url
    // GitHub shorthand
    if (/^[^\/]+\/[^\/]+$/.test(repoUrl)) {
        repoUrl = 'https://github.com/' + repoUrl
    }
    return repoUrl
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
