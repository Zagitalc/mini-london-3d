// Turns the /api/service-history response into rows for the "Past week" chart
// in the Line Status panel. No DOM here, so it can be unit-tested.

/**
 * Formats a number of hours for a label: whole hours from 10 up, one decimal below.
 * @param {number} hours - Hours.
 * @returns {string} E.g. "128 h", "4.5 h", "0 h".
 */
export function formatServiceHours(hours) {
    const value = Math.max(0, Number(hours) || 0);
    const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;

    return `${rounded} h`;
}

const toHours = minutes => (Number(minutes) || 0) / 60;
const percent = (part, whole) => whole > 0 ? Math.round(part / whole * 1000) / 10 : 0;

/**
 * Share of running time in good service as a whole percentage, never rounded
 * up to 100 when any disruption was recorded.
 * @param {number} good - Hours of good service.
 * @param {number} disrupted - Hours of disrupted service.
 * @returns {number|null} 0-100, or null if the line never ran.
 */
export function goodServicePercent(good, disrupted) {
    if (!(good + disrupted > 0)) {
        return null;
    }
    const value = Math.round(good / (good + disrupted) * 100);
    return disrupted > 0 ? Math.min(99, value) : value;
}

/**
 * Builds the chart model.
 * @param {Object} data - The /api/service-history response.
 * @param {Array<Object>} catalog - Lines to show, each with lineId, title and color.
 * @returns {Object} Rows sorted most disrupted first, each with hours and bar
 *     widths (percent of the longest recorded period), plus network totals.
 */
export function buildServiceHistoryChart(data, catalog) {
    const byLine = new Map((data && Array.isArray(data.lines) ? data.lines : []).map(line => [line.lineId, line]));
    const rows = (catalog || []).filter(line => byLine.has(line.lineId)).map(line => {
        const entry = byLine.get(line.lineId);
        const goodHours = toHours(entry.goodMinutes);
        const disruptedHours = toHours(entry.disruptedMinutes);
        const closedHours = toHours(entry.closedMinutes);

        return {
            lineId: line.lineId,
            title: line.title,
            color: line.color,
            goodHours,
            disruptedHours,
            closedHours,
            recordedHours: goodHours + disruptedHours + closedHours,
            // Share of the time trains were meant to be running.
            goodPercent: goodServicePercent(goodHours, disruptedHours)
        };
    });
    const scaleHours = Math.max(0, ...rows.map(row => row.recordedHours));

    for (const row of rows) {
        row.goodWidth = percent(row.goodHours, scaleHours);
        row.disruptedWidth = percent(row.disruptedHours, scaleHours);
        row.closedWidth = percent(row.closedHours, scaleHours);
    }
    rows.sort((a, b) => b.disruptedHours - a.disruptedHours || a.title.localeCompare(b.title));

    const good = rows.reduce((sum, row) => sum + row.goodHours, 0);
    const disrupted = rows.reduce((sum, row) => sum + row.disruptedHours, 0);

    return {
        rows,
        scaleHours,
        networkGoodPercent: goodServicePercent(good, disrupted),
        lastSampleAt: data && data.lastSampleAt ? Date.parse(data.lastSampleAt) : null
    };
}

/**
 * One sentence describing a row, for the bar's accessible label and tooltip.
 * @param {Object} row - A row from buildServiceHistoryChart.
 * @returns {string} The description.
 */
export function describeServiceHistoryRow(row) {
    const spell = hours => {
        const label = formatServiceHours(hours).slice(0, -2);
        return `${label} ${label === '1' ? 'hour' : 'hours'}`;
    };

    return `${row.title}: ${spell(row.goodHours)} of good service, ${spell(row.disruptedHours)} disrupted, ` +
        `${spell(row.closedHours)} not running, out of ${spell(row.recordedHours)} recorded`;
}
