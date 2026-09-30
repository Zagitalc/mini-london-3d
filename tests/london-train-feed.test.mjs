import test from 'node:test';
import assert from 'node:assert/strict';

import {TFL_TUBE_LINE_IDS} from '../src/helpers/tfl-proxy.mjs';
import {
    TRAIN_ARRIVAL_FIELDS,
    buildTrainFeed,
    compactArrival,
    isTrainFeedComplete,
    readTrainFeed
} from '../src/helpers/london-train-feed.mjs';
import {normalizeTfLObservations} from '../src/helpers/london-live-train-observations.mjs';
import {onRequest} from '../functions/api/trains.js';

// A prediction shaped like TfL's /Line/{id}/Arrivals output.
const tflPrediction = (overrides = {}) => ({
    $type: 'Tfl.Api.Presentation.Entities.Prediction, Tfl.Api.Presentation.Entities',
    id: '-1234567890',
    operationType: 1,
    vehicleId: '201',
    naptanId: '940GZZLUBST',
    stationName: 'Baker Street Underground Station',
    lineId: 'jubilee',
    lineName: 'Jubilee',
    platformName: 'Southbound - Platform 7',
    direction: 'outbound',
    bearing: '',
    destinationNaptanId: '940GZZLUSTD',
    destinationName: 'Stratford Underground Station',
    timestamp: '2026-09-30T17:00:00.1234567Z',
    timeToStation: 95,
    currentLocation: 'Approaching St. John\'s Wood',
    towards: 'Stratford',
    expectedArrival: '2026-09-30T17:01:35Z',
    timeToLive: '2026-09-30T17:01:35Z',
    modeName: 'tube',
    timing: {
        $type: 'Tfl.Api.Presentation.Entities.PredictionTiming, Tfl.Api.Presentation.Entities',
        countdownServerAdjustment: '00:00:00',
        source: '0001-01-01T00:00:00',
        insert: '0001-01-01T00:00:00',
        read: '2026-09-30T17:00:00.123Z',
        sent: '2026-09-30T17:00:00Z',
        received: '0001-01-01T00:00:00Z'
    },
    ...overrides
});

test('compactArrival keeps exactly the fields the live-train code reads', () => {
    const raw = tflPrediction();
    const compact = compactArrival(raw);

    assert.deepEqual(Object.keys(compact).sort(), [
        'currentLocation', 'destinationName', 'destinationNaptanId', 'direction', 'expectedArrival',
        'lineId', 'naptanId', 'platformName', 'stationName', 'timeToStation', 'towards', 'vehicleId'
    ]);
    assert.ok(Object.keys(compact).every(key => TRAIN_ARRIVAL_FIELDS.includes(key)));
    assert.equal(compactArrival({vehicleId: '', timeToStation: 0}).timeToStation, 0, 'zero survives');
    assert.equal(compactArrival({vehicleId: ''}).vehicleId, undefined, 'empty strings are dropped');
    assert.equal(compactArrival(null).vehicleId, undefined);

    const saving = 1 - JSON.stringify(compact).length / JSON.stringify(raw).length;
    assert.ok(saving > 0.5, `expected to save over half the bytes, saved ${Math.round(saving * 100)}%`);
});

test('compact predictions produce the same observations as full ones', () => {
    const raw = [
        tflPrediction(),
        tflPrediction({naptanId: '940GZZLUBND', stationName: 'Bond Street Underground Station', timeToStation: 185, expectedArrival: '2026-09-30T17:03:05Z'}),
        tflPrediction({vehicleId: '', currentLocation: 'At Finchley Road', timeToStation: 30})
    ];
    const context = {lineId: 'jubilee', timestamp: Date.parse('2026-09-30T17:00:00Z')};
    const strip = observations => observations.map(({raw: _raw, predictions, ...rest}) => ({
        ...rest,
        predictions: predictions.map(({raw: _r, ...prediction}) => prediction)
    }));

    assert.deepEqual(
        strip(normalizeTfLObservations(raw.map(compactArrival), context)),
        strip(normalizeTfLObservations(raw, context))
    );
});

test('buildTrainFeed and readTrainFeed round-trip per-line results', () => {
    const feed = buildTrainFeed([
        {lineId: 'jubilee', ok: true, arrivals: [tflPrediction()]},
        {lineId: 'central', ok: false, status: 429},
        {lineId: 'victoria', ok: true, arrivals: 'not an array'},
        null
    ], Date.parse('2026-09-30T17:00:00Z'));

    assert.equal(feed.generatedAt, '2026-09-30T17:00:00.000Z');
    assert.deepEqual(feed.lines.central, {ok: false, status: 429});
    assert.deepEqual(feed.lines.victoria, {ok: true, arrivals: []});
    assert.equal(isTrainFeedComplete(feed), false);
    assert.equal(isTrainFeedComplete({lines: {}}), false);
    assert.equal(isTrainFeedComplete(buildTrainFeed([{lineId: 'jubilee', ok: true, arrivals: []}], 0)), true);

    const polls = readTrainFeed(feed, ['jubilee', 'central', 'northern']);
    assert.equal(polls.get('jubilee').success, true);
    assert.equal(polls.get('jubilee').arrivals[0].vehicleId, '201');
    assert.deepEqual(polls.get('central'), {arrivals: [], success: false, observationsComplete: false});
    assert.deepEqual(polls.get('northern'), {arrivals: [], success: false, observationsComplete: false}, 'missing lines count as failed polls');
    assert.equal(readTrainFeed(null, ['jubilee']).get('jubilee').success, false);
});

function mockCache() {
    const store = new Map();
    return {
        store,
        match: async request => store.get(request.url)?.clone(),
        put: async (request, response) => { store.set(request.url, response); }
    };
}

test('the /api/trains Function fetches every line with the key, caches complete feeds and hides upstream errors', async t => {
    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;
    t.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.caches = originalCaches;
    });
    const cache = mockCache();
    globalThis.caches = {default: cache};
    const calls = [];
    let failLine = null;
    globalThis.fetch = async url => {
        calls.push(url);
        const lineId = url.match(/\/Line\/([^/]+)\/Arrivals/)[1];
        return lineId === failLine ?
            new Response('{"relativeUri":"/Line/x/Arrivals?app_key=secret"}', {status: 500}) :
            new Response(JSON.stringify([tflPrediction({lineId})]), {status: 200});
    };
    const env = {TFL_APP_KEY: 'secret'};
    const get = (query = '', method = 'GET') => onRequest({request: new Request(`https://site.test/api/trains${query}`, {method}), env, waitUntil: p => p});

    const first = await get('?lines=jubilee&app_key=evil');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Cache-Control'), 'public, max-age=10');
    const body = await first.json();
    assert.deepEqual(Object.keys(body.lines).sort(), [...TFL_TUBE_LINE_IDS].sort());
    assert.equal(calls.length, TFL_TUBE_LINE_IDS.length);
    assert.ok(calls.every(url => new URL(url).searchParams.get('app_key') === 'secret'), 'server key, never the client one');
    assert.ok(!JSON.stringify(body).includes('secret'));
    assert.equal(body.lines.jubilee.arrivals[0].timing, undefined, 'unused fields dropped');

    // A second request, with any query string, is served from the cache.
    const second = await get('?other=1');
    assert.equal((await second.json()).generatedAt, body.generatedAt);
    assert.equal(calls.length, TFL_TUBE_LINE_IDS.length);

    // A partial failure is served but not cached, and never leaks TfL's body.
    cache.store.clear();
    failLine = 'central';
    const partial = await get();
    assert.equal(partial.status, 200);
    assert.equal(partial.headers.get('Cache-Control'), 'no-store');
    const partialText = await partial.text();
    assert.ok(!partialText.includes('secret'));
    assert.deepEqual(JSON.parse(partialText).lines.central, {ok: false, status: 500});
    assert.equal(cache.store.size, 0);

    // Every line failing is a 502.
    globalThis.fetch = async () => { throw new TypeError('network down: https://api.tfl.gov.uk/?app_key=secret'); };
    const down = await get();
    assert.equal(down.status, 502);
    assert.ok(!(await down.text()).includes('secret'));

    assert.equal((await get('', 'POST')).status, 405);
    const head = await get('', 'HEAD');
    assert.equal(head.status, 502);
    assert.equal(await head.text(), '');
});
