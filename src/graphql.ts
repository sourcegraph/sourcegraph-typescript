import got from 'got'
import gql from 'tagged-template-noop'

interface Options {
    instanceUrl: URL
    accessToken?: string
}

/**
 * Does a GraphQL request to the Sourcegraph GraphQL API
 *
 * @param query The GraphQL request (query or mutation)
 * @param variables A key/value object with variable values
 */
export async function requestGraphQL(
    query: string,
    variables: any = {},
    { instanceUrl, accessToken }: Options
): Promise<{ data?: any; errors?: { message: string; path: string }[] }> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'TypeScript language server',
    }
    if (accessToken) {
        headers.Authorization = 'token ' + accessToken
    }
    const response = await got.post(new URL('/.api/graphql', instanceUrl), {
        headers,
        body: { query, variables },
        json: true,
    })
    return response.body
}

/**
 * Uses the Sourcegraph GraphQL API to resolve a git clone URL to a Sourcegraph repository name.
 *
 * @param cloneUrl A git clone URL
 * @return The Sourcegraph repository name (can be used to construct raw API URLs)
 */
export async function resolveRepository(cloneUrl: string, options: Options): Promise<string> {
    const { data, errors } = await requestGraphQL(
        gql`
            query($cloneUrl: String!) {
                repository(cloneURL: $cloneUrl) {
                    name
                }
            }
        `,
        { cloneUrl },
        options
    )
    if (errors && errors.length > 0) {
        throw new Error('GraphQL Error:' + errors.map(e => e.message).join('\n'))
    }
    if (!data.repository) {
        throw new Error(`No repository found for clone URL ${cloneUrl} on instance ${options.instanceUrl}`)
    }
    return data.repository.name
}
