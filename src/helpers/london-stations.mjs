export function buildLondonStationGroupIdLookup(stationGroupData) {
    const lookup = new Map();

    for (const groups of stationGroupData || []) {
        const normalizedGroups = Array.isArray(groups) ? groups : [groups];
        const primaryGroup = Array.isArray(normalizedGroups[0]) ? normalizedGroups[0][0] : normalizedGroups[0];

        if (!primaryGroup) continue;

        for (const stationId of normalizedGroups.flat()) {
            if (stationId) {
                lookup.set(stationId, primaryGroup);
            }
        }
    }

    return lookup;
}

export function applyLondonStationGroups(stations, stationGroupData) {
    const groupIdLookup = buildLondonStationGroupIdLookup(stationGroupData);

    for (const station of stations || []) {
        if (!station || !station.id) continue;
        const groupId = groupIdLookup.get(station.id) || station.id;
        station.group = `${groupId}.${station.altitude < 0 ? 'ug' : 'og'}`;
    }

    return groupIdLookup;
}

// "Bakerloo (inbound)" -> "Bakerloo". Trimming first and anchoring on the
// literal ")" keeps the regex linear on long whitespace runs.
export function stripLondonDirectionSuffix(label) {
    return String(label || '').trim().replace(/\((?:inbound|outbound)\)$/i, '').trim();
}

const STATION_NAME_SUFFIXES = [' underground station', ' dlr station', ' rail station', ' station'];

// "Epping Underground Station" -> "Epping". TfL appends these to every
// destination, which makes departure headings wrap on phones.
export function shortenLondonStationName(name) {
    const text = String(name || '').trim();
    const lower = text.toLowerCase();

    for (const suffix of STATION_NAME_SUFFIXES) {
        if (lower.endsWith(suffix) && lower.length > suffix.length) {
            return text.slice(0, -suffix.length).trim();
        }
    }
    return text;
}
