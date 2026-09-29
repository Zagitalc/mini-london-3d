// Allowlist and request building for the same-origin TfL proxy
// (functions/tfl/[[path]].js). Kept free of Cloudflare globals so it can be
// unit-tested under Node.

export const TFL_UPSTREAM_ORIGIN = 'https://api.tfl.gov.uk';

const STATUS_MODES = new Set(['tube', 'overground', 'dlr', 'elizabeth-line']);
const LINE_ID = /^[a-z][a-z-]{1,31}$/;
const STOP_POINT_ID = /^[0-9A-Za-z]{4,20}$/;

// Each rule matches the path segments after /tfl and gives the edge cache TTL.
const RULES = [
    {
        name: 'line-status',
        ttl: 30,
        match: ([a, b, modes, c]) => a === 'Line' && b === 'Mode' && c === 'Status' &&
            modes.split(',').every(mode => STATUS_MODES.has(mode))
    },
    {
        name: 'line-arrivals',
        ttl: 15,
        match: ([a, lineId, b]) => a === 'Line' && LINE_ID.test(lineId) && b === 'Arrivals'
    },
    {
        name: 'stop-point-arrivals',
        ttl: 15,
        match: ([a, id, b]) => a === 'StopPoint' && STOP_POINT_ID.test(id) && b === 'Arrivals'
    },
    {
        name: 'crowding-live',
        ttl: 60,
        match: ([a, id, b]) => a === 'crowding' && STOP_POINT_ID.test(id) && b === 'Live'
    }
];

/**
 * Resolves a proxied path against the allowlist.
 * @param {string} path - Path after the proxy prefix, e.g. "/Line/victoria/Arrivals".
 * @returns {Object|null} The matched rule name, canonical path and TTL, or null.
 */
export function matchTflProxyPath(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 120) {
        return null;
    }
    const segments = path.slice(1).split('/');
    const rule = segments.length === (segments[0] === 'Line' && segments[1] === 'Mode' ? 4 : 3) &&
        RULES.find(candidate => candidate.match(segments));

    return rule ? {name: rule.name, path, ttl: rule.ttl} : null;
}

/**
 * Builds the upstream URL. Client query strings are never forwarded, so a
 * caller cannot override the key or reach other parameters.
 * @param {string} path - An allowlisted path.
 * @param {string} [appKey] - Server-side TfL app key.
 * @returns {string} The upstream URL.
 */
export function buildTflUpstreamUrl(path, appKey) {
    const url = new URL(`${TFL_UPSTREAM_ORIGIN}${path}`);

    if (appKey) {
        url.searchParams.set('app_key', appKey);
    }
    return url.toString();
}
