import * as sourcegraph from 'sourcegraph'
import { Configuration } from './config'

/**
 * The root URI for the server, e.g. `https://sourcegraph.com`. This can be
 * overridden by setting `sourcegraph.url`, which is useful for Docker
 * deployments that must access the Sourcegraph instance on
 * `http://host.docker.internal:7080` instead of `http://localhost:7080`.
 */
export function serverRootUri() {
    return (
        sourcegraph.configuration.get<Configuration>().get('sourcegraph.url') ||
        sourcegraph.internal.sourcegraphURL.toString()
    )
}

/**
 * @param textDocumentUri The Sourcegraph text document URI, e.g. `git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts`
 * @returns The root URI for the server, e.g. `https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/`. Always has a trailing slash.
 */
export function resolveServerRootUri(textDocumentUri: URL): URL {
    const rootUri = new URL(serverRootUri())
    // rootUri.username = accessToken
    rootUri.pathname =
        [textDocumentUri.host + textDocumentUri.pathname, textDocumentUri.search.substr(1)].filter(Boolean).join('@') +
        '/-/raw/'
    return rootUri
}

/**
 * @param textDocumentUri The Sourcegraph text document URI like git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
 * @returns The text document URI for the server, e.g. https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/src/schema/graphqlschema.ts
 */
export function toServerTextDocumentUri(textDocumentUri: URL): URL {
    if (textDocumentUri.protocol !== 'git:') {
        throw new Error('Not a Sourcegraph git:// URI: ' + textDocumentUri)
    }
    const rootUri = resolveServerRootUri(textDocumentUri)
    const serverTextDocumentUri = new URL(textDocumentUri.hash.substr(1), rootUri.href)
    return serverTextDocumentUri
}

/**
 * @param serverTextDocumentUri The text document URI for the server, e.g. https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/src/schema/graphqlschema.ts
 * @returns The Sourcegraph text document URI, e.g. git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
 */
export function toSourcegraphTextDocumentUri(serverTextDocumentUri: URL): URL {
    const { repoName, rev, filePath } = parseSourcegraphRawUrl(serverTextDocumentUri)
    const sourcegraphUri = new URL(`git://${repoName}`)
    if (rev) {
        sourcegraphUri.search = rev
    }
    sourcegraphUri.hash = filePath
    return sourcegraphUri
}

export interface RawUrl {
    /** Example: `github.com/sourcegraph/sourcegraph */
    repoName: string

    /** Example: `master` or `80389224bd48e1e696d5fa11b3ec6fba341c695b` */
    rev?: string

    /** Example: `src/schema/graphql.ts` */
    filePath: string
}

/**
 * Parses a URL of the Sourcegraph raw API
 */
export function parseSourcegraphRawUrl(rawUrl: URL): RawUrl {
    const match = rawUrl.pathname.match(/^\/([^@]+)(?:@([^\/]+))?\/-\/raw\/(.*)$/)
    if (!match) {
        throw new Error('Not a Sourcegraph raw API URL: ' + rawUrl)
    }
    const [, repoName, rev, filePath] = match as [string, string, string | undefined, string]
    return { repoName, rev, filePath }
}

/**
 * Rewrites all `uri` properties in an object, recursively
 */
export function rewriteUris(obj: any, transform: (uri: URL) => URL): void {
    // Scalar
    if (typeof obj !== 'object' || obj === null) {
        return
    }
    // Arrays
    if (Array.isArray(obj)) {
        for (const element of obj) {
            rewriteUris(element, transform)
        }
        return
    }
    // Object
    if ('uri' in obj) {
        obj.uri = transform(new URL(obj.uri)).href
    }
    for (const key of Object.keys(obj)) {
        rewriteUris(obj[key], transform)
    }
}
