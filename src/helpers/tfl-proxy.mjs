// Allowlist and request building for the same-origin TfL proxy
// (functions/tfl/[[path]].js). Kept free of Cloudflare globals so it can be
// unit-tested under Node.

export const TFL_UPSTREAM_ORIGIN = 'https://api.tfl.gov.uk';

const STATUS_MODES = new Set(['tube']);
const LINE_ID = /^[a-z][a-z-]{1,31}$/;
const STOP_POINT_ID = /^[0-9A-Za-z]{4,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TFL_TUBE_LINE_IDS = [
    'bakerloo', 'central', 'circle', 'district', 'hammersmith-city', 'jubilee',
    'metropolitan', 'northern', 'piccadilly', 'victoria', 'waterloo-city'
];
const TUBE_LINES = new Set(TFL_TUBE_LINE_IDS);

// Each rule matches the path segments after /tfl and gives the edge cache TTL.
// `query` is fixed server-side; client query strings are never forwarded.
const RULES = [
    {
        name: 'line-status',
        length: 4,
        ttl: 30,
        match: ([a, b, modes, c]) => a === 'Line' && b === 'Mode' && c === 'Status' &&
            modes.split(',').every(mode => STATUS_MODES.has(mode))
    },
    {
        // TfL has no date-range form of /Line/Mode/{modes}/Status; it takes line IDs.
        name: 'line-status-range',
        length: 6,
        ttl: 300,
        query: {detail: 'true'},
        match: ([a, ids, c, from, to, until]) => a === 'Line' && c === 'Status' &&
            ids.split(',').every(id => TUBE_LINES.has(id)) && DATE.test(from) && to === 'to' && DATE.test(until)
    },
    {
        name: 'line-arrivals',
        length: 3,
        ttl: 15,
        match: ([a, lineId, b]) => a === 'Line' && LINE_ID.test(lineId) && b === 'Arrivals'
    },
    {
        name: 'stop-point-arrivals',
        length: 3,
        ttl: 15,
        match: ([a, id, b]) => a === 'StopPoint' && STOP_POINT_ID.test(id) && b === 'Arrivals'
    },
    {
        name: 'crowding-live',
        length: 3,
        ttl: 60,
        match: ([a, id, b]) => a === 'crowding' && STOP_POINT_ID.test(id) && b === 'Live'
    }
];

/**
 * Resolves a proxied path against the allowlist.
 * @param {string} path - Path after the proxy prefix, e.g. "/Line/victoria/Arrivals".
 * @returns {Object|null} The matched rule name, path, TTL and fixed query, or null.
 */
export function matchTflProxyPath(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 200) {
        return null;
    }
    const segments = path.slice(1).split('/');
    const rule = RULES.find(candidate => candidate.length === segments.length && candidate.match(segments));

    return rule ? {name: rule.name, path, ttl: rule.ttl, query: rule.query || null} : null;
}

/**
 * Builds the upstream URL. Client query strings are never forwarded, so a
 * caller cannot override the key or reach other parameters.
 * @param {string} path - An allowlisted path.
 * @param {string} [appKey] - Server-side TfL app key.
 * @param {Object} [query] - Fixed query parameters from the matched rule.
 * @returns {string} The upstream URL.
 */
export function buildTflUpstreamUrl(path, appKey, query) {
    const url = new URL(`${TFL_UPSTREAM_ORIGIN}${path}`);

    for (const [name, value] of Object.entries(query || {})) {
        url.searchParams.set(name, value);
    }
    if (appKey) {
        url.searchParams.set('app_key', appKey);
    }
    return url.toString();
}
