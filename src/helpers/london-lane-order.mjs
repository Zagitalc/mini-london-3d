// Keeps each tube line on the same side of a shared-track bundle from one
// station to the next.
//
// Display corridors (see london-route-display.mjs) run between consecutive
// station groups and are drawn from whichever group sorts first, so two
// neighbouring corridors on the same line can point opposite ways. Mapbox's
// line-offset is measured against the drawing direction, so the same lane
// number then lands on the other side and the line zigzags across the bundle.
//
// This picks a consistent direction for every corridor (neighbours along each
// line agree, busiest stations first) and orders lanes by one network-wide
// rank, so lines that share track keep the same neighbours. Geometry is never
// changed: a corridor that needs flipping gets its offsets negated instead.

import {normalizeLondonCorridorEndpoints, slugifyIdentity} from './london-route-display.mjs';

// Lines that share track sit next to each other: the Piccadilly with the
// District (Acton Town to Ealing Common) and the Metropolitan (Rayners Lane
// to Uxbridge); the Circle between the District and the Hammersmith & City.
export const LONDON_LANE_RANK = [
    'piccadilly', 'district', 'circle', 'hammersmith-city', 'metropolitan',
    'bakerloo', 'central', 'jubilee', 'northern', 'victoria', 'waterloo-city'
];

function rankOf(lineId, rank) {
    const index = rank.indexOf(lineId);
    return index === -1 ? rank.length : index;
}

// Union-find with parity: parity says whether a corridor is flipped
// relative to its set's root.
function createParitySets() {
    const parent = new Map();
    const parity = new Map();
    const find = id => {
        if (!parent.has(id)) {
            parent.set(id, id);
            parity.set(id, 0);
        }
        const up = parent.get(id);
        if (up === id) return id;
        const root = find(up);
        parity.set(id, parity.get(id) ^ parity.get(up));
        parent.set(id, root);
        return root;
    };
    return {
        find,
        parityOf: id => {
            find(id);
            return parity.get(id);
        },
        // Records that a and b differ by `relation` (0 same, 1 flipped).
        // Returns false if that contradicts what is already known.
        union(a, b, relation) {
            const rootA = find(a), rootB = find(b);
            const pa = parity.get(a), pb = parity.get(b);
            if (rootA === rootB) return (pa ^ pb) === relation;
            parent.set(rootB, rootA);
            parity.set(rootB, pa ^ pb ^ relation);
            return true;
        }
    };
}

/**
 * Moves lines drawn with fallback geometry onto a real (OSM) corridor
 * between the same two stations, where one exists. In practice this is the
 * Circle, which shares track with the District or the Hammersmith & City and
 * Metropolitan but was sometimes drawn on its own approximate path beside
 * them. Separate tunnels (OSM on both sides) are left alone.
 * @param {Array<Object>} features - Railway features from buildLondonDisplayFeatureCollection.
 * @returns {Object} {features, merged}: new feature objects and how many were moved.
 */
export function mergeLondonFallbackCorridors(features) {
    const targets = new Map();

    for (const feature of features || []) {
        const props = feature && feature.properties;
        if (!props || props.type !== 'railway' || props.geometrySource !== 'osm' || !props.corridorId) continue;
        const ends = props.corridorId.split('__').slice(0, 2).join('__');
        const target = targets.get(ends);
        // The OSM corridor with the most lines wins; ties go to the first id.
        const lines = (target && target.corridorId === props.corridorId ? target.lines : 0) + 1;
        if (!target || target.corridorId === props.corridorId) {
            targets.set(ends, {corridorId: props.corridorId, alignmentId: props.alignmentId, geometry: feature.geometry, lines});
        } else if (lines > target.lines) {
            targets.set(ends, {corridorId: props.corridorId, alignmentId: props.alignmentId, geometry: feature.geometry, lines});
        }
    }

    let merged = 0;
    const output = (features || []).map(feature => {
        const props = feature && feature.properties;
        if (!props || props.type !== 'railway' || props.geometrySource === 'osm' || !props.corridorId) return feature;
        const target = targets.get(props.corridorId.split('__').slice(0, 2).join('__'));
        if (!target) return feature;
        merged++;
        return {
            ...feature,
            geometry: target.geometry,
            properties: {
                ...props,
                id: `${target.corridorId}__${props.lineId}`,
                corridorId: target.corridorId,
                alignmentId: target.alignmentId,
                geometrySource: 'osm'
            }
        };
    });
    return {features: output, merged};
}

/**
 * Re-assigns lane offsets on the display features.
 * @param {Array<Object>} features - Railway features from buildLondonDisplayFeatureCollection.
 * @param {Array<Object>} sequences - One {lineId, groups} per railway: its station groups in running order.
 * @param {Object} [options] - Options.
 * @param {Array<string>} [options.rank] - Network-wide lane order.
 * @returns {Object} {features: new feature objects with laneIndex and laneOffset updated, conflicts}.
 */
export function orderLondonLanes(features, sequences, {rank = LONDON_LANE_RANK} = {}) {
    const corridors = new Map();
    const byLineAndEnds = new Map();

    for (const feature of features || []) {
        const props = feature && feature.properties;
        if (!props || props.type !== 'railway' || !props.corridorId || !props.lineId) continue;
        const [fromSlug, toSlug] = props.corridorId.split('__');
        if (!corridors.has(props.corridorId)) corridors.set(props.corridorId, {fromSlug, lineIds: new Set()});
        corridors.get(props.corridorId).lineIds.add(props.lineId);
        const key = `${props.lineId}|${fromSlug}|${toSlug}`;
        if (!byLineAndEnds.has(key)) byLineAndEnds.set(key, []);
        if (!byLineAndEnds.get(key).includes(props.corridorId)) byLineAndEnds.get(key).push(props.corridorId);
    }

    // Constraints between consecutive corridors on each line, weighted by how
    // many railways (lines and directions) pass through that pair.
    const constraints = new Map();
    for (const {lineId, groups} of sequences || []) {
        let previous = null;
        for (let i = 0; i + 1 < (groups || []).length; i++) {
            const ends = normalizeLondonCorridorEndpoints(groups[i], groups[i + 1]);
            const ids = byLineAndEnds.get(`${lineId}|${slugifyIdentity(ends.fromGroup)}|${slugifyIdentity(ends.toGroup)}`);
            if (!ids) {
                previous = null;
                continue;
            }
            // 0 if the line runs the same way as the corridor is drawn.
            const against = ends.reversed ? 1 : 0;
            const current = {corridorId: ids[0], against};
            if (previous && previous.corridorId !== current.corridorId) {
                const [a, b] = [previous, current].sort((x, y) => x.corridorId.localeCompare(y.corridorId));
                const key = `${a.corridorId}|${b.corridorId}|${a.against ^ b.against}`;
                constraints.set(key, (constraints.get(key) || 0) + 1);
            }
            previous = current;
        }
    }

    const sets = createParitySets();
    let conflicts = 0;
    const ordered = [...constraints.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    for (const [key] of ordered) {
        const [a, b, relation] = key.split('|');
        if (!sets.union(a, b, Number(relation))) conflicts++;
    }

    // Lane order inside each corridor, in its chosen direction.
    const lanes = new Map();
    for (const [corridorId, corridor] of corridors) {
        const lineIds = [...corridor.lineIds].sort((a, b) => rankOf(a, rank) - rankOf(b, rank) || a.localeCompare(b));
        const sign = sets.parityOf(corridorId) ? -1 : 1;
        lineIds.forEach((lineId, index) => {
            lanes.set(`${corridorId}|${lineId}`, {
                laneIndex: index,
                laneCount: lineIds.length,
                laneOffset: sign * (index - (lineIds.length - 1) / 2)
            });
        });
    }

    return {
        conflicts,
        features: (features || []).map(feature => {
            const props = feature && feature.properties;
            const lane = props && lanes.get(`${props.corridorId}|${props.lineId}`);
            // Negative zero would round-trip as 0 anyway; normalise it.
            return lane ? {...feature, properties: {...props, ...lane, laneOffset: lane.laneOffset || 0}} : feature;
        })
    };
}

/**
 * Tidies the display features: fallback lines join shared OSM corridors,
 * then lanes are ordered consistently.
 * @param {Array<Object>} features - Railway features from buildLondonDisplayFeatureCollection.
 * @param {Array<Object>} sequences - One {lineId, groups} per railway, as for orderLondonLanes.
 * @returns {Object} {features, merged, conflicts}.
 */
export function organiseLondonRailDisplay(features, sequences) {
    const {features: mergedFeatures, merged} = mergeLondonFallbackCorridors(features);
    const {features: ordered, conflicts} = orderLondonLanes(mergedFeatures, sequences);
    return {features: ordered, merged, conflicts};
}

/**
 * Each railway's station groups in running order, from the raw data files.
 * @param {Array<Object>} railwayData - railways.json: {lineId, stations}.
 * @param {Array<Array>} stationGroupData - station-groups.json: groups of station-id sets.
 * @returns {Array<Object>} One {lineId, groups} per railway.
 */
export function londonLineSequences(railwayData, stationGroupData) {
    const groupOf = new Map();

    for (const group of stationGroupData || []) {
        for (const set of group || []) {
            for (const id of set || []) groupOf.set(id, set[0]);
        }
    }
    return (railwayData || [])
        .filter(railway => railway && railway.lineId && Array.isArray(railway.stations))
        .map(railway => ({lineId: railway.lineId, groups: railway.stations.map(id => groupOf.get(id) || id)}));
}

/**
 * organiseLondonRailDisplay applied to the loaded route-display file.
 * @param {Object} displayData - london-route-display.json (a FeatureCollection).
 * @param {Array<Object>} railwayData - railways.json.
 * @param {Array<Array>} stationGroupData - station-groups.json.
 * @returns {Object} The same FeatureCollection with tidied features.
 */
export function organiseLondonRailDisplayData(displayData, railwayData, stationGroupData) {
    if (!displayData || !Array.isArray(displayData.features)) return displayData;
    const {features} = organiseLondonRailDisplay(displayData.features, londonLineSequences(railwayData, stationGroupData));
    return {...displayData, features};
}
