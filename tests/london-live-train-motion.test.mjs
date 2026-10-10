import test from 'node:test';
import assert from 'node:assert/strict';

import {londonDepartureTiming, londonTrainFacing} from '../src/helpers/london-live-train-motion.mjs';

test('a moving train faces the way its section runs', () => {
    assert.equal(londonTrainFacing(1, -1, -1, -1), 1);
    assert.equal(londonTrainFacing(-1, 1, 1, 1), -1);
});

test('a train standing at a station keeps facing the way it is going', () => {
    // Before the fix, a zero-length section always meant ascending, so a
    // descending train turned round when it arrived and again when it left.
    assert.equal(londonTrainFacing(0, -1, 1, 1), -1, 'where it goes next wins');
    assert.equal(londonTrainFacing(0, 0, -1, 1), -1, 'then how it was last drawn, over a defaulted direction');
    assert.equal(londonTrainFacing(0, 0, undefined, -1), -1, 'then the direction inferred from predictions');
    assert.equal(londonTrainFacing(0, 0), 1, 'ascending only when nothing is known');
});

test('a departing train starts at the platform and arrives when TfL predicts', () => {
    const now = 1_000_000;
    const timing = londonDepartureTiming({nowOffset: now, timeToStation: 120});

    assert.deepEqual(timing, {startOffset: now, endOffset: now + 120000, duration: 120000});
    // So its progress along the section is zero now, not part-way.
    assert.equal((now - timing.startOffset) / timing.duration, 0);
});

test('a departure always animates for a short minimum, even with odd predictions', () => {
    assert.equal(londonDepartureTiming({nowOffset: 0, timeToStation: 3}).duration, 8000);
    assert.equal(londonDepartureTiming({nowOffset: 0, timeToStation: NaN}).duration, 8000);
    assert.equal(londonDepartureTiming({nowOffset: 0, timeToStation: 5, minimumSeconds: 1}).duration, 5000);
});
