import * as sourcegraph from 'sourcegraph'
import { Hover, Location, MarkupContent, Range } from 'vscode-languageserver-types'

export function resolveRootUri(textDocumentUri: URL): URL {
    // example: git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
    // TODO this should point to the public Sourcegraph "raw" API, with an access token.
    // This only works for public GitHub repos!
    const rootUri =
        'https://' +
        textDocumentUri.hostname +
        textDocumentUri.pathname +
        '/archive/' +
        textDocumentUri.search.substr(1) +
        '.zip'
    return new URL(rootUri)
}

/**
 * @param textDocumentUri The Sourcegraph text document URI like git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
 * @returns The text document URI for the server, using http:// and pointing to the raw API
 */
export function toServerTextDocumentUri(textDocumentUri: URL): URL {
    const rootUri = resolveRootUri(textDocumentUri)
    const serverTextDocumentUri = new URL(rootUri.href)
    serverTextDocumentUri.hash = textDocumentUri.hash
    return serverTextDocumentUri
}

/**
 * @param serverTextDocumentUri The text document URI for the server, e.g. https://github.com/sourcegraph/extensions-client-common/archive/80389224bd48e1e696d5fa11b3ec6fba341c695b.zip#src/schema/graphqlschema.ts
 * @returns The Sourcegraph text document URI, e.g. git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
 */
function toSourcegraphTextDocumentUri(serverTextDocumentUri: URL): URL {
    const match = serverTextDocumentUri.pathname.match(/\/([\w-]+)\/([\w-]+)\/archive\/(\w+)\.zip/)
    if (!match) {
        throw new Error('Invalid URI ' + serverTextDocumentUri.href)
    }
    const [, owner, repoName, rev] = match
    const sourcegraphUri = new URL(`git://${serverTextDocumentUri.host}/${owner}/${repoName}`)
    sourcegraphUri.hostname = serverTextDocumentUri.hostname
    sourcegraphUri.search = rev
    sourcegraphUri.hash = serverTextDocumentUri.hash
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
