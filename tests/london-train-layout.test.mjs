import test from 'node:test';
import assert from 'node:assert/strict';
import {clampLondonTrainOffset, getLondonTrainOffsetLimit, getMinimumPixelsPerMetre, layoutLondonTrainMarkers, LONDON_TRAIN_MAX_OFFSET} from '../src/helpers/london-train-layout.mjs';

const train = (id, x = 100, y = 100) => ({
    id, key: `train-${id}`, x, y, halfWidth: 14, halfHeight: 4,
    breadth: 8, nx: 0, ny: 1, maxOffset: 40
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


test('overview trains stay exactly anchored even after a close-up layout', () => {
    const close = [train(1), train(2), train(3)];
    const previous = layoutLondonTrainMarkers(close);
    for (const zoom of [9, 11, 13, 14, 15]) {
        const overview = close.map(t => ({...t, maxOffset: getLondonTrainOffsetLimit(zoom, 100)}));
        assert.deepEqual([...layoutLondonTrainMarkers(overview, previous).values()],
            [{x: 0, y: 0}, {x: 0, y: 0}, {x: 0, y: 0}]);
    }
});

test('fractional zoom smoothly limits separation by both metres and pixels', () => {
    let previous = new Map();
    for (const zoom of [15, 15.1, 15.5, 16, 17, 18, 22, 17, 16, 15.5, 15.1, 15]) {
        const pixelsPerMetre = 2 ** (zoom - 17);
        const limit = getLondonTrainOffsetLimit(zoom, pixelsPerMetre);
        assert.ok(limit <= 40 && limit <= pixelsPerMetre * 20);
        const markers = Array.from({length: 12}, (_, i) => ({...train(i), maxOffset: limit}));
        previous = layoutLondonTrainMarkers(markers, previous);
        for (const offset of previous.values()) assert.ok(Math.hypot(offset.x, offset.y) <= limit + 1e-9);
    }
    assert.equal(getLondonTrainOffsetLimit(16, 1), 10);
    assert.equal(getLondonTrainOffsetLimit(18, 10), 40);
    assert.deepEqual(clampLondonTrainOffset({x: 24, y: 32}, 10), {x: 6, y: 8});
    assert.deepEqual(clampLondonTrainOffset({x: 24, y: 32}, 0), {x: 0, y: 0});
});

test('metre budget uses the narrowest direction under rotation and perspective', () => {
    const origin = {x: 5, y: 8};
    assert.equal(getMinimumPixelsPerMetre(origin, {x: 8, y: 12}, {x: 1, y: 11}), 5);
    assert.ok(Math.abs(getMinimumPixelsPerMetre(origin, {x: 7, y: 8}, {x: 6, y: 9}) - 0.8740320489) < 1e-9);
    assert.equal(getMinimumPixelsPerMetre(origin, origin, origin), 0);
});


test('pitched perspective budget stays inside the ground-distance disc', () => {
    const limit = getLondonTrainOffsetLimit(18, 1, 0.01);
    assert.ok(Math.abs(limit - 20 / 1.2) < 1e-10);
    assert.ok(limit / (1 - limit * 0.01) <= 20 + 1e-10);
    assert.equal(getLondonTrainOffsetLimit(18, NaN), 0);
});
