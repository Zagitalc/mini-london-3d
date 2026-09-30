import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';

import {normalizeLondonCorridorEndpoints, slugifyIdentity} from '../src/helpers/london-route-display.mjs';
import {
    londonLineSequences,
    mergeLondonFallbackCorridors,
    orderLondonLanes,
    organiseLondonRailDisplay,
    organiseLondonRailDisplayData
} from '../src/helpers/london-lane-order.mjs';

const feature = (from, to, lineId, {alignment = 'osm-a', source = 'osm', offset = 0, coordinates = [[0, 0], [1, 1]]} = {}) => {
    const ends = normalizeLondonCorridorEndpoints(from, to);
    const corridorId = [slugifyIdentity(ends.fromGroup), slugifyIdentity(ends.toGroup), alignment].join('__');
    return {
        type: 'Feature',
        geometry: {type: 'LineString', coordinates},
        properties: {type: 'railway', id: `${corridorId}__${lineId}`, corridorId, alignmentId: alignment, lineId, laneOffset: offset, geometrySource: source}
    };
};

// Where each line sits relative to its own direction of travel, station by
// station. A change of sign is the line swapping sides of the bundle.
function sidesAlong(features, sequence) {
    const lookup = new Map(features.map(f => {
        const [a, b] = f.properties.corridorId.split('__');
        return [`${f.properties.lineId}|${a}|${b}`, f];
    }));
    const sides = [];
    for (let i = 0; i + 1 < sequence.groups.length; i++) {
        const ends = normalizeLondonCorridorEndpoints(sequence.groups[i], sequence.groups[i + 1]);
        const f = lookup.get(`${sequence.lineId}|${slugifyIdentity(ends.fromGroup)}|${slugifyIdentity(ends.toGroup)}`);
        if (f) sides.push(f.properties.laneOffset * (ends.reversed ? -1 : 1));
    }
    return sides;
}

const countSwaps = sides => sides.slice(1).filter((side, i) => Math.sign(side) && Math.sign(sides[i]) && Math.sign(side) !== Math.sign(sides[i])).length;

test('orderLondonLanes keeps two lines on the same sides where the drawing direction flips', () => {
    // Stations named so that A-M is drawn A->M but M-B is drawn B->M: the
    // second corridor points against the direction of travel.
    const features = [
        feature('tfl.a', 'tfl.m', 'circle'), feature('tfl.a', 'tfl.m', 'district'),
        feature('tfl.m', 'tfl.b', 'circle'), feature('tfl.m', 'tfl.b', 'district')
    ];
    const sequences = [
        {lineId: 'district', groups: ['tfl.a', 'tfl.m', 'tfl.b']},
        {lineId: 'circle', groups: ['tfl.b', 'tfl.m', 'tfl.a']}
    ];
    const {features: ordered, conflicts} = orderLondonLanes(features, sequences);

    assert.equal(conflicts, 0);
    for (const sequence of sequences) {
        const sides = sidesAlong(ordered, sequence);
        assert.equal(sides.length, 2);
        assert.equal(countSwaps(sides), 0, `${sequence.lineId}: ${sides}`);
        assert.ok(sides.every(side => Math.abs(side) === 0.5));
    }
    // One network-wide order: the District is on the other side from the Circle.
    const offsets = corridor => ordered.filter(f => f.properties.corridorId.startsWith(corridor)).map(f => f.properties.laneOffset);
    assert.deepEqual(offsets('a__m').sort(), [-0.5, 0.5]);
    assert.ok(ordered.every(f => f.geometry.coordinates === features.find(g => g.properties.id === f.properties.id).geometry.coordinates),
        'geometry is untouched');
});

test('a line alone in its corridor is centred, and unknown features pass through', () => {
    const lone = feature('tfl.a', 'tfl.b', 'victoria', {offset: 2});
    const station = {type: 'Feature', geometry: {type: 'Point', coordinates: [0, 0]}, properties: {type: 'station'}};
    const {features} = orderLondonLanes([lone, station], [{lineId: 'victoria', groups: ['tfl.a', 'tfl.b']}]);

    assert.equal(features[0].properties.laneOffset, 0);
    assert.equal(features[0].properties.laneCount, 1);
    assert.equal(features[1], station);
    assert.deepEqual(orderLondonLanes(null, null).features, []);
});

test('mergeLondonFallbackCorridors moves fallback lines onto the OSM corridor between the same stations', () => {
    const osm = [[0, 0], [0.5, 0.2], [1, 1]];
    const features = [
        feature('tfl.p', 'tfl.q', 'district', {alignment: 'osm-1', coordinates: osm}),
        feature('tfl.p', 'tfl.q', 'circle', {alignment: 'fallback-circle', source: 'fallback', coordinates: [[0, 0], [1, 1]]}),
        // Separate tunnels: both OSM, so they stay apart.
        feature('tfl.x', 'tfl.y', 'bakerloo', {alignment: 'osm-2'}),
        feature('tfl.x', 'tfl.y', 'northern', {alignment: 'osm-3'}),
        // Fallback with nothing to join stays as it is.
        feature('tfl.r', 'tfl.s', 'circle', {alignment: 'fallback-2', source: 'fallback'})
    ];
    const {features: merged, merged: count} = mergeLondonFallbackCorridors(features);

    assert.equal(count, 1);
    assert.equal(merged[1].properties.corridorId, merged[0].properties.corridorId);
    assert.equal(merged[1].geometry, merged[0].geometry);
    assert.equal(merged[1].properties.id, `${merged[0].properties.corridorId}__circle`);
    assert.equal(merged[1].properties.lineId, 'circle');
    assert.notEqual(merged[2].properties.corridorId, merged[3].properties.corridorId);
    assert.equal(merged[4], features[4]);

    const {features: organised} = organiseLondonRailDisplay(features, [
        {lineId: 'district', groups: ['tfl.p', 'tfl.q']},
        {lineId: 'circle', groups: ['tfl.p', 'tfl.q']}
    ]);
    assert.deepEqual(organised.slice(0, 2).map(f => f.properties.laneCount), [2, 2], 'now drawn as one two-lane bundle');
});

test('londonLineSequences maps every station to its group', () => {
    const sequences = londonLineSequences(
        [{lineId: 'circle', stations: ['tfl.circle.X', 'tfl.circle.Y']}, {lineId: 'bad'}],
        [[['tfl.bakerloo.X', 'tfl.circle.X']]]
    );
    assert.deepEqual(sequences, [{lineId: 'circle', groups: ['tfl.bakerloo.X', 'tfl.circle.Y']}]);
    assert.equal(organiseLondonRailDisplayData(null, [], []), null);
});

test('on the real London data, no line swaps sides of a shared bundle', () => {
    const load = name => JSON.parse(gunzipSync(readFileSync(new URL(`../assets/london-build-data/${name}`, import.meta.url))));
    const display = load('london-route-display.json.gz');
    const sequences = londonLineSequences(load('railways.json.gz'), load('station-groups.json.gz'));
    const swaps = features => sequences.reduce((sum, sequence) => sum + countSwaps(sidesAlong(features, sequence)), 0);

    assert.ok(swaps(display.features) > 50, 'the committed snapshot on its own does zigzag');

    const {features, merged, conflicts} = organiseLondonRailDisplay(display.features, sequences);
    assert.equal(swaps(features), 0);
    assert.equal(merged, 6, 'the Circle joins the shared track at six station pairs');
    assert.ok(conflicts <= 1);
    assert.equal(features.length, display.features.length);
    for (const {properties: p} of features) {
        assert.ok(Math.abs(p.laneOffset) <= (p.laneCount - 1) / 2, p.id);
    }
    assert.equal(organiseLondonRailDisplayData(display, load('railways.json.gz'), load('station-groups.json.gz')).features.length, features.length);
});
