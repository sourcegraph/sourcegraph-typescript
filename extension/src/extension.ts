// Polyfill
// @ts-ignore
import { URL, URLSearchParams } from 'whatwg-url'
// @ts-ignore
Object.assign(URL, self.URL)
Object.assign(self, { URL, URLSearchParams })

import * as path from 'path'
import * as sourcegraph from 'sourcegraph'
import gql from 'tagged-template-noop'
import {
    Hover,
    HoverRequest,
    InitializeParams,
    InitializeRequest,
    LogMessageNotification,
    MarkupContent,
} from 'vscode-languageserver-protocol'
import {
    createMessageConnection,
    MessageConnection,
    toSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from 'vscode-ws-jsonrpc'

const connectionsByRootUri = new Map<string, Promise<MessageConnection>>()

async function queryGraphQL(query: string, variables: any = {}): Promise<any> {
    const { data, errors } = await sourcegraph.commands.executeCommand('queryGraphQL', query, variables)
    if (errors) {
        throw Object.assign(new Error(errors.map((err: any) => err.message).join('\n')), { errors })
    }
    return data
}

let accessTokenPromise: Promise<string>
async function getOrCreateAccessToken(): Promise<string> {
    const accessToken = sourcegraph.configuration.get().get('typescript.accessToken') as string | undefined
    if (accessToken) {
        return accessToken
    }
    if (accessTokenPromise) {
        return await accessTokenPromise
    }
    accessTokenPromise = createAccessToken()
    return await accessTokenPromise
}

async function createAccessToken(): Promise<string> {
    const { currentUser } = await queryGraphQL(gql`
        query {
            currentUser {
                id
            }
        }
    `)
    const currentUserId: string = currentUser.id
    const result = await queryGraphQL(
        gql`
            mutation CreateAccessToken($user: ID!, $scopes: [String!]!, $note: String!) {
                createAccessToken(user: $user, scopes: $scopes, note: $note) {
                    id
                    token
                }
            }
        `,
        { user: currentUserId, scopes: ['user:all'], note: 'lang-typescript' }
    )
    const token: string = result.createAccessToken.token
    await sourcegraph.configuration.get().update('typescript.accessToken', token)
    return token
}

async function resolveRootUri(textDocumentUri: string): Promise<URL> {
    // example: git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
    const parsedUri = new URL(textDocumentUri)
    const rev = parsedUri.search.substr(1)
    const accessToken = await getOrCreateAccessToken()
    const rootUri = new URL(sourcegraph.internal.sourcegraphURL.toString())
    rootUri.username = accessToken
    rootUri.pathname = `${parsedUri.hostname}${parsedUri.pathname}@${rev}/-/raw/`
    return rootUri
}

async function connect(rootUri: URL): Promise<MessageConnection> {
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
        switch (type) {
            case 1:
                console.error(message)
                break
            case 2:
                console.warn(message)
                break
            case 3:
                console.info(message)
                break
            case 4:
            default:
                console.log(message)
                break
        }
    })
    connection.listen()
    await new Promise<Event>(resolve => socket.addEventListener('open', resolve, { once: true }))
    const initializeParams: InitializeParams = {
        processId: 0,
        rootUri: rootUri.href,
        workspaceFolders: [{ name: '', uri: rootUri.href }],
        capabilities: {},
    }
    const initResult = await connection.sendRequest(InitializeRequest.type, initializeParams)
    console.log('initialize result', initResult)
    return connection
}

async function getOrCreateConnection(textDocumentUri: string): Promise<MessageConnection> {
    const rootUri = await resolveRootUri(textDocumentUri)
    let connectionPromise = connectionsByRootUri.get(rootUri.href)
    if (!connectionPromise) {
        connectionPromise = connect(rootUri)
        connectionsByRootUri.set(rootUri.href, connectionPromise)
    }
    const connection = await connectionPromise
    connection.onClose(() => {
        connectionsByRootUri.delete(rootUri.href)
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
            const rootUri = await resolveRootUri(textDocument.uri)
            const serverTextDocumentUri = new URL(rootUri.href)
            // example: git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts
            const filePath = new URL(textDocument.uri).hash
            // example: https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/src/schema/graphqlschema.ts
            serverTextDocumentUri.pathname = path.posix.join(serverTextDocumentUri.pathname, filePath)
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
