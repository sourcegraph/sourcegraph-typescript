export interface Configuration {
    'typescript.serverUrl': string
    'typescript.npmrc'?: Record<string, string>
    'typescript.diagnostics.enable'?: boolean
    /** Whether to restart the language server after dependencies were installed (default `true`) */
    'typescript.restartAfterDependencyInstallation'?: boolean
    'typescript.langserver.log'?: false | 'log' | 'info' | 'warn' | 'error'
    'typescript.tsserver.log'?: false | 'terse' | 'normal' | 'requestTime' | 'verbose'
    'typescript.tsserver.env'?: Record<string, string>
    'typescript.accessToken'?: string
    /** Whether to show a progress indicator while initializing. */
    'typescript.progress'?: boolean
    'typescript.sourcegraphUrl'?: string
    'lightstep.token'?: string | null
}
