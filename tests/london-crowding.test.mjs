import test from 'node:test';
import assert from 'node:assert/strict';

import {describeLondonCrowding, selectLondonCrowdingReading} from '../src/helpers/london-crowding.mjs';

test('selectLondonCrowdingReading skips stop points without data', () => {
    const reading = selectLondonCrowdingReading([
        null,
        {dataAvailable: false},
        {dataAvailable: true, percentageOfBaseline: 0.42, timeLocal: '2026-09-29 08:15:00'}
    ]);

    assert.deepEqual(reading, {ratio: 0.42, timeLocal: '2026-09-29 08:15:00'});
    assert.equal(selectLondonCrowdingReading([{dataAvailable: true}]), null);
    assert.equal(selectLondonCrowdingReading(undefined), null);
});

test('describeLondonCrowding maps the ratio to meter tones', () => {
    assert.equal(describeLondonCrowding({ratio: 0.2}, 'Bank').tone, 'good');
    assert.equal(describeLondonCrowding({ratio: 0.7}, 'Bank').tone, 'minor');

    const busy = describeLondonCrowding({ratio: 1.3}, 'Bank');
    assert.equal(busy.tone, 'severe');
    assert.equal(busy.percent, 100);
    assert.match(busy.detail, /130%/);
});

test('describeLondonCrowding falls back to a no-data state', () => {
    const empty = describeLondonCrowding(null, 'Bank');

    assert.equal(empty.status, 'No data');
    assert.equal(empty.percent, 0);
    assert.match(empty.detail, /Bank/);
});
