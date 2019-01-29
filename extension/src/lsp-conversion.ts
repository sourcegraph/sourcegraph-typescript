import * as sourcegraph from 'sourcegraph'
import { Diagnostic, DiagnosticSeverity, Hover, Location, MarkupContent, Range } from 'vscode-languageserver-types'

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
        priority: 100, // take precedence over basic-code-intel and other fuzzy hovers
    }
}

export const convertLocation = (location: Location): sourcegraph.Location => ({
    uri: new sourcegraph.URI(location.uri),
    range: convertRange(location.range),
})

export function convertLocations(locationOrLocations: Location | Location[] | null): sourcegraph.Location[] | null {
    if (!locationOrLocations) {
        return null
    }
    const locations = Array.isArray(locationOrLocations) ? locationOrLocations : [locationOrLocations]
    return locations.map(convertLocation)
}

const DIAGNOSTIC_COLORS: Readonly<Record<DiagnosticSeverity, string>> = {
    [DiagnosticSeverity.Error]: 'var(--danger, #dc3545)',
    [DiagnosticSeverity.Information]: 'var(--info, #17a2b8)',
    [DiagnosticSeverity.Warning]: 'var(--success, #ffc107)',
    [DiagnosticSeverity.Hint]: 'var(--secondary, #6c757d)',
}
export const convertDiagnosticToDecoration = (diagnostic: Diagnostic): sourcegraph.TextDocumentDecoration => ({
    after: {
        color: DIAGNOSTIC_COLORS[diagnostic.severity || DiagnosticSeverity.Hint],
        contentText: diagnostic.message.replace(/\n/g, ' '),
    },
    range: convertRange(diagnostic.range),
})
