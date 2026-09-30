import test from 'node:test';
import assert from 'node:assert/strict';

import {buildServiceHistoryChart, describeServiceHistoryRow, formatServiceHours, goodServicePercent} from '../src/helpers/london-service-history-chart.mjs';

const catalog = [
    {lineId: 'bakerloo', title: 'Bakerloo', color: '#b26300'},
    {lineId: 'central', title: 'Central', color: '#dc241f'},
    {lineId: 'victoria', title: 'Victoria', color: '#0098d8'},
    {lineId: 'waterloo-city', title: 'Waterloo & City', color: '#93ceba'}
];

test('formatServiceHours rounds sensibly', () => {
    assert.equal(formatServiceHours(128.4), '128 h');
    assert.equal(formatServiceHours(4.25), '4.3 h');
    assert.equal(formatServiceHours(1 / 12), '0.1 h');
    assert.equal(formatServiceHours(0), '0 h');
    assert.equal(formatServiceHours(-3), '0 h');
    assert.equal(formatServiceHours(undefined), '0 h');
});

test('buildServiceHistoryChart scales bars to the longest record and lists the most disrupted first', () => {
    const chart = buildServiceHistoryChart({
        lastSampleAt: '2026-09-30T10:00:00.000Z',
        lines: [
            {lineId: 'bakerloo', goodMinutes: 600, disruptedMinutes: 0, closedMinutes: 120},
            {lineId: 'central', goodMinutes: 480, disruptedMinutes: 120, closedMinutes: 120},
            {lineId: 'victoria', goodMinutes: 300, disruptedMinutes: 60, closedMinutes: 0},
            {lineId: 'elizabeth', goodMinutes: 999, disruptedMinutes: 0, closedMinutes: 0}
        ]
    }, catalog);

    assert.deepEqual(chart.rows.map(row => row.lineId), ['central', 'victoria', 'bakerloo']);
    assert.equal(chart.scaleHours, 12);
    const [central, victoria] = chart.rows;
    assert.deepEqual([central.goodWidth, central.disruptedWidth, central.closedWidth], [66.7, 16.7, 16.7]);
    assert.deepEqual([victoria.goodWidth, victoria.disruptedWidth, victoria.closedWidth], [41.7, 8.3, 0]);
    assert.equal(central.goodPercent, 80);
    assert.equal(chart.networkGoodPercent, 88);
    assert.equal(chart.lastSampleAt, Date.parse('2026-09-30T10:00:00.000Z'));
    assert.equal(describeServiceHistoryRow(central),
        'Central: 8 hours of good service, 2 hours disrupted, 2 hours not running, out of 12 hours recorded');
    assert.match(describeServiceHistoryRow({...central, goodHours: 1}), /: 1 hour of good/);
});

test('goodServicePercent never shows 100% when there was disruption', () => {
    assert.equal(goodServicePercent(119, 0.5), 99);
    assert.equal(goodServicePercent(119, 0), 100);
    assert.equal(goodServicePercent(0, 3), 0);
    assert.equal(goodServicePercent(0, 0), null);
    assert.equal(goodServicePercent(3, 1), 75);
});

test('buildServiceHistoryChart copes with no data', () => {
    for (const data of [null, {}, {lines: []}]) {
        const chart = buildServiceHistoryChart(data, catalog);
        assert.deepEqual(chart.rows, []);
        assert.equal(chart.scaleHours, 0);
        assert.equal(chart.networkGoodPercent, null);
        assert.equal(chart.lastSampleAt, null);
    }
    const closedOnly = buildServiceHistoryChart({lines: [{lineId: 'victoria', goodMinutes: 0, disruptedMinutes: 0, closedMinutes: 60}]}, catalog);
    assert.equal(closedOnly.rows[0].goodPercent, null);
    assert.equal(closedOnly.rows[0].closedWidth, 100);
});
