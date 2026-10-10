// The stop list for a live London train, in the order it travels: the
// stops it has passed, where it is now, and the stops ahead with TfL's
// predicted times. TfL gives no timetable, so passed stops only have a time
// if this page saw the train there. Plain values in and out, so it can be
// unit-tested.

import {londonPlatformLabel, londonTrainEtaLabel} from './london-train-popup.mjs';

// Longer than any single trip, so an older record is from a previous one.
const STALE_STOP_MS = 3 * 60 * 60000;

/**
 * Builds the rows of the timetable.
 * @param {Object} params - The train.
 * @param {Array<Object>} params.stops - Route stations in route order: {id, name}.
 * @param {number} params.fromIndex - Route index of the station it last left (or is at).
 * @param {number} params.toIndex - Route index of the station it is heading for; equal to fromIndex at a platform.
 * @param {number} [params.facing] - +1 or -1 along the route; used when fromIndex equals toIndex.
 * @param {Array<Object>} [params.predictions] - {stationId, expectedArrival, platform}, from TfL.
 * @param {Map<string, Object>} [params.history] - Station id to {time, facing}, when this page saw it leave.
 * @param {string} [params.destinationId] - Station id it terminates at, if known.
 * @param {number} params.now - Unix time in milliseconds.
 * @returns {Object|null} {rows, currentRow, fromRow, toRow}, or null if the position is unknown.
 */
export function buildLondonTrainTimetable({stops, fromIndex, toIndex, facing, predictions = [], history = new Map(), destinationId, now}) {
    if (!Array.isArray(stops) || !stops.length || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
        !stops[fromIndex] || !stops[toIndex]) {
        return null;
    }
    const direction = Math.sign(toIndex - fromIndex) || Math.sign(facing) || 1;
    const atStation = fromIndex === toIndex;
    const ahead = index => (index - toIndex) * direction >= 0;
    const indexOf = new Map(stops.map((stop, index) => [stop.id, index]));

    // Only predictions for stations still ahead count; the soonest wins.
    const predicted = new Map();
    for (const prediction of predictions) {
        const index = indexOf.get(prediction.stationId);
        if (index === undefined || !ahead(index) || !Number.isFinite(prediction.expectedArrival)) continue;
        const existing = predicted.get(index);
        if (!existing || prediction.expectedArrival < existing.expectedArrival) predicted.set(index, prediction);
    }

    // Stop at the terminus if it lies ahead, else after the last predicted stop.
    const last = direction > 0 ? stops.length - 1 : 0;
    const destinationIndex = indexOf.get(destinationId);
    let endIndex = last;
    if (destinationIndex !== undefined && ahead(destinationIndex)) {
        endIndex = destinationIndex;
    } else if (predicted.size) {
        endIndex = [...predicted.keys()].reduce((far, index) => ((index - far) * direction > 0 ? index : far));
    }
    const startIndex = direction > 0 ? 0 : stops.length - 1;

    const rows = [];
    for (let index = startIndex; (endIndex - index) * direction >= 0; index += direction) {
        const stop = stops[index];
        const row = {index, id: stop.id, name: stop.name};

        if (atStation && index === toIndex) {
            row.status = 'current';
        } else if (!ahead(index)) {
            row.status = 'passed';
        } else {
            row.status = index === toIndex ? 'next' : 'upcoming';
        }

        if (row.status === 'passed' || row.status === 'current') {
            const seen = history.get(stop.id);
            if (seen && Number.isFinite(seen.time) && (!seen.facing || seen.facing === direction)) row.time = seen.time;
        }
        const prediction = predicted.get(index);
        if (prediction && row.status !== 'current') {
            row.time = prediction.expectedArrival;
            row.etaLabel = londonTrainEtaLabel(prediction.expectedArrival - now);
        }
        if (prediction && (row.status === 'next' || row.status === 'current')) {
            row.platform = londonPlatformLabel(prediction.platform);
        }
        rows.push(row);
    }

    const rowOf = index => rows.findIndex(row => row.index === index);
    const toRow = rowOf(toIndex);
    return {
        rows,
        fromRow: rowOf(fromIndex),
        toRow,
        currentRow: toRow
    };
}

/**
 * How far the train is between the station it left and the next one.
 * @param {number} previousTime - When it left, in milliseconds.
 * @param {number} nextTime - When it is due, in milliseconds.
 * @param {number} now - Unix time in milliseconds.
 * @returns {number} 0 at the station it left, 1 at the next.
 */
export function londonTrainSectionProgress(previousTime, nextTime, now) {
    if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime) || nextTime <= previousTime) return 0.5;
    return Math.min(1, Math.max(0, (now - previousTime) / (nextTime - previousTime)));
}

/**
 * Notes when a train was seen at or leaving a station, for the passed stops.
 * While it waits at a platform the time keeps moving, so it ends up as the
 * departure. A record from the other direction (before it turned round), or
 * from an earlier trip, is replaced.
 * @param {Map<string, Object>} history - Station id to {time, facing}; updated in place.
 * @param {Object} sighting - {stationId, time, facing, atStation}.
 */
export function noteLondonTrainStop(history, {stationId, time, facing, atStation}) {
    if (!stationId || !Number.isFinite(time)) return;
    const existing = history.get(stationId);
    if (atStation || !existing || existing.facing !== facing || time - existing.time > STALE_STOP_MS) {
        history.set(stationId, {time, facing});
    }
}

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, s => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'})[s]);
}

/**
 * The timetable as HTML: a rail in the line colour with a dot per stop.
 * Passed stops are greyed; the train marker and the greyed part of the rail
 * are positioned afterwards from the --rail-* properties.
 * @param {Object|null} timetable - From buildLondonTrainTimetable.
 * @param {Object} options - Display options.
 * @param {string} options.colour - Line colour for the rail and upcoming stops.
 * @param {Function} options.formatTime - Milliseconds to a clock time.
 * @returns {string} HTML.
 */
export function londonTrainTimetableHTML(timetable, {colour, formatTime}) {
    if (!timetable || !timetable.rows.length) {
        return '<div class="london-empty-state">Finding where this train is…</div>';
    }
    return [
        `<div class="london-timetable" style="--line-color:${escapeHTML(colour)};">`,
        '<span class="london-timetable-rail" aria-hidden="true"></span>',
        '<span class="london-timetable-rail-done" aria-hidden="true"></span>',
        '<span class="london-timetable-train" aria-hidden="true"></span>',
        '<ol class="london-timetable-stops">',
        timetable.rows.map(row => {
            const time = Number.isFinite(row.time) ? escapeHTML(formatTime(row.time)) : '';
            const note = row.status === 'current' ? 'At platform' : row.platform;
            return [
                `<li class="london-timetable-stop is-${row.status}"${row.status === 'next' || row.status === 'current' ? ' aria-current="step"' : ''}>`,
                '<span class="london-timetable-dot"></span>',
                '<div class="london-timetable-copy">',
                `<strong>${escapeHTML(row.name)}</strong>`,
                note ? `<span>${escapeHTML(note)}${row.status === 'current' && row.platform ? ` · ${escapeHTML(row.platform)}` : ''}</span>` : '',
                '</div>',
                time || row.etaLabel ? [
                    '<div class="london-timetable-time">',
                    row.etaLabel && row.status === 'next' ? `<strong>${escapeHTML(row.etaLabel)}</strong>` : '',
                    time ? `<span>${time}</span>` : '',
                    row.etaLabel && row.status === 'upcoming' ? `<span class="london-timetable-eta">${escapeHTML(row.etaLabel)}</span>` : '',
                    '</div>'
                ].join('') : '',
                '</li>'
            ].join('');
        }).join(''),
        '</ol>',
        '</div>'
    ].join('');
}
