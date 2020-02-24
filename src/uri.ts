import { of } from 'ix/iterable'
import { map } from 'ix/iterable/operators'
import RelateUrl from 'relateurl'
import { URL } from 'url'

/**
 * Options to make sure that RelateUrl only outputs relative URLs and performs not other "smart" modifications.
 * They would mess up things like prefix checking.
 */
const RELATE_URL_OPTIONS: RelateUrl.Options = {
    // Make sure RelateUrl does not prefer root-relative URLs if shorter
    output: RelateUrl.PATH_RELATIVE,
    // Make sure RelateUrl does not remove trailing slash if present
    removeRootTrailingSlash: false,
    // Make sure RelateUrl does not remove default ports
    defaultPorts: {},
}

/**
 * Like `path.relative()` but for URLs.
 * Inverse of `url.resolve()` or `new URL(relative, base)`.
 */
export const relativeUrl = (from: URL, to: URL): string => RelateUrl.relate(from.href, to.href, RELATE_URL_OPTIONS)

/**
 * A Map of URIs to values.
 */
export class URLMap<V> implements Map<URL, V> {
    private map: Map<string, V>
    constructor(entries: Iterable<[URL, V]> = []) {
        this.map = new Map(of(...entries).pipe(map(([uri, value]): [string, V] => [uri.href, value])))
    }
    public get size(): number {
        return this.map.size
    }
    public get(key: URL): V | undefined {
        return this.map.get(key.href)
    }
    public has(key: URL): boolean {
        return this.map.has(key.href)
    }
    public set(key: URL, value: V): this {
        this.map.set(key.href, value)
        return this
    }
    public delete(key: URL): boolean {
        return this.map.delete(key.href)
    }
    public clear(): void {
        this.map.clear()
    }
    public forEach(callbackfn: (value: V, key: URL, map: Map<URL, V>) => void, thisArg?: any): void {
        // tslint:disable-next-line:ban
        this.map.forEach((value, key) => {
            callbackfn.call(thisArg, value, new URL(key), this)
        })
    }
    public *entries(): IterableIterator<[URL, V]> {
        for (const [url, value] of this.map) {
            yield [new URL(url), value]
        }
    }
    public values(): IterableIterator<V> {
        return this.map.values()
    }
    public *keys(): IterableIterator<URL> {
        for (const url of this.map.keys()) {
            yield new URL(url)
        }
    }
    public [Symbol.iterator]() {
        return this.entries()
    }
    public [Symbol.toStringTag] = 'URLMap'
}

/**
 * A Set of URIs.
 */
export class URLSet implements Set<URL> {
    private set: Set<string>

    constructor(values: Iterable<URL> = []) {
        this.set = new Set(of(...values).pipe(map(uri => uri.href)))
    }
    public get size(): number {
        return this.set.size
    }
    public has(key: URL): boolean {
        return this.set.has(key.href)
    }
    public add(key: URL): this {
        this.set.add(key.href)
        return this
    }
    public delete(key: URL): boolean {
        return this.set.delete(key.href)
    }
    public clear(): void {
        this.set.clear()
    }
    public forEach(callbackfn: (value: URL, key: URL, map: Set<URL>) => void, thisArg?: any): void {
        // tslint:disable-next-line:ban
        this.set.forEach(value => {
            const url = new URL(value)
            callbackfn.call(thisArg, url, url, this)
        })
    }
    public *entries(): IterableIterator<[URL, URL]> {
        for (const url of this.values()) {
            yield [url, url]
        }
    }
    public *values(): IterableIterator<URL> {
        for (const value of this.set) {
            yield new URL(value)
        }
    }
    public keys(): IterableIterator<URL> {
        return this.values()
    }
    public [Symbol.iterator]() {
        return this.values()
    }
    public [Symbol.toStringTag] = 'URLSet'
}
