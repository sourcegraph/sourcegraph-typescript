import * as sourcegraph from 'sourcegraph'
import { Hover, Location, MarkupContent, Range } from 'vscode-languageserver-types'

/**
 * @param textDocumentUri The Sourcegraph text document URI, e.g. `git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts`
 * @returns The root URI for the server, e.g. `https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/`. Always has a trailing slash.
 */
export function resolveRootUri(textDocumentUri: URL): URL {
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
    const rootUri = resolveRootUri(textDocumentUri)
    const serverTextDocumentUri = new URL(textDocumentUri.hash.substr(1), rootUri.href)
    return serverTextDocumentUri
}

/**
 * @param serverTextDocumentUri The text document URI for the server, e.g. https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/src/schema/graphqlschema.ts
 * @returns The Sourcegraph text document URI, e.g. git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
 */
function toSourcegraphTextDocumentUri(serverTextDocumentUri: URL): URL {
    const match = serverTextDocumentUri.pathname.match(/^\/(.+)@(\w+)\/-\/raw\/(.*)$/)
    if (!match) {
        throw new Error('Invalid URI ' + serverTextDocumentUri.href)
    }
    const [, repoName, rev, filePath] = match
    const sourcegraphUri = new URL(`git://${repoName}`)
    sourcegraphUri.search = rev
    sourcegraphUri.hash = filePath
    return sourcegraphUri
}

export function convertRange(range: Range): sourcegraph.Range {
    return new sourcegraph.Range(range.start.line, range.start.character, range.end.line, range.end.character)
}

export function convertHover(hover: Hover | null): sourcegraph.Hover | null {
    if (!hover) {
        return null
    }
    const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
    return {
        range: hover.range && convertRange(hover.range),
        contents: {
            kind: sourcegraph.MarkupKind.Markdown,
            value: contents
                .map(content => {
                    if (MarkupContent.is(content)) {
                        // Assume it's markdown. To be correct, markdown would need to be escaped for non-markdown kinds.
                        return content.value
                    }
                    if (typeof content === 'string') {
                        return content
                    }
                    if (!content.value) {
                        return ''
                    }
                    return '```' + content.language + '\n' + content.value + '\n```'
                })
                .filter(str => !!str.trim())
                .join('\n\n---\n\n'),
        },
    }
}

export function convertLocations(locationOrLocations: Location | Location[] | null): sourcegraph.Location[] | null {
    if (!locationOrLocations) {
        return null
    }
    const locations = Array.isArray(locationOrLocations) ? locationOrLocations : [locationOrLocations]
    return locations.map(location => ({
        uri: sourcegraph.URI.parse(toSourcegraphTextDocumentUri(new URL(location.uri)).href),
        range: convertRange(location.range),
    }))
}
