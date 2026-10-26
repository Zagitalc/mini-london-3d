import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const configSource = await readFile(new URL('../src/configs.js', import.meta.url), 'utf8');
const configs = (await import(`data:text/javascript,${encodeURIComponent(configSource)}`)).default;
const animationSource = await readFile(new URL('../src/animation.js', import.meta.url), 'utf8');
const mapSource = await readFile(new URL('../src/map.js', import.meta.url), 'utf8');

function animationHarness() {
    let now = 0;
    const frames = [], errors = [];
    const context = vm.createContext({
        performance: {now: () => now},
        requestAnimationFrame: callback => frames.push(callback),
        console: {error: (...args) => errors.push(args)},
        valueOrDefault: (value, fallback) => value === undefined ? fallback : value
    });
    vm.runInContext(animationSource.replace(/^import .*;\n/m, '').replace('export default animation;', 'globalThis.animation = animation;'), context);
    return {animation: context.animation, errors, step(time) {now = time; assert.ok(frames.length); frames.shift()();}};
}

test('a throwing animation cannot stop other callbacks or future frames, and retries with backoff', () => {
    const {animation, errors, step} = animationHarness();
    let attempts = 0, healthy = 0;
    animation.start({callback() {if (++attempts === 1) throw new Error('transient startup failure');}});
    animation.start({callback() {healthy++;}});
    animation.init();
    assert.equal(healthy, 1);
    step(16);
    assert.equal(healthy, 2);
    assert.equal(attempts, 1);
    step(1000);
    assert.equal(attempts, 2);
    step(1016);
    assert.equal(attempts, 3);
    assert.equal(errors.length, 1);
});

test('a failing completion callback is removed and does not prevent other animations', () => {
    const {animation, errors, step} = animationHarness();
    let healthy = 0, completions = 0;
    const id = animation.start({duration: 0, complete() {completions++; throw new Error('completion');}});
    animation.start({callback() {healthy++;}});
    animation.init();
    step(16);
    assert.equal(animation.isActive(id), false);
    assert.equal(completions, 1);
    assert.equal(healthy, 2);
    assert.equal(errors.length, 1);
});

// Execute the actual map animation registration with a deterministic clock and
// stand-ins for GPU/network work. No browser or real requests in this test.
function mapLoopHarness(ecoMode) {
    const start = mapSource.indexOf('        animation.start({', mapSource.indexOf('        animation.init();'));
    const end = mapSource.indexOf('\n        me.initialized = true;', start);
    let stamp = 0, callback;
    const calls = {sunlight: 0, realtime: 0, repaint: 0, outline: 0};
    const me = {
        clock: {getTime: () => 1700000000000 + stamp, getTimeOffset: () => stamp, speed: 1},
        lastTimetableRefresh: 1700000000000, lastFrameRefresh: 1700000000000,
        lastRepaint: 0, ecoMode, ecoFrameRate: 30,
        searchMode: 'none', clockMode: 'realtime', adTrains: [],
        trackedObject: {type: 'station'}, detailPanel: {updateContent() {}},
        trafficLayer: {setTimeOffset() {}},
        setMapSunlight() {calls.sunlight++;},
        refreshRealtimeTrainData() {calls.realtime++;},
        refreshRealtimeFlightData() {}, refreshRealtimeBusData() {},
        refreshStationOutline() {calls.outline++;}, stopAll() {}
    };
    vm.runInNewContext(mapSource.slice(start, end), {
        me, configs,
        map: {_loaded: true, getLayer() {}, triggerRepaint() {calls.repaint++;}},
        animation: {start(options) {callback = options.callback;}},
        performance: {now: () => stamp}, Date: {now: () => 1700000000000 + stamp},
        isVehicle: () => false, isStation: object => object?.type === 'station'
    });
    return {calls, step(time) {stamp = time; callback();}};
}

test('refreshes stay at their configured cadence across thousands of display frames', () => {
    const {calls, step} = mapLoopHarness('normal');
    for (let frame = 0; frame < 120 * 60; frame++) step(frame * 1000 / 120);
    assert.equal(calls.sunlight, 2, 'initial refresh plus one minute boundary');
    assert.equal(calls.realtime, 5, 'initial refresh plus four 15-second boundaries');
    assert.equal(calls.repaint, 7200);
});

test('Eco gates both redraws and station outline mutations to 30 FPS on a 120 Hz display', () => {
    const {calls, step} = mapLoopHarness('eco');
    for (let frame = 0; frame <= 1200; frame++) step(frame * 1000 / 120);
    assert.ok(calls.repaint >= 299 && calls.repaint <= 301, `${calls.repaint} redraws in ten seconds`);
    assert.equal(calls.outline, calls.repaint);
    assert.equal(calls.realtime, 2, 'initial refresh plus the aligned 15-second boundary');
});

test('London cannot call the Tokyo flight loader even when invoked directly', () => {
    const start = mapSource.indexOf('    refreshRealtimeFlightData() {');
    const end = mapSource.indexOf('\n    refreshRealtimeBusData(', start);
    let requests = 0;
    const flight = vm.runInNewContext(`({${mapSource.slice(start, end)}})`, {
        configs, loadDynamicFlightData() {requests++; throw new Error('unexpected Tokyo request');}
    });
    flight.refreshRealtimeFlightData.call({city: 'london'});
    assert.equal(requests, 0);
});
