import globby = require('globby')
import got from 'got'
import { readFile } from 'mz/fs'
import { fileURLToPath, pathToFileURL } from 'url'

export interface ResourceRetriever {
    /** The URI protocols (including trailing colon) this ResourceRetriever can handle */
    readonly protocols: ReadonlySet<string>

    /**
     * Fetches the content of the resource and returns it as an UTF8 string.
     * If the resource does not exist, will reject with a `ResourceNotFoundError`.
     */
    fetch(resource: URL): Promise<string>

    /**
     * Finds resources (files and directories) by a glob pattern URL.
     * Directory URLs are suffixed with a trailing slash.
     *
     * @param pattern
     * @returns Matching absolute URLs
     */
    glob(pattern: URL): Promise<URL[]>
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

    public async glob(pattern: URL): Promise<URL[]> {
        const files = await globby(fileURLToPath(pattern), { absolute: true, markDirectories: true, onlyFiles: false })
        return files.map(pathToFileURL)
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
    public async glob(pattern: URL): Promise<URL[]> {
        throw new Error('Globbing is not implemented over HTTP')
        // const response = await got.get(pattern, {
        //     headers: {
        //         Accept: 'text/plain',
        //         'User-Agent': USER_AGENT,
        //     },
        // })
        // return response.body.split('\n').map(url => new URL(url, pattern))
    }

    public async fetch(resource: URL): Promise<string> {
        try {
            const response = await got.get(resource, {
                headers: {
                    Accept: 'text/plain',
                    'User-Agent': USER_AGENT,
                },
            })
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
