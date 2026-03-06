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
