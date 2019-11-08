import { Span, Tracer } from 'opentracing'
import { Logger, redact } from '../../common/src/logging'
import { logErrorEvent, tracePromise } from '../../common/src/tracing'
import { queryExtensions, resolveRepository, search } from './graphql'
import { tracedFetch } from './tracing'
import { SourcegraphEndpoint } from './util'

export async function fetchPackageMeta(
    packageName: string,
    version = 'latest',
    { span, tracer }: { span: Span; tracer: Tracer }
): Promise<PackageJson> {
    span.setTag('packageName', packageName)
    span.setTag('version', version)
    const response = await tracedFetch(
        `https://cors-anywhere.sourcegraph.com/https://registry.npmjs.com/${packageName}/${version}`,
        { tracer, span }
    )
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
    }
    const packageMeta = await response.json()
    return packageMeta
}

interface NpmCouchDBQueryResult {
    rows: {
        /**
         * 1. Package name of the dependee
         * 2. Package name of the dependent
         * 3. ~~Package description of the dependent~~
         */
        key: [string, string]
        value: 1
    }[]
}

/**
 * @returns AsyncIterable that yields Sourcegraph repository names
 */
export async function* findPackageDependentsWithNpm(
    packageName: string,
    sgEndpoint: SourcegraphEndpoint,
    { logger, tracer, span }: { logger: Logger; span: Span; tracer: Tracer }
): AsyncIterable<string> {
    span.setTag('packageName', packageName)
    logger.log(`Searching for dependents of package "${packageName}" through npm`)
    const limit = 100
    // Proxy through Sourcegraph because skimdb.npmjs.com does not send CORS headers
    // https://stackoverflow.com/questions/18796890/how-do-you-find-out-which-npm-modules-depend-on-yours
    const url = new URL(
        'https://cors-anywhere.sourcegraph.com/https://skimdb.npmjs.com/registry/_design/app/_view/dependedUpon'
    )
    url.searchParams.set('group_level', '2')
    url.searchParams.set('startkey', JSON.stringify([packageName]))
    url.searchParams.set('endkey', JSON.stringify([packageName, {}]))
    url.searchParams.set('limit', limit + '')
    const seenRepos = new Set<string>()
    for (let skip = 0; true; skip += limit) {
        span.log({ event: 'page', skip: 0 })
        url.searchParams.set('skip', skip + '')
        const response = await tracedFetch(url, { tracer, span })
        const result: NpmCouchDBQueryResult = await response.json()
        if (result.rows.length === 0) {
            logger.log(`Found ${seenRepos.size} dependent repos of "${packageName}"`)
            return
        }
        for (const row of result.rows) {
            const dependentPackageName = row.key[1]
            try {
                const packageMeta = await fetchPackageMeta(dependentPackageName, undefined, { tracer, span })
                const repoName = await resolvePackageNameToRepoName(packageMeta, sgEndpoint, { tracer, span })
                if (!seenRepos.has(repoName)) {
                    seenRepos.add(repoName)
                    yield repoName
                }
            } catch (err) {
                logErrorEvent(span, err)
                logger.error(
                    `Error resolving "${packageName}" dependent "${dependentPackageName}" to Sourcegraph repo`,
                    err
                )
            }
        }
    }
}

/**
 * @return AsyncIterable that yields Sourcegraph repository names
 */
export async function* findPackageDependentsWithSourcegraphSearch(
    packageName: string,
    sgEndpoint: SourcegraphEndpoint,
    { logger, span, tracer }: { logger: Logger; span: Span; tracer: Tracer }
): AsyncIterable<string> {
    span.setTag('packageName', packageName)
    logger.log(`Searching for dependents of ${packageName} through Sourcegraph`)
    const results = await search(`file:package.json$ ${packageName} max:1000`, sgEndpoint, { span, tracer })
    const seenRepos = new Set<string>()
    for (const result of results) {
        const repoName = result.repository.name
        if (!seenRepos.has(repoName)) {
            seenRepos.add(repoName)
            yield repoName
        }
    }
}

/**
 * @return AsyncIterable that yields Sourcegraph repository names
 */
export async function* findPackageDependentsWithSourcegraphExtensionRegistry(
    sgEndpoint: SourcegraphEndpoint,
    { logger, tracer, span }: { logger: Logger; tracer: Tracer; span: Span }
): AsyncIterable<string> {
    logger.log(`Searching for dependents to "sourcegraph" through Sourcegraph extension registry`)
    const extensions = await queryExtensions(sgEndpoint, { span, tracer })
    logger.log(`Found ${extensions.length} extensions`)
    const seenRepos = new Set<string>()
    for (const extension of extensions) {
        try {
            if (!extension || !extension.manifest || !extension.manifest.raw) {
                continue
            }
            const manifest = JSON.parse(extension.manifest.raw)
            const repoName = await resolvePackageNameToRepoName(manifest, sgEndpoint, { span, tracer })
            if (!seenRepos.has(repoName)) {
                seenRepos.add(repoName)
                yield repoName
            }
        } catch (err) {
            logErrorEvent(span, err)
            logger.error(`Error mapping extension "${extension.extensionID}" to Sourcegraph repo`, err)
        }
    }
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
}

/**
 * Finds the closest package.json for a given URL.
 *
 * @param resource The URL from which to walk upwards.
 * @param rootUri A URL at which to stop searching. If not given, defaults to the root of the resource URL.
 */
export async function findClosestPackageJson(
    resource: URL,
    {
        rootUri = Object.assign(new URL(resource.href), { pathname: '' }),
        tracer,
        span,
    }: {
        rootUri?: URL
        tracer: Tracer
        span: Span
    }
): Promise<[URL, PackageJson]> {
    return await tracePromise(
        'Find closest package.json',
        tracer,
        span,
        async (span): Promise<[URL, PackageJson]> => {
            span.setTag('uri', redact(resource.href))
            let parent = new URL(resource.href)
            const headers: Record<string, string> = {}
            // Browsers don't allow using fetch on URLs with auth info in the URL
            if (parent.username) {
                headers.Authorization = 'token ' + parent.username
            }
            parent.username = ''
            rootUri = new URL(rootUri.href)
            rootUri.username = ''
            while (true) {
                if (!parent.href.startsWith(rootUri.href) || parent.href === rootUri.href) {
                    throw new Error(`No package.json found for ${resource} under root ${rootUri}`)
                }
                const packageJsonUri = new URL('package.json', parent.href)
                const response = await tracedFetch(packageJsonUri, { headers, tracer, span })
                if (response.status === 404) {
                    parent = new URL('..', parent.href)
                    continue
                }
                if (!response.ok) {
                    throw new Error(`${response.status} ${response.statusText}`)
                }
                return [packageJsonUri, await response.json()]
            }
        }
    )
}

/**
 * Finds the package name that the given URI belongs to.
 */
export async function findPackageName(
    uri: URL,
    { logger, tracer, span }: { logger: Logger; tracer: Tracer; span: Span }
): Promise<string> {
    span.setTag('uri', redact(uri.href))
    // Special case: if the definition is in DefinitelyTyped, the package name is @types/<subfolder>
    if (uri.pathname.includes('DefinitelyTyped/DefinitelyTyped')) {
        const dtMatch = uri.pathname.match(/\/types\/([^\/]+)\//)
        if (dtMatch) {
            return '@types/' + dtMatch[1]
        }
        logger.warn(`Unexpected DefinitelyTyped URL ${uri}`)
    }
    // Special case: vscode.d.ts
    if (uri.pathname.endsWith('/vscode.d.ts')) {
        return 'vscode'
    }
    // Find containing package
    const [packageJsonUrl, packageJson] = await findClosestPackageJson(uri, { tracer, span })
    if (!packageJson.name) {
        throw new Error(`package.json at ${packageJsonUrl} does not contain a name`)
    }
    return packageJson.name
}

function cloneUrlFromPackageMeta(packageMeta: PackageJson): string {
    if (!packageMeta.repository) {
        throw new Error('Package data does not contain repository field')
    }
    if (typeof packageMeta.repository === 'string') {
        return packageMeta.repository
    }
    return packageMeta.repository.url
}

export async function resolvePackageNameToRepoName(
    packageMeta: PackageJson,
    sgEndpoint: SourcegraphEndpoint,
    { span, tracer }: { span: Span; tracer: Tracer }
): Promise<string> {
    const cloneUrl = cloneUrlFromPackageMeta(packageMeta)
    const repoName = await resolveRepository(cloneUrl, sgEndpoint, { span, tracer })
    return repoName
}
