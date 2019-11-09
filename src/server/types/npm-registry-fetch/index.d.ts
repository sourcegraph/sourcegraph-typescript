declare module 'npm-registry-fetch' {
    declare namespace npmFetch {
        export interface NpmOptions {
            body?: Buffer | NodeJS.ReadableStream | object
            ca?: string | string[]
            cache?: string
            cert?: string
            'fetch-retries'?: number
            'fetch-retry-mintimeout'?: number
            'fetch-retry-maxtimeout'?: number
            'force-auth'?: object
            gzip?: boolean
            headers?: object
            'ignore-body'?: boolean
            integrity?: string | object
            'is-from-ci'?: boolean
            isFromCI?: boolean
            key?: string
            'local-address'?: string
            registry?: string
            'max-sockets'?: number
            method?: string
            noproxy?: boolean
            'npm-session'?: string
            offline?: boolean
            retry?: object
            scope?: string
            'strict-ssl'?: boolean
            timeout?: number
            'prefer-offline'?: boolean
            'prefer-online'?: boolean
            'project-scope'?: string
            token?: string
            _authToken?: string
            'user-agent'?: string
            username?: string
            password?: string
            spec?: string | object
            log?: object
            otp?: string | number
            proxy?: string
            query?: string | object
            refer?: string
            /**
             * Options scoped to a package scope or registry with a `:` before the option.
             */
            [scopedOption: string]: any
        }
        export function json(url: string, options: NpmOptions): Promise<any>
    }
    declare function npmFetch(url: string, options: NpmOptions): Promise<any>
    export = npmFetch
}
