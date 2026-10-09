import test from 'node:test';
import assert from 'node:assert/strict';

import {TRAIN_RECORDING_SCHEMA, createTrainRecorder, summariseTrainRecording} from '../src/helpers/london-train-recorder.mjs';

const state = (overrides = {}) => ({
    state: 'moving', routeId: 'tfl.victoria.1', direction: 'outbound', stationId: 's1',
    sectionIndex: 3, sectionProgress: 0.4, rendererToken: 'x', observation: {big: 'object'}, ...overrides
});

test('the recorder keeps a rolling window of polls and events', () => {
    let clock = Date.parse('2026-10-07T18:00:00Z');
    const recorder = createTrainRecorder({maxAgeMs: 60000, now: () => clock});
    const poll = () => recorder.recordPoll({timestamp: clock, byLine: new Map([['victoria', {success: true, observationsComplete: true, arrivals: [{vehicleId: '201', timing: {}}]}]])});

    poll();
    recorder.recordEvent('hidden');
    clock += 30000;
    poll();
    recorder.recordEvent('mark', {trackedTrain: 'victoria|201'});
    assert.equal(recorder.pollCount(), 2);
    assert.equal(recorder.markCount(), 1);

    clock += 40000;
    poll();
    assert.equal(recorder.pollCount(), 2, 'the first poll fell out of the window');

    const json = recorder.toJSON({page: 'https://site.test/'});
    assert.equal(json.schema, TRAIN_RECORDING_SCHEMA);
    assert.equal(json.page, 'https://site.test/');
    assert.deepEqual(json.events.map(event => event.type), ['mark'], 'old events go too');
    assert.equal(json.polls[0].lines.victoria.arrivals[0].timing, undefined, 'arrivals are stored compactly');
    assert.equal(JSON.parse(JSON.stringify(json)).polls.length, 2, 'round-trips as JSON');
});

test('decisions keep only the state fields that explain movement', () => {
    const clock = 1000;
    const recorder = createTrainRecorder({now: () => clock});
    recorder.recordPoll({timestamp: clock, byLine: new Map()});
    recorder.recordDecision(clock, {trainKey: 'k', kind: 'rendered', previousState: state(), nextState: state({sectionProgress: 0.123456}), progress: 0.98765});
    recorder.recordDecision(999, {trainKey: 'lost'});

    const [decision] = recorder.toJSON().polls[0].decisions;
    assert.equal(decision.nextState.sectionProgress, 0.123);
    assert.equal(decision.progress, 0.988);
    assert.equal(decision.nextState.observation, undefined);
    assert.equal(decision.nextState.rendererToken, undefined);
    assert.equal(recorder.toJSON().polls[0].decisions.length, 1, 'a decision for an unknown poll is ignored');
});

test('summariseTrainRecording finds rebinds, turns, backward moves, jumps and reappearances', () => {
    const poll = (timestamp, decisions) => ({timestamp, decisions});
    const rendered = (trainKey, before, after, extra = {}) => ({trainKey, lineId: 'victoria', kind: 'rendered', command: 'update', previousState: before, nextState: after, drawnRoute: after.routeId, drawnDirection: 'ascending', ...extra});
    const summary = summariseTrainRecording({polls: [
        poll(0, [rendered('a', null, state())]),
        poll(10000, [
            rendered('a', state(), state({sectionProgress: 0.1})),
            rendered('b', state(), state({sectionIndex: 6})),
            {trainKey: 'c', kind: 'expired', previousState: state(), nextState: state({state: 'expired'})}
        ]),
        poll(20000, [
            rendered('a', state({sectionProgress: 0.1}), state({sectionProgress: 0.2}), {drawnDirection: 'descending'}),
            rendered('c', state({state: 'expired'}), state()),
            rendered('d', state(), state({routeId: 'tfl.victoria.2'}), {command: 'rebind', drawnDirection: 'descending'}),
            {trainKey: 'e', kind: 'discard', previousState: state(), nextState: null},
            // Leaving a platform: a jump along the next section is flagged, a clean start is not.
            rendered('f', state({state: 'dwelling', sectionProgress: 0.99}), state({sectionProgress: 0.4}), {progress: 0.4}),
            rendered('g', state({state: 'dwelling', sectionProgress: 0.99}), state({sectionProgress: 0}), {progress: 0})
        ])
    ]});

    assert.deepEqual(summary.counts, {
        polls: 3, decisions: 10, rebinds: 1, directionFlips: 1, backwardMoves: 1, departureJumps: 1, multiSectionJumps: 1, reappeared: 1, discarded: 1
    });
    assert.deepEqual(summary.examples.map(example => `${example.kind}:${example.trainKey}`).sort(), [
        'backward-move:a', 'departure-jump:f', 'direction-flip:a', 'discard:e', 'multi-section-jump:b', 'reappeared:c', 'rebind:d'
    ]);
    assert.equal(summary.examples.find(example => example.kind === 'rebind').to, 'tfl.victoria.2');
    assert.deepEqual(summariseTrainRecording(null).counts.polls, 0);
});
