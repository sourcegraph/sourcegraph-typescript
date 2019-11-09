import * as sourcegraph from 'sourcegraph'
import gql from 'tagged-template-noop'

async function queryGraphQL(query: string, variables: any = {}): Promise<any> {
    const { data, errors } = await sourcegraph.commands.executeCommand('queryGraphQL', query, variables)
    if (errors) {
        throw Object.assign(new Error(errors.map((err: any) => err.message).join('\n')), { errors })
    }
    return data
}

let accessTokenPromise: Promise<string | undefined>
export async function getOrCreateAccessToken(): Promise<string | undefined> {
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

async function createAccessToken(): Promise<string | undefined> {
    const { currentUser } = await queryGraphQL(gql`
        query {
            currentUser {
                id
            }
        }
    `)
    if (!currentUser) {
        return undefined
    }
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
