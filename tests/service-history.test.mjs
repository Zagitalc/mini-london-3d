import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';

import {
    buildServiceSamples,
    classifyLineStatus,
    historyDays,
    londonDay,
    recordServiceSamples,
    sampleSlot,
    shiftDay,
    summariseServiceHistory,
    READ_HISTORY_SQL
} from '../src/helpers/service-history.mjs';
import {collectServiceHistory} from '../workers/service-history/src/index.mjs';
import {onRequest} from '../functions/api/service-history.js';

const WORKER_DIR = new URL('../workers/service-history/', import.meta.url);

// Enough of the D1 binding API, over an in-memory SQLite database, to run the
// real migration and queries.
class FakeD1 {
    constructor() {
        this.db = new DatabaseSync(':memory:');
    }

    prepare(sql) {
        const db = this.db;
        const statement = {
            params: [],
            bind(...params) {
                return {...statement, params};
            },
            async all() {
                return {results: db.prepare(sql).all(...this.params)};
            },
            run() {
                return db.prepare(sql).run(...this.params);
            }
        };
        return statement;
    }

    async batch(statements) {
        this.db.exec('BEGIN');
        try {
            statements.forEach(statement => statement.run());
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
}

async function migratedDb() {
    const d1 = new FakeD1();
    d1.db.exec(await readFile(new URL('migrations/0001_create_service_history.sql', WORKER_DIR), 'utf8'));
    return d1;
}

const status = (statusSeverity, statusSeverityDescription) => ({statusSeverity, statusSeverityDescription});
const line = (id, ...lineStatuses) => ({id, lineStatuses});

// 2026-09-29 23:55 in London (BST) is 22:55 UTC.
const LATE_EVENING = Date.parse('2026-09-29T22:55:00Z');

test('londonDay follows the London calendar across midnight and DST', () => {
    assert.equal(londonDay(Date.parse('2026-09-29T22:59:00Z')), '2026-09-29');
    assert.equal(londonDay(Date.parse('2026-09-29T23:00:00Z')), '2026-09-30');
    assert.equal(londonDay(Date.parse('2026-12-01T23:30:00Z')), '2026-12-01');
    assert.equal(shiftDay('2026-03-29', -1), '2026-03-28');
    assert.equal(shiftDay('2026-10-25', 1), '2026-10-26');
    assert.equal(sampleSlot(Date.parse('2026-09-29T22:57:59Z')), sampleSlot(LATE_EVENING));
});

test('classifyLineStatus takes the worst disruption and treats Service Closed separately', () => {
    assert.deepEqual(classifyLineStatus(line('jubilee', status(10, 'Good Service'))),
        {state: 'good', severity: 10, status: 'Good Service'});
    assert.deepEqual(classifyLineStatus(line('central', status(9, 'Minor Delays'), status(6, 'Severe Delays'), status(10, 'Good Service'))),
        {state: 'disrupted', severity: 6, status: 'Severe Delays'});
    assert.equal(classifyLineStatus(line('district', status(4, 'Planned Closure'))).state, 'disrupted');
    assert.equal(classifyLineStatus(line('victoria', status(20, 'Service Closed'))).state, 'closed');
    assert.equal(classifyLineStatus(line('victoria', status(20, 'Service Closed'), status(5, 'Part Closure'))).state, 'disrupted');
    assert.equal(classifyLineStatus(line('victoria', status(19, 'Information'))).state, 'good');
    assert.equal(classifyLineStatus(line('victoria')), null);
    assert.equal(classifyLineStatus(line('victoria', {statusSeverityDescription: 'Good Service'})), null);
});

test('buildServiceSamples keeps one sample per known tube line', () => {
    const samples = buildServiceSamples([
        line('victoria', status(10, 'Good Service')),
        line('victoria', status(6, 'Severe Delays')),
        line('elizabeth', status(6, 'Severe Delays')),
        line('bakerloo'),
        null
    ], LATE_EVENING);

    assert.deepEqual(samples, [{day: '2026-09-29', slot: sampleSlot(LATE_EVENING), lineId: 'victoria', state: 'good', severity: 10, status: 'Good Service'}]);
});

test('recordServiceSamples stores samples and daily totals without double-counting a repeated run', async () => {
    const db = await migratedDb();
    const run = (data, time) => recordServiceSamples(db, data, time);

    await run([line('victoria', status(10, 'Good Service')), line('central', status(6, 'Severe Delays'))], LATE_EVENING - 600000);
    await run([line('victoria', status(9, 'Minor Delays')), line('central', status(10, 'Good Service'))], LATE_EVENING - 300000);
    await run([line('victoria', status(20, 'Service Closed')), line('central', status(10, 'Good Service'))], LATE_EVENING);
    // Cloudflare can retry a run; the same slot must not count twice.
    await run([line('victoria', status(20, 'Service Closed')), line('central', status(10, 'Good Service'))], LATE_EVENING + 1000);
    // Past London midnight: a new day.
    await run([line('victoria', status(10, 'Good Service'))], LATE_EVENING + 300000);

    const rows = db.db.prepare('SELECT * FROM daily_line_service ORDER BY day, line_id').all().map(row => ({...row}));
    assert.deepEqual(rows, [
        {day: '2026-09-29', line_id: 'central', good_samples: 2, disrupted_samples: 1, closed_samples: 0, last_slot: sampleSlot(LATE_EVENING)},
        {day: '2026-09-29', line_id: 'victoria', good_samples: 1, disrupted_samples: 1, closed_samples: 1, last_slot: sampleSlot(LATE_EVENING)},
        {day: '2026-09-30', line_id: 'victoria', good_samples: 1, disrupted_samples: 0, closed_samples: 0, last_slot: sampleSlot(LATE_EVENING + 300000)}
    ]);
    await assert.rejects(run([], LATE_EVENING), /no tube line statuses/);
});

test('recordServiceSamples prunes old raw samples once a day and keeps the totals', async () => {
    const db = await migratedDb();
    const old = Date.parse('2026-06-01T10:00:00Z');
    const midnightUtc = Date.parse('2026-09-30T00:00:00Z');

    await recordServiceSamples(db, [line('jubilee', status(10, 'Good Service'))], old);
    assert.equal((await recordServiceSamples(db, [line('jubilee', status(10, 'Good Service'))], midnightUtc - 300000)).pruned, false);
    assert.equal((await recordServiceSamples(db, [line('jubilee', status(10, 'Good Service'))], midnightUtc)).pruned, true);

    assert.deepEqual(db.db.prepare('SELECT DISTINCT day FROM status_samples ORDER BY day').all().map(row => row.day), ['2026-09-30']);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM daily_line_service').get().n, 2);
});

test('historyDays ends today in London and clamps the length', () => {
    const now = Date.parse('2026-09-29T23:30:00Z');

    assert.deepEqual(historyDays(now, 3), ['2026-09-28', '2026-09-29', '2026-09-30']);
    assert.equal(historyDays(now, '7').length, 7);
    assert.equal(historyDays(now, null).length, 7);
    assert.equal(historyDays(now, 'x').length, 7);
    assert.equal(historyDays(now, 0).length, 7);
    assert.equal(historyDays(now, -4).length, 1);
    assert.equal(historyDays(now, 999).length, 31);
});

test('summariseServiceHistory converts samples to minutes in line order', () => {
    const summary = summariseServiceHistory([
        {day: '2026-09-29', line_id: 'victoria', good_samples: 200, disrupted_samples: 10, closed_samples: 60, last_slot: 100},
        {day: '2026-09-30', line_id: 'victoria', good_samples: 5, disrupted_samples: 0, closed_samples: 0, last_slot: 120},
        {day: '2026-09-30', line_id: 'bakerloo', good_samples: 1, disrupted_samples: 2, closed_samples: 0, last_slot: 110},
        {day: '2026-09-30', line_id: 'elizabeth', good_samples: 9, disrupted_samples: 0, closed_samples: 0, last_slot: 999},
        {day: '2026-09-20', line_id: 'victoria', good_samples: 9, disrupted_samples: 0, closed_samples: 0, last_slot: 999}
    ], ['2026-09-29', '2026-09-30']);

    assert.equal(summary.from, '2026-09-29');
    assert.equal(summary.to, '2026-09-30');
    assert.equal(summary.lastSampleAt, new Date(120 * 300000).toISOString());
    assert.deepEqual(summary.lines.map(entry => entry.lineId), ['bakerloo', 'victoria']);
    assert.deepEqual(
        {...summary.lines[1], days: summary.lines[1].days.length},
        {lineId: 'victoria', goodMinutes: 1025, disruptedMinutes: 50, closedMinutes: 300, days: 2}
    );
    assert.equal(summariseServiceHistory([], ['2026-09-30']).lastSampleAt, null);
});

test('the Worker fetches with the key, records the run and never surfaces TfL error bodies', async t => {
    const db = await migratedDb();
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    t.after(() => {
        globalThis.fetch = originalFetch;
        console.log = originalLog;
    });
    console.log = () => {};
    const calls = [];
    let reply = new Response(JSON.stringify([line('northern', status(10, 'Good Service'))]), {status: 200});
    globalThis.fetch = async url => {
        calls.push(url);
        return reply;
    };
    const env = {DB: db, TFL_APP_KEY: 'secret'};

    assert.deepEqual(await collectServiceHistory(env, LATE_EVENING), {samples: 1, pruned: false});
    assert.equal(calls[0], 'https://api.tfl.gov.uk/Line/Mode/tube/Status?app_key=secret');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM status_samples').get().n, 1);

    reply = new Response('{"relativeUri":"/Line/Mode/tube/Status?app_key=secret"}', {status: 429});
    await assert.rejects(collectServiceHistory(env, LATE_EVENING), error => error.message === 'TfL 429');

    globalThis.fetch = async () => {
        throw new TypeError('fetch failed: https://api.tfl.gov.uk/?app_key=secret');
    };
    await assert.rejects(collectServiceHistory(env, LATE_EVENING), error => error.message === 'TfL unreachable');
});

test('the read endpoint serves the summary and degrades without a binding', async () => {
    const db = await migratedDb();
    const today = londonDay(Date.now());
    await recordServiceSamples(db, [line('circle', status(10, 'Good Service'))], Date.now());
    const get = (env, query = '', method = 'GET') => onRequest({request: new Request(`https://example.test/api/service-history${query}`, {method}), env});

    const res = await get({DB: db}, '?days=3');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
    const body = await res.json();
    assert.equal(body.to, today);
    assert.equal(body.from, shiftDay(today, -2));
    assert.deepEqual(body.lines.map(entry => [entry.lineId, entry.goodMinutes]), [['circle', 5]]);

    assert.equal((await get({DB: db}, '', 'HEAD')).status, 200);
    assert.equal((await get({DB: db}, '', 'POST')).status, 405);
    assert.deepEqual(await (await get({})).json(), {error: 'not_configured'});
    const broken = {prepare: () => ({bind: () => ({all: async () => { throw new Error('D1_ERROR'); }})})};
    assert.equal((await get({DB: broken})).status, 503);
});

test('wrangler.toml runs every five minutes and binds the database the code expects', async () => {
    const toml = await readFile(new URL('wrangler.toml', WORKER_DIR), 'utf8');

    assert.match(toml, /^crons = \["\*\/5 \* \* \* \*"\]$/m);
    assert.match(toml, /^binding = "DB"$/m);
    assert.match(toml, /^main = "src\/index\.mjs"$/m);
    assert.match(toml, /^workers_dev = false$/m);
    assert.doesNotMatch(toml, /TFL_APP_KEY\s*=/);
    assert.ok(READ_HISTORY_SQL.includes('daily_line_service'));
});
