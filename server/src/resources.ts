import got from 'got'
import { readFile } from 'mz/fs'
import { fileURLToPath } from 'url'

export interface ResourceRetriever {
    /**
     * Fetches the content of the resource and returns it as an UTF8 string.
     * If the resource does not exist, will reject with a `ResourceNotFoundError`.
     */
    fetch(): Promise<string>
}

export class ResourceNotFoundError extends Error {
    public readonly name = 'ResourceNotFoundError'
}

/**
 * Can retrieve a file: resource
 */
class FileResourceRetriever implements ResourceRetriever {
    constructor(private resource: URL) {}

    public async fetch(): Promise<string> {
        try {
            return await readFile(fileURLToPath(this.resource), 'utf-8')
        } catch (err) {
            if (err.code === 'ENOENT') {
                throw new ResourceNotFoundError()
            }
            throw err
        }
    }
}

/**
 * Can retrieve an http(s): resource
 */
class HttpResourceRetriever implements ResourceRetriever {
    constructor(private resource: URL) {}

    public async fetch(): Promise<string> {
        try {
            const response = await got.get(this.resource, {
                headers: {
                    Accept: 'text/plain',
                    'User-Agent': 'TypeScript language server',
                },
            })
            return response.body
        } catch (err) {
            if (err.statusCode === 404) {
                throw new ResourceNotFoundError()
            }
            throw err
        }
    }
}

export function pickResourceRetriever(uri: URL): ResourceRetriever {
    switch (uri.protocol) {
        case 'file:':
            return new FileResourceRetriever(uri)
        case 'http:':
        case 'https:':
            return new HttpResourceRetriever(uri)
    }
    throw new Error(`Unsupported protocol ${uri}`)
}
