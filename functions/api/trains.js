// Serves GET /api/trains: live arrival predictions for every tube line in one
// response, so each browser makes one request per poll instead of eleven.
//
// The TfL key lives in the Pages secret TFL_APP_KEY and never reaches the
// browser. TfL error bodies can echo the request URI, key included, so only
// status codes are passed on. Complete responses are shared from the edge
// cache for a few seconds; partial failures are not cached.

import {TFL_TUBE_LINE_IDS, buildTflUpstreamUrl} from '../../src/helpers/tfl-proxy.mjs';
import {buildTrainFeed, isTrainFeedComplete} from '../../src/helpers/london-train-feed.mjs';

const CACHE_SECONDS = 10;

function json(body, status, cacheControl) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': cacheControl,
            'X-Content-Type-Options': 'nosniff'
        }
    });
}

async function fetchLine(lineId, appKey) {
    try {
        const response = await fetch(buildTflUpstreamUrl(`/Line/${lineId}/Arrivals`, appKey), {
            headers: {Accept: 'application/json'}
        });
        if (!response.ok) {
            return {lineId, ok: false, status: response.status};
        }
        return {lineId, ok: true, arrivals: await response.json()};
    } catch (e) {
        return {lineId, ok: false, status: 0};
    }
}

export async function onRequest({request, env, waitUntil}) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({error: 'method_not_allowed'}, 405, 'no-store');
    }

    // One cache entry for everyone: client query strings are ignored.
    const cacheKey = new Request(new URL('/api/trains', request.url).toString(), {method: 'GET'});
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cached = cache ? await cache.match(cacheKey) : null;
    if (cached) {
        return request.method === 'HEAD' ? new Response(null, cached) : cached;
    }

    const feed = buildTrainFeed(await Promise.all(TFL_TUBE_LINE_IDS.map(id => fetchLine(id, env.TFL_APP_KEY))), Date.now());
    const complete = isTrainFeedComplete(feed);
    const anyOk = Object.values(feed.lines).some(line => line.ok);
    const response = json(feed, anyOk ? 200 : 502, complete ? `public, max-age=${CACHE_SECONDS}` : 'no-store');

    if (cache && complete) {
        const store = cache.put(cacheKey, response.clone());
        if (typeof waitUntil === 'function') waitUntil(store); else await store;
    }
    return request.method === 'HEAD' ? new Response(null, response) : response;
}
