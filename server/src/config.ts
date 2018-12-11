export interface Configuration {
    'typescript.langserver.log'?: false | 'log' | 'info' | 'warn' | 'error'
    'typescript.tsserver.log'?: false | 'terse' | 'normal' | 'requestTime' | 'verbose'
    'typescript.tsserver.env'?: Record<string, string>
    'typescript.accessToken'?: string
    'sourcegraph.url'?: string
}
