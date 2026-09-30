import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';

import {normalizeLondonCorridorEndpoints, slugifyIdentity} from '../src/helpers/london-route-display.mjs';
import {londonLineSequences, organiseLondonRailDisplay} from '../src/helpers/london-lane-order.mjs';
import {estimatePlatformPoint, metresBetween, placeLondonPlatforms, withLondonPlatforms} from '../src/helpers/london-station-platforms.mjs';

// About 1 m in degrees of latitude.
const M = 1 / 111195;
const feature = (from, to, lineId, coordinates, source = 'osm') => {
    const ends = normalizeLondonCorridorEndpoints(from, to);
    const corridorId = [slugifyIdentity(ends.fromGroup), slugifyIdentity(ends.toGroup), 'a'].join('__');
    // Real corridors are drawn from the station whose id sorts first.
    const oriented = ends.reversed ? coordinates.slice().reverse() : coordinates;
    return {type: 'Feature', geometry: {type: 'LineString', coordinates: oriented}, properties: {type: 'railway', corridorId, lineId, geometrySource: source}};
};

test('estimatePlatformPoint recovers where the track passes the station', () => {
    // Anchor 40 m east of a north-south track; the next vertices are on the track.
    const anchor = [40 * M * 1.6, 51.5];
    const result = estimatePlatformPoint([anchor, [0, 51.5 + 100 * M], [0, 51.5 + 300 * M]]);

    assert.ok(Math.abs(result.coord[0]) < 1e-9, 'on the track');
    assert.ok(Math.abs(result.coord[1] - 51.5) < 2 * M, 'level with the station');
    assert.ok(Math.abs(result.bearing - 180) < 1, 'track heads south into the station');
    assert.equal(estimatePlatformPoint([anchor, [0, 51.5]]), null, 'needs two real vertices');
    assert.equal(estimatePlatformPoint([[1, 51.5], [0, 51.5 + 100 * M], [0, 51.5 + 300 * M]]), null, 'too far to be the same station');
});

test('lines on separate tracks get their own platform points, joined by a link', () => {
    // Station S: line "deep" runs north-south 60 m west of the anchor,
    // lines "sub1" and "sub2" share an east-west track through the anchor.
    const s = [0, 51.5];
    const west = -60 * M * 1.6;
    const features = [
        feature('tfl.s', 'tfl.n', 'deep', [s, [west, 51.5 + 100 * M], [west, 51.5 + 400 * M]]),
        feature('tfl.s', 'tfl.x', 'deep', [s, [west, 51.5 - 100 * M], [west, 51.5 - 400 * M]]),
        feature('tfl.s', 'tfl.e', 'sub1', [s, [100 * M * 1.6, 51.5], [400 * M * 1.6, 51.5]]),
        feature('tfl.s', 'tfl.e', 'sub2', [s, [100 * M * 1.6, 51.5], [400 * M * 1.6, 51.5]]),
        feature('tfl.s', 'tfl.w', 'sub1', [s, [-100 * M * 1.6, 51.5], [-400 * M * 1.6, 51.5]])
    ];
    const {platforms, features: moved} = placeLondonPlatforms(features);
    const station = platforms.get('s');

    assert.equal(station.points.length, 2);
    assert.deepEqual(station.points.map(p => p.lineIds), [['sub1', 'sub2'], ['deep']]);
    assert.deepEqual(station.links, [[0, 1]]);
    assert.ok(metresBetween(station.points[1].coord, [west, 51.5]) < 2, 'deep platform is on its own track');
    assert.ok(metresBetween(station.points[0].coord, s) < 2, 'sub-surface platform stays on its track');

    // Both of a line's corridors now meet at its own platform point.
    const atS = f => (f.properties.corridorId.startsWith('s__') ? f.geometry.coordinates[0] : f.geometry.coordinates.at(-1));
    const start = atS;
    assert.deepEqual(start(moved[0]), start(moved[1]));
    assert.deepEqual(start(moved[2]), start(moved[4]));
    assert.deepEqual(start(moved[2]), start(moved[3]), 'lines sharing a corridor share its geometry');
    assert.deepEqual(atS(features[0]), s, 'input features are not mutated');
});

test('fallback geometry keeps its anchor, and nearby points merge', () => {
    const s = [0, 51.5];
    const features = [
        feature('tfl.s', 'tfl.n', 'a', [s, [5 * M * 1.6, 51.5 + 100 * M], [5 * M * 1.6, 51.5 + 400 * M]]),
        feature('tfl.s', 'tfl.e', 'b', [s, [100 * M * 1.6, 51.5 + 5 * M], [400 * M * 1.6, 51.5 + 5 * M]]),
        feature('tfl.s', 'tfl.w', 'c', [s, [-1, 52]], 'fallback')
    ];
    const {platforms} = placeLondonPlatforms(features);
    assert.equal(platforms.get('s').points.length, 1, 'all within the merge distance');
    assert.deepEqual(platforms.get('s').points[0].lineIds, ['a', 'b', 'c']);
    assert.equal(withLondonPlatforms(null), null);
    assert.deepEqual(placeLondonPlatforms(null).features, []);
});

test('on the real London data, interchanges split where the lines really stop, and routes stay continuous', () => {
    const load = name => JSON.parse(gunzipSync(readFileSync(new URL(`../assets/london-build-data/${name}`, import.meta.url))));
    const railways = load('railways.json.gz');
    const groups = load('station-groups.json.gz');
    const sequences = londonLineSequences(railways, groups);
    const {features: organised} = organiseLondonRailDisplay(load('london-route-display.json.gz').features, sequences);
    const data = withLondonPlatforms({type: 'FeatureCollection', features: organised});

    const bakerStreet = data.platforms['bakerloo-940gzzlubst'];
    assert.deepEqual(bakerStreet.points.map(p => p.lineIds.join('+')).sort(),
        ['bakerloo', 'circle+hammersmith-city+metropolitan', 'jubilee']);
    assert.equal(bakerStreet.links.length, 2);

    // No end moves further than the cap.
    data.features.forEach((f, i) => {
        const before = organised[i].geometry.coordinates;
        const after = f.geometry.coordinates;
        assert.ok(metresBetween(before[0], after[0]) <= 150 && metresBetween(before.at(-1), after.at(-1)) <= 150, f.properties.corridorId);
    });

    // Consecutive corridors along every line still meet exactly.
    const byKey = new Map(data.features.map(f => {
        const [a, b] = f.properties.corridorId.split('__');
        return [`${f.properties.lineId}|${a}|${b}`, f];
    }));
    let joins = 0;
    for (const sequence of sequences) {
        let previousEnd = null;
        for (let i = 0; i + 1 < sequence.groups.length; i++) {
            const ends = normalizeLondonCorridorEndpoints(sequence.groups[i], sequence.groups[i + 1]);
            const f = byKey.get(`${sequence.lineId}|${slugifyIdentity(ends.fromGroup)}|${slugifyIdentity(ends.toGroup)}`);
            if (!f) {
                previousEnd = null;
                continue;
            }
            const coords = ends.reversed ? f.geometry.coordinates.slice().reverse() : f.geometry.coordinates;
            if (previousEnd) {
                joins++;
                assert.ok(metresBetween(previousEnd, coords[0]) < 0.01, `${sequence.lineId} at ${sequence.groups[i]}`);
            }
            previousEnd = coords.at(-1);
        }
    }
    assert.ok(joins > 600);
});
