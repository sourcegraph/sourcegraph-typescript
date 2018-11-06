// Polyfill
import { URL, URLSearchParams } from 'whatwg-url'
// @ts-ignore
Object.assign(URL, self.URL)
Object.assign(self, { URL, URLSearchParams })

import {
    createMessageConnection,
    MessageConnection,
    toSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import * as sourcegraph from 'sourcegraph'
import {
    Hover,
    HoverRequest,
    InitializeParams,
    InitializeRequest,
    LogMessageNotification,
    MarkupContent,
} from 'vscode-languageserver-protocol'

const connectionsByRootUri = new Map<string, Promise<MessageConnection>>()

function resolveRootUri(textDocumentUri: string): string {
    // example: git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
    const parsedUri = new URL(textDocumentUri)
    // TODO this should point to the public Sourcegraph "raw" API, with an access token.
    // This only works for public GitHub repos!
    const rootUri =
        'https://' + parsedUri.hostname + parsedUri.pathname + '/archive/' + parsedUri.search.substr(1) + '.zip'
    return rootUri
}

async function connect(rootUri: string): Promise<MessageConnection> {
    const serverUrl: unknown = sourcegraph.configuration.get().get('typescript.serverUrl')
    if (typeof serverUrl !== 'string') {
        throw new Error(
            'Setting typescript.serverUrl must be set to the WebSocket endpoint of the TypeScript language service'
        )
    }
    const socket = new WebSocket(serverUrl)
    const connection = createMessageConnection(
        new WebSocketMessageReader(toSocket(socket)),
        new WebSocketMessageWriter(toSocket(socket)),
        console
    )
    connection.onNotification(LogMessageNotification.type, ({ type, message }) => {
        const prefix = 'TypeScript server:'
        switch (type) {
            case 1:
                console.error(prefix, message)
                break
            case 2:
                console.warn(prefix, message)
                break
            case 3:
                console.info(prefix, message)
                break
            case 4:
            default:
                console.log(prefix, message)
                break
        }
    })
    connection.listen()
    const event = await new Promise<Event>(resolve => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', resolve, { once: true })
    })
    console.log('WebSocket connection to TypeScript server opened')
    if (event.type === 'error') {
        throw new Error(`The WebSocket to the TypeScript server at ${serverUrl} could not not be opened`)
    }
    const initializeParams: InitializeParams = {
        processId: 0,
        rootUri,
        workspaceFolders: [{ name: '', uri: rootUri }],
        capabilities: {},
    }
    const initResult = await connection.sendRequest(InitializeRequest.type, initializeParams)
    console.log('initialize result', initResult)
    return connection
}

async function getOrCreateConnection(textDocumentUri: string): Promise<MessageConnection> {
    const rootUri = resolveRootUri(textDocumentUri)
    let connectionPromise = connectionsByRootUri.get(rootUri)
    if (!connectionPromise) {
        connectionPromise = connect(rootUri)
        connectionsByRootUri.set(rootUri, connectionPromise)
    }
    const connection = await connectionPromise
    connection.onClose(() => {
        connectionsByRootUri.delete(rootUri)
    })
    return connection
}

function convertHover(hover: Hover | null): sourcegraph.Hover | null {
    if (!hover) {
        return null
    }
    const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
    return {
        range:
            hover.range &&
            new sourcegraph.Range(
                hover.range.start.line,
                hover.range.start.character,
                hover.range.end.line,
                hover.range.end.character
            ),
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
                    return '```' + content.language + '\n' + content.value + '\n```'
                })
                .join('\n\n---\n\n'),
        },
    }
}

export function activate(): void {
    sourcegraph.languages.registerHoverProvider([{ pattern: '**/*.ts' }], {
        provideHover: async (textDocument, position) => {
            const rootUri = resolveRootUri(textDocument.uri)
            const serverTextDocumentUri = new URL(rootUri)
            // example: git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
            serverTextDocumentUri.hash = new URL(textDocument.uri).hash
            const connection = await getOrCreateConnection(textDocument.uri)
            const hoverResult = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            })
            return convertHover(hoverResult)
        },
    })
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
