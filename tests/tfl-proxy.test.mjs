import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {buildTflUpstreamUrl, matchTflProxyPath} from '../src/helpers/tfl-proxy.mjs';

test('matchTflProxyPath allows the paths the app uses', () => {
    assert.equal(matchTflProxyPath('/Line/Mode/tube,overground,dlr,elizabeth-line/Status').name, 'line-status');
    assert.equal(matchTflProxyPath('/Line/hammersmith-city/Arrivals').name, 'line-arrivals');
    assert.equal(matchTflProxyPath('/StopPoint/940GZZLUOXC/Arrivals').name, 'stop-point-arrivals');
    assert.equal(matchTflProxyPath('/crowding/940GZZLUBND/Live').name, 'crowding-live');
});

test('matchTflProxyPath refuses everything else', () => {
    for (const path of [
        '',
        'Line/victoria/Arrivals',
        '/Line/Mode/bus/Status',
        '/Line/victoria/Arrivals/extra',
        '/Line/../Arrivals',
        '/StopPoint/940GZZLUOXC',
        '/StopPoint/940GZZLUOXC/Arrivals%2F..',
        '/crowding/940GZZLUBND',
        '/Journey/JourneyResults/a/to/b',
        '//evil.example/Line/victoria/Arrivals'
    ]) {
        assert.equal(matchTflProxyPath(path), null, path);
    }
});

test('buildTflUpstreamUrl stays on the TfL origin and adds the key', () => {
    const url = new URL(buildTflUpstreamUrl('/Line/victoria/Arrivals', 'k'));

    assert.equal(url.origin, 'https://api.tfl.gov.uk');
    assert.equal(url.searchParams.get('app_key'), 'k');
    assert.equal(new URL(buildTflUpstreamUrl('/Line/victoria/Arrivals')).search, '');
});

// The function file is named [[path]].js; copy it to an .mjs so Node loads it as ESM.
async function loadFunction() {
    const dir = await mkdtemp(join(tmpdir(), 'tfl-fn-'));
    const helperDir = join(dir, 'src', 'helpers');
    const fnDir = join(dir, 'functions', 'tfl');
    await import('node:fs/promises').then(fs => Promise.all([fs.mkdir(helperDir, {recursive: true}), fs.mkdir(fnDir, {recursive: true})]));
    await copyFile(new URL('../src/helpers/tfl-proxy.mjs', import.meta.url), join(helperDir, 'tfl-proxy.mjs'));
    await copyFile(new URL('../functions/tfl/[[path]].js', import.meta.url), join(fnDir, 'proxy.mjs'));
    const mod = await import(pathToFileURL(join(fnDir, 'proxy.mjs')));
    return {onRequest: mod.onRequest, cleanup: () => rm(dir, {recursive: true, force: true})};
}

test('the Pages Function injects the key, drops client queries and hides upstream errors', async t => {
    const {onRequest, cleanup} = await loadFunction();
    t.after(cleanup);
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });

    const calls = [];
    globalThis.fetch = async url => {
        calls.push(url);
        return url.includes('/Arrivals') ?
            new Response('[]', {status: 200}) :
            new Response('{"relativeUri":"/crowding?app_key=secret"}', {status: 500});
    };
    const env = {TFL_APP_KEY: 'secret'};

    const ok = await onRequest({request: new Request('https://x.test/tfl/Line/victoria/Arrivals?app_key=evil&foo=1'), env});
    assert.equal(ok.status, 200);
    assert.equal(calls[0], 'https://api.tfl.gov.uk/Line/victoria/Arrivals?app_key=secret');

    const failed = await onRequest({request: new Request('https://x.test/tfl/crowding/940GZZLUBND/Live'), env});
    assert.equal(failed.status, 502);
    assert.equal((await failed.text()).includes('secret'), false);

    const refused = await onRequest({request: new Request('https://x.test/tfl/Journey/JourneyResults/a/to/b'), env});
    assert.equal(refused.status, 404);

    const post = await onRequest({request: new Request('https://x.test/tfl/Line/victoria/Arrivals', {method: 'POST'}), env});
    assert.equal(post.status, 405);
    assert.equal(calls.length, 2);
});
