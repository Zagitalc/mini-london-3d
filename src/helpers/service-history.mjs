// Service history: tube line status sampled every five minutes by the
// scheduled Worker in workers/service-history, stored in D1, and read back by
// the Pages Function at functions/api/service-history.js. Kept free of
// Cloudflare globals so it can be unit-tested under Node.

import {TFL_TUBE_LINE_IDS} from './tfl-proxy.mjs';

export const SAMPLE_MINUTES = 5;
const SAMPLE_MS = SAMPLE_MINUTES * 60000;
const DAY_MS = 86400000;

// Raw samples are pruned after this many days; the daily totals are kept.
export const SAMPLE_RETENTION_DAYS = 90;
export const MAX_HISTORY_DAYS = 31;

// TfL statusSeverity codes. 10 Good Service, 18 No Issues and 19 Information
// count as good; 20 Service Closed is outside operating hours. Everything
// else (delays, suspensions, planned closures, ...) counts as disrupted.
const GOOD_SEVERITIES = new Set([10, 18, 19]);
const CLOSED_SEVERITIES = new Set([20]);
const TUBE_LINES = new Set(TFL_TUBE_LINE_IDS);

const londonDateFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

export const INSERT_SAMPLE_SQL =
    'INSERT OR IGNORE INTO status_samples (day, line_id, slot, state, severity, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)';

// Recomputed from the raw samples rather than incremented, so a repeated or
// retried run cannot double-count.
export const ROLLUP_DAY_SQL = [
    'INSERT OR REPLACE INTO daily_line_service (day, line_id, good_samples, disrupted_samples, closed_samples, last_slot)',
    "SELECT day, line_id, SUM(state = 'good'), SUM(state = 'disrupted'), SUM(state = 'closed'), MAX(slot)",
    'FROM status_samples WHERE day = ?1 GROUP BY day, line_id'
].join(' ');

export const PRUNE_SAMPLES_SQL = 'DELETE FROM status_samples WHERE day < ?1';

export const READ_HISTORY_SQL = [
    'SELECT day, line_id, good_samples, disrupted_samples, closed_samples, last_slot',
    'FROM daily_line_service WHERE day >= ?1 AND day <= ?2 ORDER BY day, line_id'
].join(' ');

/**
 * The calendar date in London for a timestamp.
 * @param {number} ms - Unix time in milliseconds.
 * @returns {string} Date as YYYY-MM-DD.
 */
export function londonDay(ms) {
    const parts = Object.fromEntries(londonDateFormat.formatToParts(new Date(ms)).map(part => [part.type, part.value]));

    return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Moves a YYYY-MM-DD date by whole days.
 * @param {string} day - Date as YYYY-MM-DD.
 * @param {number} offset - Days to add; negative moves back.
 * @returns {string} The shifted date as YYYY-MM-DD.
 */
export function shiftDay(day, offset) {
    return new Date(Date.parse(`${day}T12:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The five-minute slot a timestamp falls in, counted from the Unix epoch.
 * @param {number} ms - Unix time in milliseconds.
 * @returns {number} The slot number.
 */
export function sampleSlot(ms) {
    return Math.floor(ms / SAMPLE_MS);
}

/**
 * Classifies one line from a /Line/Mode/tube/Status response.
 * @param {Object} item - A TfL Line object with lineStatuses.
 * @returns {Object|null} The state ('good', 'disrupted' or 'closed'), the
 *     severity and status text behind it, or null if there is nothing to record.
 */
export function classifyLineStatus(item) {
    const statuses = (Array.isArray(item && item.lineStatuses) ? item.lineStatuses : [])
        .filter(status => Number.isInteger(status && status.statusSeverity));

    if (!statuses.length) {
        return null;
    }
    const disrupted = statuses
        .filter(status => !GOOD_SEVERITIES.has(status.statusSeverity) && !CLOSED_SEVERITIES.has(status.statusSeverity))
        .sort((a, b) => a.statusSeverity - b.statusSeverity);
    const closed = statuses.find(status => CLOSED_SEVERITIES.has(status.statusSeverity));
    const [state, status] = disrupted.length ? ['disrupted', disrupted[0]] :
        closed ? ['closed', closed] : ['good', statuses[0]];

    return {
        state,
        severity: status.statusSeverity,
        status: String(status.statusSeverityDescription || '').slice(0, 64)
    };
}

/**
 * Turns a /Line/Mode/tube/Status response into one sample per tube line.
 * @param {Array<Object>} data - The TfL response.
 * @param {number} scheduledTime - When the run was scheduled, in milliseconds.
 * @returns {Array<Object>} Sample rows with day, slot, lineId, state, severity and status.
 */
export function buildServiceSamples(data, scheduledTime) {
    const day = londonDay(scheduledTime);
    const slot = sampleSlot(scheduledTime);
    const seen = new Set();
    const samples = [];

    for (const item of Array.isArray(data) ? data : []) {
        const lineId = item && item.id;
        const classified = TUBE_LINES.has(lineId) && !seen.has(lineId) ? classifyLineStatus(item) : null;

        if (classified) {
            seen.add(lineId);
            samples.push({day, slot, lineId, ...classified});
        }
    }
    return samples;
}

/**
 * Stores one run's samples and refreshes that day's totals in a single D1 batch.
 * Once a day it also prunes raw samples older than the retention period.
 * @param {Object} db - A D1 database binding.
 * @param {Array<Object>} data - The TfL /Line/Mode/tube/Status response.
 * @param {number} scheduledTime - When the run was scheduled, in milliseconds.
 * @returns {Promise<Object>} The number of samples and whether a prune ran.
 */
export async function recordServiceSamples(db, data, scheduledTime) {
    const samples = buildServiceSamples(data, scheduledTime);

    if (!samples.length) {
        throw new Error('TfL response contained no tube line statuses');
    }
    const statements = samples.map(sample => db.prepare(INSERT_SAMPLE_SQL)
        .bind(sample.day, sample.lineId, sample.slot, sample.state, sample.severity, sample.status));

    statements.push(db.prepare(ROLLUP_DAY_SQL).bind(samples[0].day));
    // The first slot of each UTC day.
    const pruned = samples[0].slot % (DAY_MS / SAMPLE_MS) === 0;
    if (pruned) {
        statements.push(db.prepare(PRUNE_SAMPLES_SQL).bind(shiftDay(samples[0].day, -SAMPLE_RETENTION_DAYS)));
    }
    await db.batch(statements);

    return {samples: samples.length, pruned};
}

/**
 * The London dates covered by a history request, oldest first, ending today.
 * @param {number} now - Unix time in milliseconds.
 * @param {number} days - Number of days, clamped to 1..MAX_HISTORY_DAYS.
 * @returns {Array<string>} Dates as YYYY-MM-DD.
 */
export function historyDays(now, days) {
    const count = Math.min(MAX_HISTORY_DAYS, Math.max(1, Math.floor(Number(days)) || 7));
    const today = londonDay(now);

    return Array.from({length: count}, (_, i) => shiftDay(today, i - count + 1));
}

/**
 * Shapes daily_line_service rows into the public JSON response.
 * @param {Array<Object>} rows - Rows from READ_HISTORY_SQL.
 * @param {Array<string>} days - The requested dates, oldest first.
 * @returns {Object} Minutes of good, disrupted and closed service per line and day.
 */
export function summariseServiceHistory(rows, days) {
    const byLine = new Map();
    let lastSlot = null;

    for (const row of rows || []) {
        if (!TUBE_LINES.has(row.line_id) || !days.includes(row.day)) continue;
        const line = byLine.get(row.line_id) || {lineId: row.line_id, goodMinutes: 0, disruptedMinutes: 0, closedMinutes: 0, days: []};
        const day = {
            day: row.day,
            goodMinutes: (Number(row.good_samples) || 0) * SAMPLE_MINUTES,
            disruptedMinutes: (Number(row.disrupted_samples) || 0) * SAMPLE_MINUTES,
            closedMinutes: (Number(row.closed_samples) || 0) * SAMPLE_MINUTES
        };

        line.goodMinutes += day.goodMinutes;
        line.disruptedMinutes += day.disruptedMinutes;
        line.closedMinutes += day.closedMinutes;
        line.days.push(day);
        byLine.set(row.line_id, line);
        lastSlot = Math.max(lastSlot || 0, Number(row.last_slot) || 0);
    }

    return {
        sampleMinutes: SAMPLE_MINUTES,
        from: days[0],
        to: days[days.length - 1],
        lastSampleAt: lastSlot ? new Date(lastSlot * SAMPLE_MS).toISOString() : null,
        lines: TFL_TUBE_LINE_IDS.filter(id => byLine.has(id)).map(id => byLine.get(id))
    };
}
