import test from 'node:test';
import assert from 'node:assert/strict';

import {buildLondonTrainTimetable, londonTrainSectionProgress, londonTrainTimetableHTML, noteLondonTrainStop} from '../src/helpers/london-train-timetable.mjs';

const stops = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({id, name: id.toUpperCase()}));
const now = Date.parse('2026-10-10T22:20:00Z');
const min = 60000;

test('a train between stations: stops behind are passed, the next has its platform and countdown', () => {
    const history = new Map([['b', {time: now - 2 * min, facing: 1}], ['a', {time: now - 4 * min, facing: -1}]]);
    const timetable = buildLondonTrainTimetable({
        stops, fromIndex: 1, toIndex: 2, history, destinationId: 'f', now,
        predictions: [
            {stationId: 'c', expectedArrival: now + 2 * min, platform: 'Eastbound - Platform 1'},
            {stationId: 'd', expectedArrival: now + 5 * min},
            {stationId: 'a', expectedArrival: now + 9 * min},
            {stationId: 'c', expectedArrival: now + 30 * min}
        ]
    });

    assert.deepEqual(timetable.rows.map(row => `${row.name}:${row.status}`), ['A:passed', 'B:passed', 'C:next', 'D:upcoming', 'E:upcoming', 'F:upcoming']);
    assert.equal(timetable.rows[0].time, undefined, 'a record from the other direction is ignored, and so is a prediction behind it');
    assert.equal(timetable.rows[1].time, now - 2 * min);
    assert.equal(timetable.rows[2].time, now + 2 * min, 'the soonest prediction wins');
    assert.equal(timetable.rows[2].etaLabel, '2 min');
    assert.equal(timetable.rows[2].platform, 'Eastbound · Platform 1');
    assert.equal(timetable.rows[3].platform, undefined);
    assert.equal(timetable.rows[4].time, undefined, 'beyond the predictions there is no time');
    assert.deepEqual([timetable.fromRow, timetable.toRow], [1, 2]);
});

test('going down the route, the list runs backwards and stops at the terminus', () => {
    const timetable = buildLondonTrainTimetable({stops, fromIndex: 4, toIndex: 3, destinationId: 'b', now, predictions: []});
    assert.deepEqual(timetable.rows.map(row => `${row.name}:${row.status}`), ['F:passed', 'E:passed', 'D:next', 'C:upcoming', 'B:upcoming']);
    assert.deepEqual([timetable.fromRow, timetable.toRow], [1, 2]);
});

test('without a known terminus the list ends at the last predicted stop', () => {
    const timetable = buildLondonTrainTimetable({stops, fromIndex: 0, toIndex: 1, destinationId: 'nowhere', now,
        predictions: [{stationId: 'b', expectedArrival: now + min}, {stationId: 'd', expectedArrival: now + 4 * min}]});
    assert.deepEqual(timetable.rows.map(row => row.name), ['A', 'B', 'C', 'D']);
});

test('at a platform, the station is current and the direction comes from the facing', () => {
    const timetable = buildLondonTrainTimetable({stops, fromIndex: 2, toIndex: 2, facing: -1, destinationId: 'a', now,
        predictions: [{stationId: 'c', expectedArrival: now, platform: 'Westbound - Platform 2'}, {stationId: 'b', expectedArrival: now + 2 * min}]});
    assert.deepEqual(timetable.rows.map(row => `${row.name}:${row.status}`), ['F:passed', 'E:passed', 'D:passed', 'C:current', 'B:upcoming', 'A:upcoming']);
    assert.equal(timetable.rows[3].platform, 'Westbound · Platform 2');
    assert.equal(timetable.rows[3].etaLabel, undefined);
    assert.equal(buildLondonTrainTimetable({stops, fromIndex: 9, toIndex: 2, now}), null, 'an unknown position gives nothing');
});

test('stop history keeps the departure time, and replaces records from the other way or an earlier trip', () => {
    const history = new Map();
    noteLondonTrainStop(history, {stationId: 'c', time: now, facing: 1, atStation: true});
    noteLondonTrainStop(history, {stationId: 'c', time: now + 30000, facing: 1, atStation: true});
    noteLondonTrainStop(history, {stationId: 'c', time: now + 20000, facing: 1, atStation: false});
    assert.equal(history.get('c').time, now + 30000, 'the estimate after leaving does not overwrite the last sighting');
    noteLondonTrainStop(history, {stationId: 'c', time: now + 10 * min, facing: -1, atStation: false});
    assert.deepEqual(history.get('c'), {time: now + 10 * min, facing: -1});
    noteLondonTrainStop(history, {stationId: 'c', time: now + 4 * 60 * min, facing: -1, atStation: false});
    assert.equal(history.get('c').time, now + 4 * 60 * min);
    noteLondonTrainStop(history, {stationId: '', time: now, facing: 1});
    assert.equal(history.size, 1);
});

test('section progress is time-based and clamped', () => {
    assert.equal(londonTrainSectionProgress(0, 100, 25), 0.25);
    assert.equal(londonTrainSectionProgress(0, 100, 150), 1);
    assert.equal(londonTrainSectionProgress(0, 100, -5), 0);
    assert.equal(londonTrainSectionProgress(NaN, 100, 50), 0.5);
});

test('the HTML greys passed stops and escapes names', () => {
    const timetable = buildLondonTrainTimetable({stops: [{id: 'a', name: 'King\'s <X>'}, ...stops.slice(1, 3)], fromIndex: 0, toIndex: 1, now,
        predictions: [{stationId: 'b', expectedArrival: now + 3 * min, platform: 'Platform 1'}, {stationId: 'c', expectedArrival: now + 6 * min}]});
    const html = londonTrainTimetableHTML(timetable, {colour: '#005ae4', formatTime: () => '22:23'});
    assert.match(html, /--line-color:#005ae4/);
    assert.match(html, /is-passed"><span class="london-timetable-dot"><\/span><div class="london-timetable-copy"><strong>King&#39;s &lt;X&gt;<\/strong>/);
    assert.match(html, /is-next" aria-current="step">.*<span>Platform 1<\/span>.*<strong>3 min<\/strong><span>22:23<\/span>/);
    assert.match(html, /is-upcoming">.*<span class="london-timetable-eta">6 min<\/span>/);
    assert.match(londonTrainTimetableHTML(null, {colour: '#000', formatTime: String}), /london-empty-state/);
});
