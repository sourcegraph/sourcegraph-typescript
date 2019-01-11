import { SourcegraphEndpoint } from './util'

/**
 * @param textDocumentUri The Sourcegraph text document URI, e.g. `git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts`
 * @returns The root URI for the server, e.g. `https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/`. Always has a trailing slash.
 */
export function resolveServerRootUri(textDocumentUri: URL, sgEndpoint: SourcegraphEndpoint): URL {
    const rootUri = new URL(sgEndpoint.url.href)
    if (sgEndpoint.accessToken) {
        rootUri.username = sgEndpoint.accessToken
    }
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
export function toServerTextDocumentUri(textDocumentUri: URL, sgEndpoint: SourcegraphEndpoint): URL {
    if (textDocumentUri.protocol !== 'git:') {
        throw new Error('Not a Sourcegraph git:// URI: ' + textDocumentUri)
    }
    const rootUri = resolveServerRootUri(textDocumentUri, sgEndpoint)
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
