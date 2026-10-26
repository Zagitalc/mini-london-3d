import assert from 'node:assert/strict';
import test from 'node:test';
import {layoutLondonStationPins} from '../src/helpers/london-station-map.mjs';

test('nearby and coincident endpoint labels remain legible without moving their geographic anchors', () => {
    for (const [start, end] of [
        [[170, 140], [180, 137]],
        [[170, 140], [170, 140]],
        [[0, 0], [1, 1]],
        [[358, 299], [358, 299]]
    ]) {
        const original = structuredClone([start, end]);
        const pins = layoutLondonStationPins(start, end);
        assert.deepEqual(pins.map(pin => pin.anchor), original);
        assert.deepEqual([start, end], original, 'map coordinates must not be mutated');
        assert.ok(Math.hypot(pins[1].position[0] - pins[0].position[0], pins[1].position[1] - pins[0].position[1]) >= 40);
        for (const pin of pins) {
            assert.equal(pin.displaced, true);
            assert.ok(pin.position[0] >= 14 && pin.position[0] <= 346);
            assert.ok(pin.position[1] >= 14 && pin.position[1] <= 286);
        }
    }
});

test('well-separated endpoint labels stay at their actual map positions', () => {
    const pins = layoutLondonStationPins([100, 100], [200, 200]);
    assert.deepEqual(pins.map(pin => pin.position), [[100, 100], [200, 200]]);
    assert.ok(pins.every(pin => !pin.displaced));
});
