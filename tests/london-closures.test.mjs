import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';

import {
    expandLondonClosurePairs,
    extractLondonClosurePairs,
    extractLondonClosures,
    getLondonCorridorNaptans,
    getLondonWeekendWindow,
    isLondonSegmentClosed,
    normalizeLondonStationName
} from '../src/helpers/london-closures.mjs';

const load = async file => JSON.parse(gunzipSync(await readFile(new URL(`../assets/london-build-data/${file}`, import.meta.url))));
const stations = await load('stations.json.gz');
const railways = await load('railways.json.gz');
const naptan = id => String(id).split('.').pop().toUpperCase();

// Mirrors how the map builds the per-line index from the snapshot.
function getLineIndex(lineId) {
    const nameIndex = new Map();
    for (const station of stations) {
        if (!station.id.startsWith(`tfl.${lineId}.`)) continue;
        const name = normalizeLondonStationName(station.title.en);
        nameIndex.set(name, [...new Set([...(nameIndex.get(name) || []), naptan(station.id)])]);
    }
    const sequences = railways.filter(r => r.lineId === lineId).map(r => r.stations.map(naptan));
    return nameIndex.size ? {nameIndex, sequences} : null;
}

const WINDOW = getLondonWeekendWindow(Date.parse('2026-10-01T12:00:00Z'));
const status = (description, reason, extra = {}) => ({
    statusSeverityDescription: description,
    reason,
    validityPeriods: [{fromDate: '2026-10-03T04:30:00Z', toDate: '2026-10-04T23:30:00Z'}],
    ...extra
});

test('getLondonWeekendWindow picks the coming weekend, or the current one', () => {
    assert.equal(WINDOW.saturday, '2026-10-03');
    assert.equal(WINDOW.monday, '2026-10-05');
    // 00:00 London on 3 October is 23:00 UTC on the 2nd (BST).
    assert.equal(new Date(WINDOW.from).toISOString(), '2026-10-02T23:00:00.000Z');

    assert.equal(getLondonWeekendWindow(Date.parse('2026-10-04T15:00:00Z')).saturday, '2026-10-03');
    assert.equal(getLondonWeekendWindow(Date.parse('2026-10-05T08:00:00Z')).saturday, '2026-10-10');
    // Winter time: midnight London equals midnight UTC.
    assert.equal(new Date(getLondonWeekendWindow(Date.parse('2026-12-02T12:00:00Z')).from).toISOString(), '2026-12-05T00:00:00.000Z');
});

test('normalizeLondonStationName lines up TfL prose with snapshot titles', () => {
    assert.equal(normalizeLondonStationName("St. Paul's"), normalizeLondonStationName("St Paul's Underground Station"));
    assert.equal(normalizeLondonStationName('Hammersmith (H&C Line)'), 'hammersmith');
    assert.equal(normalizeLondonStationName('Paddington (H&C Line)-Underground'), 'paddington');
    assert.equal(normalizeLondonStationName('Heathrow Terminals 2 & 3'), 'heathrow terminals 2 and 3');
});

test('extractLondonClosurePairs reads "between A and B", including slashed branch ends', () => {
    const index = getLineIndex('piccadilly');
    const pairs = extractLondonClosurePairs(
        'PICCADILLY LINE: Saturday 3 and Sunday 4 October, no service between Acton Town and Uxbridge / Rayners Lane. Replacement buses operate.',
        index.nameIndex
    );

    assert.deepEqual(pairs, [[['940GZZLUACT'], ['940GZZLUUXB']], [['940GZZLUACT'], ['940GZZLURYL']]]);
});

test('extractLondonClosures places a text-only part closure on the right stations', () => {
    const [closure] = extractLondonClosures([{
        id: 'district',
        lineStatuses: [status('Part Closure', "DISTRICT LINE: No service between Earl's Court and Wimbledon while we carry out track work.")]
    }], WINDOW, getLineIndex);

    assert.equal(closure.placed, true);
    assert.equal(closure.wholeLine, false);
    assert.ok(closure.stops.includes('940GZZLUECT'));
    assert.ok(closure.stops.includes('940GZZLUPYB')); // Putney Bridge, in between
    assert.ok(closure.stops.includes('940GZZLUWIM'));
    assert.ok(!closure.stops.includes('940GZZLUKOY')); // Kensington (Olympia) branch is not closed
    assert.ok(!closure.stops.includes('940GZZLUUPM')); // Upminster, far east
});

test('extractLondonClosures prefers TfL affected stops and keeps unplaceable closures', () => {
    const closures = extractLondonClosures([
        {id: 'victoria', lineStatuses: [status('Part Closure', 'No service between somewhere and elsewhere.', {
            disruption: {affectedStops: [{naptanId: '940GZZLUBXN'}, {naptanId: '940GZZLUSKW'}]}
        })]},
        {id: 'jubilee', lineStatuses: [status('Part Closure', 'Reduced service because of works.')]},
        {id: 'waterloo-city', lineStatuses: [status('Planned Closure', 'No service all weekend.')]},
        {id: 'central', lineStatuses: [status('Good Service', '')]},
        {id: 'bakerloo', lineStatuses: [status('Part Closure', 'Next month.', {
            validityPeriods: [{fromDate: '2026-11-07T04:30:00Z', toDate: '2026-11-08T23:30:00Z'}]
        })]}
    ], WINDOW, getLineIndex);

    assert.deepEqual(closures.map(c => [c.lineId, c.placed, c.wholeLine]), [
        ['victoria', true, false],
        ['jubilee', false, false],
        ['waterloo-city', true, true]
    ]);
    assert.deepEqual(closures[0].stops, ['940GZZLUBXN', '940GZZLUSKW']);
});

test('isLondonSegmentClosed checks both ends on the same line', () => {
    const closuresByLine = new Map([
        ['district', [{wholeLine: false, stops: ['940GZZLUECT', '940GZZLUWBN']}]],
        ['waterloo-city', [{wholeLine: true, stops: []}]]
    ]);
    const segment = (lineId, a, b) => ({lineId, corridorId: `${lineId}-${a.toLowerCase()}__${lineId}-${b.toLowerCase()}__osm-1`});

    assert.deepEqual(getLondonCorridorNaptans('bakerloo-940gzzlubst__bakerloo-940gzzlumyb__osm-relation-1'), ['940GZZLUBST', '940GZZLUMYB']);
    assert.equal(isLondonSegmentClosed(segment('district', '940GZZLUECT', '940GZZLUWBN'), closuresByLine), true);
    assert.equal(isLondonSegmentClosed(segment('district', '940GZZLUECT', '940GZZLUGTR'), closuresByLine), false);
    assert.equal(isLondonSegmentClosed(segment('piccadilly', '940GZZLUECT', '940GZZLUWBN'), closuresByLine), false);
    assert.equal(isLondonSegmentClosed(segment('waterloo-city', '940GZZLUWLO', '940GZZLUBNK'), closuresByLine), true);
});

test('real weekend shape: overnight Jubilee closures are listed but only the daytime one is drawn', () => {
    // Periods and stretches from TfL's response for 3-4 October 2026.
    const jubilee = getLineIndex('jubilee');
    const stretch = reason => [...expandLondonClosurePairs(extractLondonClosurePairs(reason, jubilee.nameIndex), jubilee.sequences)]
        .map(naptanId => ({naptanId}));
    const longStretch = stretch('no service between Finchley Road and Stratford.');
    const shortStretch = stretch('no service between Green Park and Canary Wharf.');
    const jubileeStatus = (from, to, stops) => ({
        statusSeverityDescription: 'Part Closure',
        reason: `JUBILEE LINE: closure ${from}`,
        validityPeriods: [{fromDate: from, toDate: to}],
        disruption: {affectedStops: stops}
    });
    const closures = extractLondonClosures([
        {id: 'jubilee', lineStatuses: [
            jubileeStatus('2026-10-03T00:30:00Z', '2026-10-03T03:30:00Z', longStretch),
            jubileeStatus('2026-10-03T03:30:00Z', '2026-10-04T00:29:00Z', shortStretch),
            jubileeStatus('2026-10-04T00:30:00Z', '2026-10-04T04:30:00Z', longStretch),
            jubileeStatus('2026-10-04T04:30:00Z', '2026-10-05T00:29:00Z', shortStretch)
        ]},
        {id: 'waterloo-city', lineStatuses: [{
            statusSeverityDescription: 'Planned Closure',
            reason: 'Waterloo & City line: service operates 06:00 until 00:30, Monday to Friday only.',
            validityPeriods: [
                {fromDate: '2026-10-03T03:15:00Z', toDate: '2026-10-03T22:59:00Z'},
                {fromDate: '2026-10-04T03:15:00Z', toDate: '2026-10-04T22:59:00Z'}
            ]
        }]}
    ], WINDOW, getLineIndex);

    assert.ok(longStretch.length > shortStretch.length);
    assert.deepEqual(closures.map(c => [c.lineId, c.brief, c.placed]), [
        ['jubilee', true, false],
        ['jubilee', false, true],
        ['jubilee', true, false],
        ['jubilee', false, true],
        ['waterloo-city', false, true]
    ]);

    const byLine = new Map();
    for (const closure of closures.filter(c => c.placed)) byLine.set(closure.lineId, [...(byLine.get(closure.lineId) || []), closure]);
    const segment = (a, b) => ({lineId: 'jubilee', corridorId: `jubilee-${a.toLowerCase()}__jubilee-${b.toLowerCase()}__osm-1`});

    assert.equal(isLondonSegmentClosed(segment('940GZZLUWLO', '940GZZLUSWK'), byLine), true); // Waterloo-Southwark
    assert.equal(isLondonSegmentClosed(segment('940GZZLUBST', '940GZZLUBND'), byLine), false); // Baker Street-Bond Street
    assert.equal(isLondonSegmentClosed(segment('940GZZLUWHM', '940GZZLUSTD'), byLine), false); // West Ham-Stratford
});
