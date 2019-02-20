// Polyfill
import { URL as _URL, URLSearchParams as _URLSearchParams } from 'whatwg-url'
// @ts-ignore
Object.assign(_URL, self.URL)
Object.assign(self, { URL: _URL, URLSearchParams: _URLSearchParams })

import { activateBasicCodeIntel } from '@sourcegraph/basic-code-intel'
import { Tracer as LightstepTracer } from '@sourcegraph/lightstep-tracer-webworker'
import { register, webSocketTransport } from '@sourcegraph/lsp-client'
import { AsyncIterableX } from 'ix/asynciterable/index'
import { filter, map, scan, tap } from 'ix/asynciterable/pipe/index'
import { Tracer } from 'opentracing'
import * as sourcegraph from 'sourcegraph'
import {
    CancellationTokenSource,
    DefinitionRequest,
    Location,
    ReferenceParams,
    ReferencesRequest,
} from 'vscode-languageserver-protocol'
import { getOrCreateAccessToken } from './auth'
import { LangTypescriptConfiguration } from './config'
import {
    findPackageDependentsWithNpm,
    findPackageDependentsWithSourcegraphExtensionRegistry as findDependentsWithSourcegraphExtensionRegistry,
    findPackageDependentsWithSourcegraphSearch,
    findPackageName,
} from './dependencies'
import { resolveRev } from './graphql'
import { Logger, redact, RedactingLogger } from './logging'
import { convertLocation } from './lsp-conversion'
import { logErrorEvent, sendTracedRequest, traceAsyncGenerator } from './tracing'
import { resolveSourcegraphRootUri, toServerTextDocumentUri, toSourcegraphTextDocumentUri } from './uris'
import { asArray, flatMapConcurrent, observableFromAsyncIterable, SourcegraphEndpoint, throwIfAbortError } from './util'

const EXTERNAL_REFS_CONCURRENCY = 7

const documentSelector: sourcegraph.DocumentSelector = [{ language: 'typescript' }, { language: 'javascript' }]

const logger: Logger = new RedactingLogger(console)

export async function activate(ctx: sourcegraph.ExtensionContext): Promise<void> {
    // Cancel everything whene extension is deactivated
    const cancellationTokenSource = new CancellationTokenSource()
    ctx.subscriptions.add(() => cancellationTokenSource.cancel())
    const token = cancellationTokenSource.token

    const config = sourcegraph.configuration.get().value as LangTypescriptConfiguration

    if (!config['typescript.serverUrl']) {
        logger.warn('No typescript.serverUrl configured, falling back to basic code intelligence')
        // Fall back to basic-code-intel behavior
        return activateBasicCodeIntel({
            languageID: 'typescript',
            fileExts: ['ts', 'tsx', 'js', 'jsx'],
            definitionPatterns: [
                'var\\s\\b%s\\b',
                'let\\s\\b%s\\b',
                'const\\s\\b%s\\b',
                'function\\s\\b%s\\b',
                'interface\\s\\b%s\\b',
                'type\\s\\b%s\\b',
                '\\b%s\\b:',
            ],
            commentStyle: {
                lineRegex: /\/\/\s?/,
                block: {
                    startRegex: /\/\*\*?/,
                    lineNoiseRegex: /(^\s*\*\s?)?/,
                    endRegex: /\*\//,
                },
            },
        })(ctx)
    }

    const tracer: Tracer = config['lightstep.token']
        ? new LightstepTracer({ access_token: config['lightstep.token'], component_name: 'ext-lang-typescript' })
        : new Tracer()

    const accessToken = await getOrCreateAccessToken()
    /** The Sourcegraph endpoint contactable by the server */
    const serverSgEndpoint: SourcegraphEndpoint = {
        url: new URL(config['typescript.sourcegraphUrl'] || sourcegraph.internal.sourcegraphURL.toString()),
        accessToken,
    }
    /** The Sourcegraph endpoint contactable by the extension  */
    const clientSgEndpoint: SourcegraphEndpoint = {
        url: new URL(sourcegraph.internal.sourcegraphURL.toString()),
        accessToken,
    }

    const client = await register({
        sourcegraph,
        transport: webSocketTransport({ serverUrl: config['typescript.serverUrl'], logger }),
        clientToServerURI: uri => toServerTextDocumentUri(uri, serverSgEndpoint),
        serverToClientURI: uri => toSourcegraphTextDocumentUri(uri),
        supportsWorkspaceFolders: false,
        documentSelector,
    })
    ctx.subscriptions.add(client)

    // Cross-repo references
    const provideReferences = (
        textDocument: sourcegraph.TextDocument,
        position: sourcegraph.Position
    ): AsyncIterable<sourcegraph.Location[]> =>
        traceAsyncGenerator('Provide external references', tracer, undefined, span =>
            AsyncIterableX.from(
                (async function*() {
                    const serverTextDocumentUri = toServerTextDocumentUri(new URL(textDocument.uri), serverSgEndpoint)
                    logger.log('Getting canonical definition for cross-repo references')
                    const definition: Location | undefined = asArray(
                        await client.withConnection(resolveSourcegraphRootUri(new URL(textDocument.uri)), connection =>
                            sendTracedRequest(
                                connection,
                                DefinitionRequest.type,
                                {
                                    textDocument: { uri: serverTextDocumentUri.href },
                                    position,
                                },
                                { span, tracer, token }
                            )
                        )
                    )[0]
                    if (!definition) {
                        return
                    }
                    span.setTag('uri', redact(definition.uri))
                    span.setTag('line', definition.range.start.line)

                    const findPackageDependents =
                        clientSgEndpoint.url.hostname === 'sourcegraph.com'
                            ? findPackageDependentsWithNpm
                            : findPackageDependentsWithSourcegraphSearch

                    logger.log(`Getting external references for definition`, definition)

                    const definitionUri = new URL(definition.uri)

                    const referenceParams: ReferenceParams = {
                        textDocument: { uri: definitionUri.href },
                        position: definition.range.start,
                        context: { includeDeclaration: false },
                    }

                    const packageName = await findPackageName(definitionUri, { logger, tracer, span })

                    // Find dependent packages on the package
                    const dependents =
                        packageName === 'sourcegraph'
                            ? // If the package name is "sourcegraph", we are looking for references to a symbol in the Sourcegraph extension API
                              // Extensions are not published to npm, so search the extension registry
                              findDependentsWithSourcegraphExtensionRegistry(clientSgEndpoint, { logger, tracer, span })
                            : findPackageDependents(packageName, clientSgEndpoint, { logger, tracer, span })

                    // Search for references in each dependent
                    const findExternalRefsInDependent = (repoName: string) =>
                        traceAsyncGenerator('Find external references in dependent', tracer, span, async function*(
                            span
                        ) {
                            try {
                                logger.log(`Looking for external references in dependent repo ${repoName}`)
                                span.setTag('repoName', repoName)
                                const commitID = await resolveRev(repoName, 'HEAD', clientSgEndpoint, { span, tracer })
                                const rootUri = new URL(`${repoName}@${commitID}/-/raw/`, serverSgEndpoint.url)
                                if (serverSgEndpoint.accessToken) {
                                    rootUri.username = serverSgEndpoint.accessToken
                                }

                                yield await client.withConnection(
                                    toSourcegraphTextDocumentUri(rootUri),
                                    async connection => {
                                        const references = asArray(
                                            await sendTracedRequest(
                                                connection,
                                                ReferencesRequest.type,
                                                referenceParams,
                                                { span, tracer, token }
                                            )
                                        )
                                        logger.log(
                                            `Found ${references.length} references in dependent repo ${repoName}`
                                        )
                                        // Only include references in the external repo, do not duplicate references in the same repo
                                        return references.filter(location => location.uri.startsWith(rootUri.href))
                                    }
                                )
                            } catch (err) {
                                throwIfAbortError(err)
                                logErrorEvent(span, err)
                                logger.error(`Error searching dependent repo ${repoName} for references`, err)
                            }
                        })
                    yield* flatMapConcurrent(dependents, EXTERNAL_REFS_CONCURRENCY, findExternalRefsInDependent)
                    logger.log('Done going through dependents')
                })()
            ).pipe(
                filter(chunk => chunk.length > 0),
                tap({
                    next: chunk => {
                        span.log({ event: 'chunk', count: chunk.length })
                    },
                }),
                // Rewrite URIs and convert from LSP to Sourcegraph Location
                map(chunk =>
                    chunk
                        .map(location => {
                            try {
                                return convertLocation({
                                    ...location,
                                    uri: toSourcegraphTextDocumentUri(new URL(location.uri)).href,
                                })
                            } catch (err) {
                                return undefined
                            }
                        })
                        .filter((location): location is Exclude<typeof location, undefined> => !!location)
                ),
                // Aggregate individual chunks into a growing array (which is what Sourcegraph expects)
                scan<sourcegraph.Location[], sourcegraph.Location[]>(
                    (allReferences, chunk) => allReferences.concat(chunk),
                    []
                )
            )
        )

    ctx.subscriptions.add(
        sourcegraph.languages.registerReferenceProvider(documentSelector, {
            provideReferences: (
                document: sourcegraph.TextDocument,
                position: sourcegraph.Position,
                context: sourcegraph.ReferenceContext
            ) => observableFromAsyncIterable(provideReferences(document, position)),
        })
    )
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
