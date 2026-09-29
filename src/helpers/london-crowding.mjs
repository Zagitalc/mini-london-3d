// Turns TfL live crowding responses (GET /crowding/{Naptan}/Live) into the
// station drawer's capacity meter. TfL reports busyness as a fraction of a
// per-station baseline, e.g. {dataAvailable: true, percentageOfBaseline: 0.42}.

const QUIET_BELOW = 0.5;
const BUSY_FROM = 0.9;

/**
 * Picks the first usable reading from several stop point responses.
 * @param {Array} responses - Parsed crowding responses, in stop point order.
 * @returns {Object|null} The reading with a numeric ratio, or null.
 */
export function selectLondonCrowdingReading(responses) {
    for (const response of responses || []) {
        if (!response || response.dataAvailable === false) continue;
        const ratio = Number(response.percentageOfBaseline);

        if (Number.isFinite(ratio) && ratio >= 0) {
            return {ratio, timeLocal: response.timeLocal || null};
        }
    }
    return null;
}

/**
 * Builds the capacity meter model for a station.
 * @param {Object|null} reading - Output of selectLondonCrowdingReading.
 * @param {string} stationTitle - Station name for the detail text.
 * @returns {Object} Title, status, tone, percent and detail for the drawer.
 */
export function describeLondonCrowding(reading, stationTitle) {
    const name = stationTitle || 'this station';

    if (!reading) {
        return {
            title: 'Station busyness',
            status: 'No data',
            tone: 'unknown',
            percent: 0,
            detail: `TfL has no live crowding data for ${name} right now.`
        };
    }

    const percent = Math.round(reading.ratio * 100);
    const [status, tone] = reading.ratio < QUIET_BELOW ? ['Quiet', 'good'] :
        reading.ratio < BUSY_FROM ? ['Moderate', 'minor'] : ['Busy', 'severe'];

    return {
        title: 'Station busyness',
        status,
        tone,
        percent: Math.min(100, Math.max(0, percent)),
        detail: `${name} is at ${percent}% of its usual busy level, according to TfL's live crowding feed.`
    };
}
