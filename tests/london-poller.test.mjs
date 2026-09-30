import test from 'node:test';
import assert from 'node:assert/strict';

import {createDocumentVisibility, createPoller} from '../src/helpers/london-poller.mjs';

// Manual timers: nothing fires until the test calls tick().
function fakeTimers() {
    const pending = new Map();
    let nextId = 1;
    return {
        setTimer: (fn, ms) => {
            pending.set(nextId, {fn, ms});
            return nextId++;
        },
        clearTimer: id => pending.delete(id),
        pending: () => pending.size,
        delays: () => [...pending.values()].map(entry => entry.ms),
        async tick() {
            const entries = [...pending.entries()];
            pending.clear();
            for (const [, {fn}] of entries) fn();
            await settle();
        }
    };
}

function fakeVisibility(hidden = false) {
    const listeners = new Set();
    return {
        isHidden: () => hidden,
        onVisible(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        listeners: () => listeners.size,
        async set(value) {
            hidden = value;
            if (!hidden) for (const listener of [...listeners]) listener();
            await settle();
        }
    };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('runs at once, then schedules the next run only after the previous one finishes', async () => {
    const timers = fakeTimers();
    const visibility = fakeVisibility();
    let calls = 0;
    let release;
    const poller = createPoller(() => {
        calls++;
        return new Promise(resolve => { release = resolve; });
    }, {intervalMs: 10000, visibility, ...timers});

    poller.start();
    await settle();
    assert.equal(calls, 1);
    assert.equal(timers.pending(), 0, 'nothing scheduled while the first run is in flight');

    release();
    await settle();
    assert.deepEqual(timers.delays(), [10000]);

    await timers.tick();
    assert.equal(calls, 2);
    poller.stop();
});

test('skips runs while the tab is hidden and runs once as soon as it is visible again', async () => {
    const timers = fakeTimers();
    const visibility = fakeVisibility();
    let calls = 0;
    const poller = createPoller(() => { calls++; }, {intervalMs: 60000, visibility, ...timers});

    poller.start();
    await settle();
    assert.equal(calls, 1);

    await visibility.set(true);
    await timers.tick();
    assert.equal(calls, 1, 'no fetch while hidden');
    assert.equal(timers.pending(), 0, 'no timers left running while hidden');

    await visibility.set(false);
    assert.equal(calls, 2, 'polls straight away on return');
    assert.equal(timers.pending(), 1, 'and resumes the schedule');

    // Becoming visible without a missed run does not trigger an extra fetch.
    await visibility.set(true);
    await visibility.set(false);
    assert.equal(calls, 2);
    poller.stop();
});

test('a poller started in a hidden tab waits for the page to become visible', async () => {
    const timers = fakeTimers();
    const visibility = fakeVisibility(true);
    let calls = 0;
    const poller = createPoller(() => { calls++; }, {intervalMs: 1000, visibility, ...timers});

    poller.start();
    await settle();
    assert.equal(calls, 0);
    await visibility.set(false);
    assert.equal(calls, 1);
    poller.stop();
});

test('stop cancels the timer, ignores an in-flight run and detaches from visibility', async () => {
    const timers = fakeTimers();
    const visibility = fakeVisibility();
    let release;
    let calls = 0;
    const poller = createPoller(() => {
        calls++;
        return new Promise(resolve => { release = resolve; });
    }, {intervalMs: 5000, visibility, ...timers});

    poller.start();
    await settle();
    assert.equal(poller.isRunning(), true);
    poller.stop();
    assert.equal(poller.isRunning(), false);
    assert.equal(visibility.listeners(), 0);

    release();
    await settle();
    assert.equal(timers.pending(), 0, 'a run that finishes after stop does not reschedule');

    await visibility.set(true);
    await visibility.set(false);
    assert.equal(calls, 1);
});

test('restarting replaces the previous schedule instead of adding a second one', async () => {
    const timers = fakeTimers();
    const visibility = fakeVisibility();
    let calls = 0;
    const poller = createPoller(() => { calls++; }, {intervalMs: 1000, visibility, ...timers});

    poller.start();
    await settle();
    poller.start();
    await settle();
    assert.equal(calls, 2);
    assert.equal(timers.pending(), 1);
    assert.equal(visibility.listeners(), 1);
    poller.stop();
});

test('errors are reported and polling carries on', async () => {
    const timers = fakeTimers();
    const errors = [];
    let calls = 0;
    const poller = createPoller(() => {
        calls++;
        throw new Error(`TfL ${calls === 1 ? 429 : 500}`);
    }, {intervalMs: 1000, visibility: fakeVisibility(), onError: e => errors.push(e.message), ...timers});

    poller.start();
    await settle();
    await timers.tick();
    assert.deepEqual(errors, ['TfL 429', 'TfL 500']);
    assert.equal(timers.pending(), 1);
    poller.stop();
});

test('createDocumentVisibility notifies listeners only when the page becomes visible', () => {
    const doc = new EventTarget();
    doc.hidden = false;
    const visibility = createDocumentVisibility(doc);
    let calls = 0;
    const unsubscribe = visibility.onVisible(() => { calls++; });

    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(visibility.isHidden(), true);
    assert.equal(calls, 0);

    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(calls, 1);

    unsubscribe();
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(calls, 1);
    assert.equal(createDocumentVisibility(null).isHidden(), false);
});
