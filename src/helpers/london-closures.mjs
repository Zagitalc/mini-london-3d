// Planned closures for the Line Status "This weekend" view.
//
// Source: GET /Line/{ids}/Status/{start}/to/{end}?detail=true, which returns
// each line with the statuses valid in that date range (TfL has no date-range
// form of /Line/Mode/…/Status). Where TfL lists the affected stops we use
// them; otherwise the "between A and B" wording in the reason is matched
// against the line's station order. A closure that cannot be placed, or is too
// short to matter for the weekend, is still listed, just not drawn.

export const LONDON_TUBE_LINE_IDS = [
    'bakerloo', 'central', 'circle', 'district', 'hammersmith-city', 'jubilee',
    'metropolitan', 'northern', 'piccadilly', 'victoria', 'waterloo-city'
];

// Engineering works often run into the small hours of Monday.
const MONDAY_MORNING_MS = 5 * 60 * 60 * 1000;
// TfL splits a weekend's works into several statuses, often including short
// overnight closures over a longer stretch. Only closures lasting this long
// within the weekend are drawn, so the map shows what daytime travellers meet.
const MIN_MAPPED_DURATION_MS = 6 * 60 * 60 * 1000;

const CLOSURE_STATUSES = new Set(['part closure', 'planned closure', 'part suspended', 'suspended']);
const WHOLE_LINE_STATUSES = new Set(['planned closure', 'suspended']);

function londonParts(ms) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
        weekday: 'short'
    }).formatToParts(new Date(ms));
    const get = type => parts.find(part => part.type === type).value;

    return {ymd: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), weekday: get('weekday')};
}

// UTC instant of 00:00 London time on a YYYY-MM-DD date.
function londonMidnight(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);

    return guess - londonParts(guess).hour * 60 * 60 * 1000;
}

function addDays(ymd, days) {
    const [y, m, d] = ymd.split('-').map(Number);

    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The weekend to show: the current one on Saturday or Sunday, otherwise the next.
 * @param {number} now - Current time in ms.
 * @returns {Object} {saturday, monday} as YYYY-MM-DD, and {from, to} in ms.
 */
export function getLondonWeekendWindow(now) {
    const today = londonParts(now);
    const offset = {Sat: 0, Sun: -1, Mon: 5, Tue: 4, Wed: 3, Thu: 2, Fri: 1}[today.weekday];
    const saturday = addDays(today.ymd, offset);
    const monday = addDays(saturday, 2);

    return {
        saturday,
        monday,
        from: londonMidnight(saturday),
        to: londonMidnight(monday) + MONDAY_MORNING_MS
    };
}

/**
 * Normalises a station name for matching TfL's prose against our titles.
 * @param {string} name - Station title or a phrase from a reason.
 * @returns {string} Lower-case words separated by single spaces.
 */
export function normalizeLondonStationName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/-underground\b/g, ' ')
        .replace(/\b(underground|dlr|rail)?\s*stations?\b/g, ' ')
        .replace(/&/g, ' and ')
        .replace(/\bst\./g, 'st')
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Finds the station named at the start of a phrase, preferring the longest name.
 * @param {string} phrase - Text following "between" or "and".
 * @param {Map<string, Array<string>>} nameIndex - Normalised name to NaPTAN IDs.
 * @returns {Array<string>} Matching NaPTAN IDs, or an empty array.
 */
function matchStationAtStart(phrase, nameIndex) {
    const text = normalizeLondonStationName(phrase);
    let best = null;

    for (const [name, ids] of nameIndex) {
        if ((text === name || text.startsWith(`${name} `)) && (!best || name.length > best.name.length)) {
            best = {name, ids};
        }
    }
    return best ? best.ids : [];
}

/**
 * Pulls "between A and B" station pairs out of a reason. "A and B / C" gives
 * two pairs, as TfL uses a slash for alternative branch ends.
 * @param {string} reason - TfL status reason.
 * @param {Map<string, Array<string>>} nameIndex - Normalised name to NaPTAN IDs.
 * @returns {Array<Array<Array<string>>>} Pairs of NaPTAN ID lists.
 */
export function extractLondonClosurePairs(reason, nameIndex) {
    const pairs = [];
    const pattern = /between\s+(.+?)\s+and\s+(.+?)(?=[.;,(]|\s+(?:while|with|on|until|due|from|replacement|because|except|in)\b|$)/gi;

    for (const [, from, to] of String(reason || '').matchAll(pattern)) {
        const start = matchStationAtStart(from, nameIndex);
        if (!start.length) continue;
        for (const end of to.split('/')) {
            const finish = matchStationAtStart(end, nameIndex);
            if (finish.length) pairs.push([start, finish]);
        }
    }
    return pairs;
}

/**
 * Expands station pairs into every station between them on the line.
 * @param {Array} pairs - Output of extractLondonClosurePairs.
 * @param {Array<Array<string>>} sequences - NaPTAN IDs in order, one list per railway.
 * @returns {Set<string>} Closed NaPTAN IDs.
 */
export function expandLondonClosurePairs(pairs, sequences) {
    const closed = new Set();

    for (const [starts, ends] of pairs) {
        for (const sequence of sequences) {
            const i = sequence.findIndex(id => starts.includes(id));
            const j = sequence.findIndex(id => ends.includes(id));
            if (i < 0 || j < 0) continue;
            for (let k = Math.min(i, j); k <= Math.max(i, j); k++) closed.add(sequence[k]);
        }
    }
    return closed;
}

// Time within the window covered by a status, or Infinity when TfL gives no periods.
function durationInWindow(status, window) {
    const periods = Array.isArray(status.validityPeriods) ? status.validityPeriods : [];
    if (!periods.length) return Infinity;

    return periods.reduce((total, period) => {
        const from = Math.max(Date.parse(period.fromDate), window.from);
        const to = Math.min(Date.parse(period.toDate), window.to);
        return Number.isFinite(from) && Number.isFinite(to) && to > from ? total + to - from : total;
    }, 0);
}

/**
 * Turns the TfL response into closures per line.
 * @param {Array} lines - Parsed TfL response.
 * @param {Object} window - Output of getLondonWeekendWindow.
 * @param {Function} getLineIndex - lineId => {nameIndex, sequences}, or null.
 * @returns {Array<Object>} {lineId, statusText, reason, wholeLine, stops, brief, placed}.
 */
export function extractLondonClosures(lines, window, getLineIndex) {
    const closures = [];

    for (const line of Array.isArray(lines) ? lines : []) {
        const lineId = String((line && line.id) || '').toLowerCase();
        if (!lineId) continue;
        const index = getLineIndex(lineId);
        const seen = new Set();

        for (const status of line.lineStatuses || []) {
            const statusText = String(status.statusSeverityDescription || '');
            const key = statusText.toLowerCase();
            const duration = durationInWindow(status, window);
            if (!CLOSURE_STATUSES.has(key) || duration <= 0) continue;
            const reason = String(status.reason || '').trim();
            if (seen.has(reason)) continue;
            seen.add(reason);

            const wholeLine = WHOLE_LINE_STATUSES.has(key);
            let stops = new Set();
            if (!wholeLine) {
                const affected = (status.disruption && status.disruption.affectedStops) || [];
                stops = new Set(affected.map(stop => String(stop.naptanId || stop.id || '').toUpperCase()).filter(Boolean));
                if (stops.size < 2 && index) {
                    stops = expandLondonClosurePairs(extractLondonClosurePairs(reason, index.nameIndex), index.sequences);
                }
            }
            const brief = duration < MIN_MAPPED_DURATION_MS;
            closures.push({
                lineId, statusText, reason, wholeLine, stops: [...stops].sort(), brief,
                placed: !brief && (wholeLine || stops.size >= 2)
            });
        }
    }
    return closures;
}

/**
 * Reads the two end-station NaPTAN IDs from a display corridor ID such as
 * "bakerloo-940gzzlubst__bakerloo-940gzzlumyb__osm-…".
 * @param {string} corridorId - Railway feature corridorId.
 * @returns {Array<string>|null} Upper-case NaPTAN IDs, or null.
 */
export function getLondonCorridorNaptans(corridorId) {
    const [a, b] = String(corridorId || '').split('__');
    const from = /940g[0-9a-z]+/.exec(a || '');
    const to = /940g[0-9a-z]+/.exec(b || '');

    return from && to ? [from[0].toUpperCase(), to[0].toUpperCase()] : null;
}

/**
 * Whether a drawn segment falls inside a closure on its own line.
 * @param {Object} props - Railway feature properties (lineId, corridorId).
 * @param {Map<string, Array<Object>>} closuresByLine - Placed closures per lineId.
 * @returns {boolean} True when the segment is closed.
 */
export function isLondonSegmentClosed(props, closuresByLine) {
    const closures = closuresByLine.get(String((props && props.lineId) || '').toLowerCase());
    if (!closures || !closures.length) return false;
    if (closures.some(closure => closure.wholeLine)) return true;

    const ends = getLondonCorridorNaptans(props.corridorId);
    return !!ends && closures.some(closure => closure.stops.includes(ends[0]) && closure.stops.includes(ends[1]));
}
