// One combined live-train feed for all tube lines, served by the Pages
// Function at functions/api/trains.js, so each browser makes one request per
// poll instead of one per line. Only the fields the live-train code reads are
// kept (see london-live-train-observations.mjs); every prediction is kept,
// because the animation uses the following station as well as the next.
// Kept free of Cloudflare and DOM globals so it can be unit-tested.

export const TRAIN_FEED_PATH = '/api/trains';

// Fields read by normalizeTfLObservations and the train renderer.
export const TRAIN_ARRIVAL_FIELDS = [
    'vehicleId', 'lineId', 'naptanId', 'stationId', 'stationName',
    'platformName', 'platform', 'direction', 'destinationName', 'destination',
    'destinationNaptanId', 'towards', 'currentLocation', 'timeToStation',
    'expectedArrival', 'atStation'
];

/**
 * Keeps only the fields the map uses from one TfL arrival prediction.
 * @param {Object} raw - A TfL Prediction object.
 * @returns {Object} The same prediction with unused fields removed.
 */
export function compactArrival(raw) {
    const out = {};

    for (const field of TRAIN_ARRIVAL_FIELDS) {
        const value = raw && raw[field];
        if (value !== undefined && value !== null && value !== '') {
            out[field] = value;
        }
    }
    return out;
}

/**
 * Builds the combined feed from per-line results.
 * @param {Array<Object>} results - One {lineId, ok, status, arrivals} per line.
 * @param {number} now - Unix time in milliseconds when the fetch started.
 * @returns {Object} {generatedAt, lines: {lineId: {ok, status?, arrivals?}}}.
 */
export function buildTrainFeed(results, now) {
    const lines = {};

    for (const result of results || []) {
        if (!result || !result.lineId) continue;
        lines[result.lineId] = result.ok ?
            {ok: true, arrivals: (Array.isArray(result.arrivals) ? result.arrivals : []).map(compactArrival)} :
            {ok: false, status: Number.isInteger(result.status) ? result.status : 0};
    }
    return {generatedAt: new Date(now).toISOString(), lines};
}

/**
 * Whether a feed can be shared from the edge cache: only when every line loaded.
 * @param {Object} feed - From buildTrainFeed.
 * @returns {boolean} True if cacheable.
 */
export function isTrainFeedComplete(feed) {
    const entries = Object.values((feed && feed.lines) || {});
    return entries.length > 0 && entries.every(line => line.ok);
}

/**
 * Turns a feed into the per-line poll results the live-train code expects.
 * Lines missing from the feed count as failed polls, so their trains go
 * stale rather than vanishing.
 * @param {Object} feed - The /api/trains response.
 * @param {Array<string>} lineIds - Lines the map is showing.
 * @returns {Map} lineId to {arrivals, success, observationsComplete}.
 */
export function readTrainFeed(feed, lineIds) {
    const byLine = new Map();
    const lines = (feed && feed.lines) || {};

    for (const lineId of lineIds || []) {
        const line = lines[lineId];
        const ok = !!(line && line.ok && Array.isArray(line.arrivals));

        byLine.set(lineId, {arrivals: ok ? line.arrivals : [], success: ok, observationsComplete: ok});
    }
    return byLine;
}
