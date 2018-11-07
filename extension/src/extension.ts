// Polyfill
import { URL as _URL, URLSearchParams as _URLSearchParams } from 'whatwg-url'
// @ts-ignore
Object.assign(_URL, self.URL)
Object.assign(self, { URL: _URL, URLSearchParams: _URLSearchParams })

import {
    createMessageConnection,
    MessageConnection,
    toSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import * as sourcegraph from 'sourcegraph'
import {
    DefinitionRequest,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    HoverRequest,
    InitializeParams,
    InitializeRequest,
    LogMessageNotification,
    ReferenceParams,
    ReferencesRequest,
} from 'vscode-languageserver-protocol'
import { convertHover, convertLocations, resolveRootUri, toServerTextDocumentUri } from './lsp-conversion'

const connectionsByRootUri = new Map<string, Promise<MessageConnection>>()

async function connect(rootUri: URL): Promise<MessageConnection> {
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
        rootUri: rootUri.href,
        workspaceFolders: [{ name: '', uri: rootUri.href }],
        capabilities: {},
    }
    console.log('Initializing TypeScript server...')
    const initResult = await connection.sendRequest(InitializeRequest.type, initializeParams)
    console.log('TypeScript server initialized', initResult)
    return connection
}

async function getOrCreateConnection(textDocumentUri: URL): Promise<MessageConnection> {
    const rootUri = resolveRootUri(textDocumentUri)
    let connectionPromise = connectionsByRootUri.get(rootUri.href)
    if (!connectionPromise) {
        connectionPromise = connect(rootUri)
        connectionsByRootUri.set(rootUri.href, connectionPromise)
    }
    const connection = await connectionPromise
    connection.onClose(() => {
        console.log('WebSocket connection to TypeScript server closed')
        connectionsByRootUri.delete(rootUri.href)
    })
    return connection
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

    // Example of a Sourcegraph textdocument URI:
    // git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts

    // Hover
    sourcegraph.languages.registerHoverProvider([{ pattern: '**/*.*' }], {
        provideHover: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                return undefined
            }
            const serverTextDocumentUri = toServerTextDocumentUri(textDocumentUri)
            const connection = await getOrCreateConnection(textDocumentUri)
            const hoverResult = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            })
            return convertHover(hoverResult)
        },
    })

    // Definition
    sourcegraph.languages.registerDefinitionProvider([{ pattern: '**/*.*' }], {
        provideDefinition: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                return undefined
            }
            const serverTextDocumentUri = toServerTextDocumentUri(textDocumentUri)
            const connection = await getOrCreateConnection(textDocumentUri)
            const definitionResult = await connection.sendRequest(DefinitionRequest.type, {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            })
            return convertLocations(definitionResult)
        },
    })

    // References
    sourcegraph.languages.registerReferenceProvider([{ pattern: '**/*.*' }], {
        provideReferences: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                return undefined
            }
            const serverTextDocumentUri = toServerTextDocumentUri(textDocumentUri)
            const connection = await getOrCreateConnection(textDocumentUri)
            const referenceParams: ReferenceParams = {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
                context: {
                    includeDeclaration: false,
                },
            }
            const referencesResult = await connection.sendRequest(ReferencesRequest.type, referenceParams)
            return convertLocations(referencesResult)
        },
    })
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
