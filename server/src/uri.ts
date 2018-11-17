import RelateUrl from 'relateurl'

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
export const relativeUrl = (from: string | URL, to: string | URL): string =>
    RelateUrl.relate(from.toString(), to.toString(), RELATE_URL_OPTIONS)
