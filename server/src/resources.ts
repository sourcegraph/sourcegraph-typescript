import * as glob from 'fast-glob'
import got from 'got'
import { AsyncIterableX } from 'ix/asynciterable'
import { noop } from 'lodash'
import { exists, readFile } from 'mz/fs'
import { FORMAT_HTTP_HEADERS, Span, Tracer } from 'opentracing'
import { fileURLToPath, pathToFileURL, URL } from 'url'

interface GlobOptions {
    ignore?: string[]
    span?: Span
    tracer?: Tracer
}

export interface ResourceRetriever {
    /** The URI protocols (including trailing colon) this ResourceRetriever can handle */
    readonly protocols: ReadonlySet<string>

    /**
     * Checks if given resource exits and returns a boolean.
     */
    exists(resource: URL, options?: { span?: Span; tracer?: Tracer }): Promise<boolean>

    /**
     * Fetches the content of the resource and returns it as an UTF8 string.
     * If the resource does not exist, will reject with a `ResourceNotFoundError`.
     */
    fetch(resource: URL, options?: { span?: Span; tracer?: Tracer }): Promise<string>

    /**
     * Finds resources (files and directories) by a glob pattern URL.
     * Directory URLs are suffixed with a trailing slash.
     *
     * @param pattern
     * @returns Matching absolute URLs
     */
    glob(pattern: URL, options?: GlobOptions): AsyncIterable<URL>
}

export class ResourceNotFoundError extends Error {
    public readonly name = 'ResourceNotFoundError'
    constructor(public readonly resource: URL) {
        super(`Resource not found: ${resource}`)
    }
}

/**
 * Can retrieve a file: resource
 */
export class FileResourceRetriever implements ResourceRetriever {
    public readonly protocols = new Set(['file:'])

    public async *glob(pattern: URL, { ignore = [] }: GlobOptions = {}): AsyncIterable<URL> {
        // TODO use glob.stream() API once https://github.com/mrmlnc/fast-glob/issues/140 is fixed
        const files = await glob.async<string>(fileURLToPath(pattern), {
            ignore,
            absolute: true,
            markDirectories: true,
            onlyFiles: false,
        })
        for (const file of files) {
            yield pathToFileURL(file)
        }
    }

    public async exists(resource: URL): Promise<boolean> {
        return await exists(fileURLToPath(resource))
    }

    public async fetch(resource: URL): Promise<string> {
        try {
            return await readFile(fileURLToPath(resource), 'utf-8')
        } catch (err) {
            if (err.code === 'ENOENT') {
                throw new ResourceNotFoundError(resource)
            }
            throw err
        }
    }
}

const USER_AGENT = 'TypeScript language server'

/**
 * Can retrieve an http(s): resource
 */
export class HttpResourceRetriever implements ResourceRetriever {
    public readonly protocols = new Set(['http:', 'https:'])
    public glob(pattern: URL): AsyncIterable<URL> {
        throw new Error('Globbing is not implemented over HTTP')
        // const response = await got.get(pattern, {
        //     headers: {
        //         Accept: 'text/plain',
        //         'User-Agent': USER_AGENT,
        //     },
        // })
        // Post-filter ignore pattern in case server does not support it
        // return response.body.split('\n').map(url => new URL(url, pattern))
    }

    public async exists(
        resource: URL,
        { span = new Span(), tracer = new Tracer() }: { span?: Span; tracer?: Tracer } = {}
    ): Promise<boolean> {
        try {
            const headers = {
                'User-Agent': USER_AGENT,
            }
            tracer.inject(span, FORMAT_HTTP_HEADERS, headers)
            await got.head(resource, { headers })
            return true
        } catch (err) {
            if (err.statusCode === 404) {
                return false
            }
            throw err
        }
    }

    public async fetch(
        resource: URL,
        { span = new Span(), tracer = new Tracer() }: { span?: Span; tracer?: Tracer } = {}
    ): Promise<string> {
        try {
            const headers = {
                Accept: 'text/plain',
                'User-Agent': USER_AGENT,
            }
            tracer.inject(span, FORMAT_HTTP_HEADERS, headers)
            const response = await got.get(resource, { headers })
            return response.body
        } catch (err) {
            if (err.statusCode === 404) {
                throw new ResourceNotFoundError(resource)
            }
            throw err
        }
    }
}

export type ResourceRetrieverPicker = (uri: URL) => ResourceRetriever

export function createResourceRetrieverPicker(retrievers: ResourceRetriever[]): ResourceRetrieverPicker {
    return uri => {
        const retriever = retrievers.find(retriever => retriever.protocols.has(uri.protocol))
        if (!retriever) {
            throw new Error(`Unsupported protocol ${uri}`)
        }
        return retriever
    }
}

/**
 * Walks through the parent directories of a given URI.
 * Starts with the directory of the start URI (or the start URI itself if it is a directory).
 * Yielded directories will always have a trailing slash.
 */
export function* walkUp(start: URL): Iterable<URL> {
    let current = new URL('.', start)
    while (true) {
        yield current
        const parent = new URL('..', start)
        if (parent.href === current.href) {
            // Reached root
            return
        }
        current = parent
    }
}
