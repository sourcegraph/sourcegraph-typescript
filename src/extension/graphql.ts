import { Span, Tracer } from 'opentracing'
import gql from 'tagged-template-noop'
import { tracePromise } from '../common/tracing'
import { tracedFetch } from './tracing'
import { SourcegraphEndpoint } from './util'

/**
 * Does a GraphQL request to the Sourcegraph GraphQL API
 *
 * @param query The GraphQL request (query or mutation)
 * @param variables A key/value object with variable values
 */
export async function requestGraphQL(
    query: string,
    variables: any = {},
    sgEndpoint: SourcegraphEndpoint,
    { span, tracer }: { span: Span; tracer: Tracer }
): Promise<{ data?: any; errors?: { message: string; path: string }[] }> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    }
    if (sgEndpoint.accessToken) {
        headers.Authorization = 'token ' + sgEndpoint.accessToken
    }
    const response = await tracedFetch(new URL('/.api/graphql', sgEndpoint.url), {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        span,
        tracer,
    })
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
    }
    return await response.json()
}

export async function search(
    query: string,
    sgEndpoint: SourcegraphEndpoint,
    { tracer, span }: { span: Span; tracer: Tracer }
): Promise<any> {
    return await tracePromise('Sourcegraph search', tracer, span, async span => {
        span.setTag('query', query)
        const { data, errors } = await requestGraphQL(
            gql`
                query Search($query: String!) {
                    search(query: $query) {
                        results {
                            results {
                                ... on FileMatch {
                                    repository {
                                        name
                                    }
                                }
                            }
                        }
                    }
                }
            `,
            { query },
            sgEndpoint,
            { tracer, span }
        )
        if (errors && errors.length > 0) {
            throw new Error('GraphQL Error:' + errors.map(e => e.message).join('\n'))
        }
        return data.search.results.results
    })
}

/**
 * @param rev A revision (branch name, tag, "HEAD", ...)
 * @returns The commit ID of the given revision
 */
export async function resolveRev(
    repoName: string,
    rev: string,
    sgEndpoint: SourcegraphEndpoint,
    { span, tracer }: { span: Span; tracer: Tracer }
): Promise<string> {
    return await tracePromise('Resolve rev', tracer, span, async span => {
        span.setTag('repoName', repoName)
        span.setTag('rev', rev)
        const { data, errors } = await requestGraphQL(
            gql`
                query ResolveRev($repoName: String!, $rev: String!) {
                    repository(name: $repoName) {
                        commit(rev: $rev) {
                            oid
                        }
                    }
                }
            `,
            { repoName, rev },
            sgEndpoint,
            { span, tracer }
        )
        if (errors && errors.length > 0) {
            throw new Error('GraphQL Error:' + errors.map(e => e.message).join('\n'))
        }
        return data.repository.commit.oid
    })
}

/**
 * Uses the Sourcegraph GraphQL API to resolve a git clone URL to a Sourcegraph repository name.
 *
 * @param cloneUrl A git clone URL
 * @return The Sourcegraph repository name (can be used to construct raw API URLs)
 */
export async function resolveRepository(
    cloneUrl: string,
    sgEndpoint: SourcegraphEndpoint,
    { span, tracer }: { span: Span; tracer: Tracer }
): Promise<string> {
    return await tracePromise('Resolve clone URL', tracer, span, async span => {
        span.setTag('cloneUrl', cloneUrl)
        const { data, errors } = await requestGraphQL(
            gql`
                query($cloneUrl: String!) {
                    repository(cloneURL: $cloneUrl) {
                        name
                    }
                }
            `,
            { cloneUrl },
            sgEndpoint,
            { span, tracer }
        )
        if (errors && errors.length > 0) {
            throw new Error('GraphQL Error:' + errors.map(e => e.message).join('\n'))
        }
        if (!data.repository) {
            throw new Error(`No repository found for clone URL ${cloneUrl} on instance ${sgEndpoint.url}`)
        }
        return data.repository.name
    })
}

/**
 * Returns all extensions on the Sourcegraph instance.
 */
export async function queryExtensions(
    sgEndpoint: SourcegraphEndpoint,
    { span, tracer }: { span: Span; tracer: Tracer }
): Promise<any[]> {
    return await tracePromise('Query extensions', tracer, span, async span => {
        const { data, errors } = await requestGraphQL(
            gql`
                query ExtensionManifests {
                    extensionRegistry {
                        extensions {
                            nodes {
                                extensionID
                                manifest {
                                    raw
                                }
                            }
                        }
                    }
                }
            `,
            {},
            sgEndpoint,
            { span, tracer }
        )
        if (errors && errors.length > 0) {
            throw new Error('GraphQL Error:' + errors.map(e => e.message).join('\n'))
        }
        return data.extensionRegistry.extensions.nodes
    })
}
