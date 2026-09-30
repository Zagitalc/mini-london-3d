// Serves GET /api/service-history?days=7: minutes of good, disrupted and
// closed service per tube line per London day, from the D1 database the
// scheduled Worker in workers/service-history writes to. Needs the Pages D1
// binding DB; reads only.

import {READ_HISTORY_SQL, historyDays, summariseServiceHistory} from '../../src/helpers/service-history.mjs';

function json(body, status, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...extraHeaders
        }
    });
}

export async function onRequest({request, env}) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({error: 'method_not_allowed'}, 405, {Allow: 'GET, HEAD'});
    }
    if (!env.DB) {
        return json({error: 'not_configured'}, 503);
    }

    const days = historyDays(Date.now(), new URL(request.url).searchParams.get('days'));
    let rows;
    try {
        ({results: rows} = await env.DB.prepare(READ_HISTORY_SQL).bind(days[0], days[days.length - 1]).all());
    } catch (e) {
        return json({error: 'unavailable'}, 503);
    }

    // New samples land every five minutes.
    const body = request.method === 'HEAD' ? null : JSON.stringify(summariseServiceHistory(rows, days));
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
            'X-Content-Type-Options': 'nosniff'
        }
    });
}
