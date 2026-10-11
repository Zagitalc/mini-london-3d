import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutLondonTrainMarkers, LONDON_TRAIN_MAX_OFFSET} from '../src/helpers/london-train-layout.mjs';

const train = (id, x = 100, y = 100) => ({
    id, key: `train-${id}`, x, y, halfWidth: 14, halfHeight: 4,
    breadth: 8, nx: 0, ny: 1
});

test('coincident trains occupy distinct selectable slots without changing their logical positions', () => {
    const trains = [train(1), train(2), train(3), train(4)];
    const before = structuredClone(trains);
    const offsets = layoutLondonTrainMarkers(trains);
    assert.deepEqual(trains, before);
    for (let i = 0; i < trains.length; i++) {
        const a = offsets.get(trains[i].id);
        assert.ok(Math.hypot(a.x, a.y) <= LONDON_TRAIN_MAX_OFFSET);
        for (let j = i + 1; j < trains.length; j++) {
            const b = offsets.get(trains[j].id);
            assert.ok(Math.abs(a.x - b.x) >= 30 || Math.abs(a.y - b.y) >= 10);
        }
    }
});

test('layout is deterministic across feed order and stable while a cluster moves', () => {
    const trains = [train(1), train(2), train(3)];
    const first = layoutLondonTrainMarkers(trains);
    assert.deepEqual(layoutLondonTrainMarkers(trains.slice().reverse()), first);
    assert.deepEqual(layoutLondonTrainMarkers(trains.map(t => ({...t, x: t.x + 1})), first), first);
});

test('separated trains return to their true positions and removed IDs disappear', () => {
    const previous = layoutLondonTrainMarkers([train(1), train(2), train(3)]);
    const next = layoutLondonTrainMarkers([train(1), train(2, 200, 200)], previous);
    assert.deepEqual([...next.values()], [{x: 0, y: 0}, {x: 0, y: 0}]);
    assert.equal(next.has(3), false);
    assert.equal(layoutLondonTrainMarkers([]).size, 0);
});

test('dense interchanges never send trains arbitrarily far from their station', () => {
    const trains = Array.from({length: 30}, (_, i) => train(i));
    const offsets = layoutLondonTrainMarkers(trains);
    assert.equal(offsets.size, trains.length);
    for (const {x, y} of offsets.values()) {
        assert.ok(Number.isFinite(x + y));
        assert.ok(Math.hypot(x, y) <= LONDON_TRAIN_MAX_OFFSET);
    }
});
