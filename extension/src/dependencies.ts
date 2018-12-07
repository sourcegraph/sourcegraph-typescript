import { resolveRepository, search } from './graphql'
import { SourcegraphInstanceOptions } from './graphql'

export async function fetchPackageMeta(packageName: string, version = 'latest'): Promise<PackageJson> {
    const response = await fetch(
        `https://cors-anywhere.sourcegraph.com/https://registry.npmjs.org/${packageName}/${version}`
    )
    if (!response.ok) {
        throw new Error(response.statusText)
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
    options: SourcegraphInstanceOptions
): AsyncIterable<string> {
    console.log(`Searching for dependents of package "${packageName}" through npm`)
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
        url.searchParams.set('skip', skip + '')
        const response = await fetch(url.href)
        const result: NpmCouchDBQueryResult = await response.json()
        if (result.rows.length === 0) {
            console.log(`Found ${seenRepos.size} dependent repos of "${packageName}"`)
            return
        }
        for (const row of result.rows) {
            const dependentPackageName = row.key[1]
            try {
                const packageMeta = await fetchPackageMeta(dependentPackageName)
                const repoName = await resolvePackageNameToRepoName(packageMeta, options)
                if (!seenRepos.has(repoName)) {
                    seenRepos.add(repoName)
                    yield repoName
                }
            } catch (err) {
                console.error(
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
export async function* findPackageDependentsWithSourcegraph(
    packageName: string,
    options: SourcegraphInstanceOptions
): AsyncIterable<string> {
    console.log(`Searching for dependents of ${packageName} through Sourcegraph`)
    const results = await search(`file:package.json$ ${packageName} max:1000`, options)
    const seenRepos = new Set<string>()
    for (const result of results) {
        const repoName = result.repository.name
        if (!seenRepos.has(repoName)) {
            seenRepos.add(repoName)
            yield repoName
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
    rootUri: URL = Object.assign(new URL(resource.href), { pathname: '' })
): Promise<[URL, PackageJson]> {
    let parent = new URL(resource.href)
    const headers = new Headers()
    // Browsers don't allow using fetch on URLs with auth info in the URL
    if (parent.username) {
        headers.set('Authorization', 'token ' + parent.username)
    }
    parent.username = ''
    rootUri = new URL(rootUri.href)
    rootUri.username = ''
    while (true) {
        if (!parent.href.startsWith(rootUri.href)) {
            throw new Error(`No package.json found for ${resource} under root ${rootUri}`)
        }
        const packageJsonUri = new URL('package.json', parent.href)
        const response = await fetch(packageJsonUri.href)
        if (response.status === 404) {
            parent = new URL('..', parent.href)
            continue
        } else if (!response.ok) {
            throw new Error(response.statusText)
        }
        return [packageJsonUri, await response.json()]
    }
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
    sgInstanceOptions: SourcegraphInstanceOptions
): Promise<string> {
    const cloneUrl = cloneUrlFromPackageMeta(packageMeta)
    const repoName = await resolveRepository(cloneUrl, sgInstanceOptions)
    return repoName
}
