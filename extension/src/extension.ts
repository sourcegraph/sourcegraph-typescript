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
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    Hover,
    HoverRequest,
    InitializeParams,
    InitializeRequest,
    LogMessageNotification,
    MarkupContent,
} from 'vscode-languageserver-protocol'

const connectionsByRootUri = new Map<string, Promise<MessageConnection>>()

function resolveRootUri(textDocumentUri: URL): string {
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
    const rpcWebSocket = toSocket(socket)
    const connection = createMessageConnection(
        new WebSocketMessageReader(rpcWebSocket),
        new WebSocketMessageWriter(rpcWebSocket),
        console
    )
    connection.onNotification(LogMessageNotification.type, ({ type, message }) => {
        // Blue background for the "TypeScript server" prefix
        const args = ['%cTypeScript server%c %s', 'background-color: blue; color: white', '', message]
        switch (type) {
            case 1:
                console.error(...args)
                break
            case 2:
                console.warn(...args)
                break
            case 3:
                console.info(...args)
                break
            case 4:
            default:
                console.log(...args)
                break
        }
    })
    connection.listen()
    const event = await new Promise<Event>(resolve => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', resolve, { once: true })
    })
    if (event.type === 'error') {
        throw new Error(`The WebSocket to the TypeScript server at ${serverUrl} could not not be opened`)
    }
    console.log('WebSocket connection to TypeScript server opened')
    const initializeParams: InitializeParams = {
        processId: 0,
        rootUri,
        workspaceFolders: [{ name: '', uri: rootUri }],
        capabilities: {},
    }
    console.log('Initializing TypeScript server...')
    const initResult = await connection.sendRequest(InitializeRequest.type, initializeParams)
    console.log('TypeScript server initialized', initResult)
    return connection
}

async function getOrCreateConnection(textDocumentUri: URL): Promise<MessageConnection> {
    const rootUri = resolveRootUri(textDocumentUri)
    let connectionPromise = connectionsByRootUri.get(rootUri)
    if (!connectionPromise) {
        connectionPromise = connect(rootUri)
        connectionsByRootUri.set(rootUri, connectionPromise)
    }
    const connection = await connectionPromise
    connection.onClose(() => {
        console.log('WebSocket connection to TypeScript server closed')
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

const isTypeScriptFile = (textDocumentUri: URL): boolean => /\.m?(?:t|j)sx?$/.test(textDocumentUri.hash)

export function activate(): void {
    /** Map from textDocument URI to version (monotonically increasing positive integers) */
    const textDocumentVersions = new Map<string, number>()

    // Forward didOpen notifications
    sourcegraph.workspace.onDidOpenTextDocument.subscribe(async textDocument => {
        try {
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                return
            }

            // Increment version
            const textDocumentVersion = (textDocumentVersions.get(textDocumentUri.href) || 0) + 1
            textDocumentVersions.set(textDocumentUri.href, textDocumentVersion)

            const connection = await getOrCreateConnection(textDocumentUri)
            const didOpenParams: DidOpenTextDocumentParams = {
                textDocument: {
                    uri: textDocumentUri.href,
                    languageId: textDocument.languageId,
                    text: textDocument.text,
                    version: textDocumentVersion,
                },
            }
            connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
        } catch (err) {
            console.error('Error handling didOpenTextDocument event', err)
        }
    })

    // Hover
    sourcegraph.languages.registerHoverProvider([{ pattern: '**/*.*' }], {
        provideHover: async (textDocument, position) => {
            // example: git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                // Not a TypeScript file
                return undefined
            }
            const rootUri = resolveRootUri(textDocumentUri)
            const serverTextDocumentUri = new URL(rootUri)
            serverTextDocumentUri.hash = textDocumentUri.hash
            const connection = await getOrCreateConnection(textDocumentUri)
            const hoverResult = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            })
            return convertHover(hoverResult)
        },
    })
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
