// Same-origin TfL proxy for Cloudflare Pages.
//
// Serves GET /tfl/<allowlisted TfL path>. The TfL key lives in the Pages
// secret TFL_APP_KEY and never reaches the browser. Anything outside the
// allowlist in src/helpers/tfl-proxy.mjs is refused, so this cannot be used
// as an open proxy.

import {buildTflUpstreamUrl, matchTflProxyPath} from '../../src/helpers/tfl-proxy.mjs';

const PREFIX = '/tfl';

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
    // Says whether the secret is bound, never its value.
    const keyHeader = {'X-TfL-Proxy-Key': env.TFL_APP_KEY ? 'set' : 'missing'};

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({error: 'method_not_allowed'}, 405, {Allow: 'GET, HEAD', ...keyHeader});
    }

    const {pathname} = new URL(request.url);
    const route = pathname.startsWith(`${PREFIX}/`) ? matchTflProxyPath(pathname.slice(PREFIX.length)) : null;

    if (!route) {
        return json({error: 'not_allowed'}, 404, keyHeader);
    }

    let upstream;
    try {
        upstream = await fetch(buildTflUpstreamUrl(route.path, env.TFL_APP_KEY), {
            headers: {Accept: 'application/json'},
            // Cache successes only, so a 429 or 5xx is not replayed to other visitors.
            cf: {cacheEverything: true, cacheTtlByStatus: {'200-299': route.ttl, '300-599': -1}}
        });
    } catch (e) {
        return json({error: 'upstream_unreachable'}, 502, keyHeader);
    }

    // TfL error bodies can echo the request URI, key included, so only the
    // status is passed on.
    if (!upstream.ok) {
        return json({error: 'upstream_error', status: upstream.status}, upstream.status === 429 ? 429 : 502, keyHeader);
    }

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${route.ttl}`,
            'X-Content-Type-Options': 'nosniff',
            ...keyHeader
        }
    });
}
