import * as sourcegraph from 'sourcegraph'

/**
 * @param textDocumentUri The Sourcegraph text document URI, e.g. `git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts`
 * @returns The root URI for the server, e.g. `https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/`. Always has a trailing slash.
 */
export function resolveServerRootUri(textDocumentUri: URL): URL {
    const rootUri = new URL(sourcegraph.internal.sourcegraphURL.toString())
    // rootUri.username = accessToken
    rootUri.pathname =
        textDocumentUri.host + textDocumentUri.pathname + '@' + textDocumentUri.search.substr(1) + '/-/raw/'
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
    const match = serverTextDocumentUri.pathname.match(/^\/(.+)@(\w+)\/-\/raw\/(.*)$/)
    if (!match) {
        throw new Error('Not a Sourcegraph raw API URL: ' + serverTextDocumentUri)
    }
    const [, repoName, rev, filePath] = match
    const sourcegraphUri = new URL(`git://${repoName}`)
    sourcegraphUri.search = rev
    sourcegraphUri.hash = filePath
    return sourcegraphUri
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
