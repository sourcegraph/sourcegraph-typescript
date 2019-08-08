import { Handler } from '@sourcegraph/basic-code-intel'
import * as path from 'path'
import * as sourcegraph from 'sourcegraph'

export interface Providers {
    hover: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) => Promise<sourcegraph.Hover | null>
    definition: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) => Promise<sourcegraph.Definition | null>
    references: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) => Promise<sourcegraph.Location[] | null>
}

export function initBasicCodeIntel(): Providers {
    const handler = new Handler({
        sourcegraph,
        languageID: 'typescript',
        fileExts: ['ts', 'tsx', 'js', 'jsx'],
        commentStyle: {
            lineRegex: /\/\/\s?/,
            block: {
                startRegex: /\/\*\*?/,
                lineNoiseRegex: /(^\s*\*\s?)?/,
                endRegex: /\*\//,
            },
        },
        filterDefinitions: ({ filePath, fileContent, results }) => {
            const imports = fileContent
                .split('\n')
                .map(line => {
                    // Matches the import at index 1
                    const match = /\bfrom ['"](.*)['"];?$/.exec(line) || /\brequire\(['"](.*)['"]\)/.exec(line)
                    return match ? match[1] : undefined
                })
                .filter((x): x is string => Boolean(x))

            const filteredResults = results.filter(result =>
                imports.some(i => path.join(path.dirname(filePath), i) === result.file.replace(/\.[^/.]+$/, ''))
            )

            return filteredResults.length === 0 ? results : filteredResults
        },
    })

    return {
        hover: handler.hover.bind(handler),
        definition: handler.definition.bind(handler),
        references: handler.references.bind(handler),
    }
}
