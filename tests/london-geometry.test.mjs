import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getLondonStationAnchor,
    getOrderedLondonStationOffsets,
    smoothLondonStationLine,
    shouldUseStationOrderGeometry
} from '../src/helpers/london-geometry.mjs';

test('getOrderedLondonStationOffsets returns cumulative distances', () => {
    const offsets = getOrderedLondonStationOffsets([
        [-0.1, 51.5],
        [-0.11, 51.5],
        [-0.12, 51.5]
    ]);

    assert.equal(offsets.length, 3);
    assert.equal(offsets[0], 0);
    assert.ok(offsets[2] > offsets[1]);
});

test('shouldUseStationOrderGeometry rejects non-monotonic projected offsets', () => {
    assert.equal(
        shouldUseStationOrderGeometry(
            [0, 10, 4, 18],
            [[-0.1, 51.5], [-0.11, 51.5], [-0.12, 51.5], [-0.13, 51.5]]
        ),
        true
    );
});

test('shouldUseStationOrderGeometry rejects projected jumps that are far larger than direct station gaps', () => {
    assert.equal(
        shouldUseStationOrderGeometry(
            [0, 55, 56],
            [[-0.1, 51.5], [-0.1005, 51.5], [-0.101, 51.5]]
        ),
        true
    );
});

test('getLondonStationAnchor chooses a real station coordinate instead of averaging', () => {
    const anchor = getLondonStationAnchor([
        { coord: [-0.1, 51.5] },
        { coord: [-0.101, 51.5002] },
        { coord: [-0.2, 51.6] }
    ]);

    assert.deepEqual(anchor, [-0.101, 51.5002]);
});

test('smoothLondonStationLine keeps endpoints and adds intermediate points', () => {
    const coords = [
        [-0.1, 51.5],
        [-0.11, 51.51],
        [-0.12, 51.5]
    ];
    const smoothed = smoothLondonStationLine(coords);

    assert.deepEqual(smoothed[0], coords[0]);
    assert.ok(Math.abs(smoothed[smoothed.length - 1][0] - coords[coords.length - 1][0]) < 1e-9);
    assert.ok(Math.abs(smoothed[smoothed.length - 1][1] - coords[coords.length - 1][1]) < 1e-9);
    assert.ok(smoothed.length > coords.length);
});
