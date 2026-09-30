// Puts each tube line back on its own track at interchanges.
//
// When the route display was built, every line's track was cut at a station
// and the cut point overwritten with one shared anchor per station group (see
// extractLondonRelationCorridors). At Baker Street that pulls five lines on
// different alignments into a single point, so they cross in a knot and the
// trains pile up there too.
//
// The real cut point is recovered from the next vertices on each line's own
// track. Ends of lines that run through each other at a station share one
// platform point (the Circle, Hammersmith & City and Metropolitan at Baker
// Street); lines on other alignments get their own (the Bakerloo, the
// Jubilee). The result also lists each station's platform points so they can
// be drawn where the lines actually are.

const EARTH_RADIUS_M = 6371008.8;

function toMetres(origin) {
    const k = Math.cos(origin[1] * Math.PI / 180);
    return c => [(c[0] - origin[0]) * Math.PI / 180 * EARTH_RADIUS_M * k, (c[1] - origin[1]) * Math.PI / 180 * EARTH_RADIUS_M];
}

function fromMetres(origin) {
    const k = Math.cos(origin[1] * Math.PI / 180);
    return ([x, y]) => [origin[0] + x / (EARTH_RADIUS_M * k) * 180 / Math.PI, origin[1] + y / EARTH_RADIUS_M * 180 / Math.PI];
}

/**
 * Distance in metres between two [lng, lat] coordinates (fine at station scale).
 * @param {Array<number>} a - Coordinate.
 * @param {Array<number>} b - Coordinate.
 * @returns {number} Metres.
 */
export function metresBetween(a, b) {
    const [x, y] = toMetres(a)(b);
    return Math.hypot(x, y);
}

function bearingOf(from, to) {
    const [x, y] = toMetres(from)(to);
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

/**
 * Where a line's own track passes the station at one end of a corridor.
 * @param {Array<Array<number>>} coords - Corridor coordinates starting at the station.
 * @param {number} maxShiftM - Give up if the estimate is further than this from the anchor.
 * @returns {Object|null} {coord, bearing} with the track direction, or null to keep the anchor.
 */
export function estimatePlatformPoint(coords, maxShiftM = 150) {
    if (!Array.isArray(coords) || coords.length < 3) return null;
    const [anchor, p1, p2] = coords;
    const m = toMetres(anchor);
    const [ax, ay] = [0, 0];
    const [x1, y1] = m(p1);
    const [x2, y2] = m(p2);
    // Extend the first real segment (p2 -> p1) back towards the station.
    const dx = x1 - x2, dy = y1 - y2;
    const length2 = dx * dx + dy * dy;
    if (!(length2 > 1e-6)) return null;
    const s = Math.max(0, ((ax - x1) * dx + (ay - y1) * dy) / length2);
    const point = [x1 + s * dx, y1 + s * dy];
    if (Math.hypot(point[0], point[1]) > maxShiftM) return null;
    return {coord: fromMetres(anchor)(point), bearing: bearingOf(p2, p1)};
}

function createSets() {
    const parent = new Map();
    const find = id => {
        if (!parent.has(id)) parent.set(id, id);
        const up = parent.get(id);
        if (up === id) return id;
        const root = find(up);
        parent.set(id, root);
        return root;
    };
    return {find, union: (a, b) => parent.set(find(b), find(a))};
}

// Joins a station's platform points with the shortest set of links.
function spanningLinks(points) {
    const links = [];
    const inTree = new Set([0]);
    while (inTree.size < points.length) {
        let best = null;
        for (const i of inTree) {
            for (let j = 0; j < points.length; j++) {
                if (inTree.has(j)) continue;
                const d = metresBetween(points[i], points[j]);
                if (!best || d < best.d) best = {i, j, d};
            }
        }
        inTree.add(best.j);
        links.push([best.i, best.j]);
    }
    return links;
}

/**
 * Moves corridor ends onto each line's own track and lists platform points.
 * @param {Array<Object>} features - Railway features (after organiseLondonRailDisplay).
 * @param {Object} [options] - Options.
 * @param {number} [options.maxShiftM] - Largest move from the anchor, in metres.
 * @param {number} [options.mergeM] - Platform points closer than this are merged.
 * @returns {Object} {features, platforms} where platforms maps a station-group
 *     slug to [{coord, lineIds, bearing}] and links lists [i, j] index pairs.
 */
export function placeLondonPlatforms(features, {maxShiftM = 150, mergeM = 25} = {}) {
    // Corridor ends: `${corridorId}|0` at the from station, `|1` at the to station.
    const corridors = new Map();
    for (const feature of features || []) {
        const props = feature && feature.properties;
        const coords = feature && feature.geometry && feature.geometry.coordinates;
        if (!props || props.type !== 'railway' || !props.corridorId || !Array.isArray(coords) || coords.length < 2) continue;
        if (!corridors.has(props.corridorId)) {
            const [fromSlug, toSlug] = props.corridorId.split('__');
            corridors.set(props.corridorId, {coords, lineIds: new Set(), fromSlug, toSlug, osm: props.geometrySource === 'osm'});
        }
        corridors.get(props.corridorId).lineIds.add(props.lineId);
    }

    const ends = new Map();
    const endsByStationLine = new Map();
    for (const [corridorId, corridor] of corridors) {
        for (const side of [0, 1]) {
            const key = `${corridorId}|${side}`;
            const stationSlug = side ? corridor.toSlug : corridor.fromSlug;
            const coords = side ? corridor.coords.slice().reverse() : corridor.coords;
            ends.set(key, {stationSlug, anchor: coords[0], estimate: corridor.osm ? estimatePlatformPoint(coords, maxShiftM) : null, lineIds: corridor.lineIds});
            for (const lineId of corridor.lineIds) {
                const k = `${stationSlug}|${lineId}`;
                if (!endsByStationLine.has(k)) endsByStationLine.set(k, []);
                endsByStationLine.get(k).push(key);
            }
        }
    }

    // A line passing through a station joins its ends there into one platform.
    const sets = createSets();
    for (const keys of endsByStationLine.values()) {
        for (const key of keys.slice(1)) sets.union(keys[0], key);
    }

    const clusters = new Map();
    for (const [key, end] of ends) {
        const root = sets.find(key);
        if (!clusters.has(root)) clusters.set(root, {stationSlug: end.stationSlug, keys: [], estimates: [], anchor: end.anchor, lineIds: new Set()});
        const cluster = clusters.get(root);
        cluster.keys.push(key);
        if (end.estimate) cluster.estimates.push(end.estimate);
        for (const lineId of end.lineIds) cluster.lineIds.add(lineId);
    }

    // Each platform point: the mean of its estimates, or the anchor if none.
    const byStation = new Map();
    for (const cluster of clusters.values()) {
        const {estimates, anchor} = cluster;
        cluster.coord = estimates.length ? [
            estimates.reduce((sum, e) => sum + e.coord[0], 0) / estimates.length,
            estimates.reduce((sum, e) => sum + e.coord[1], 0) / estimates.length
        ] : anchor.slice(0, 2);
        cluster.bearing = estimates.length ? estimates[0].bearing : null;
        if (!byStation.has(cluster.stationSlug)) byStation.set(cluster.stationSlug, []);
        byStation.get(cluster.stationSlug).push(cluster);
    }

    // Points of the same station within mergeM are one platform.
    const pointOf = new Map();
    const platforms = new Map();
    for (const [stationSlug, list] of byStation) {
        list.sort((a, b) => b.lineIds.size - a.lineIds.size || a.keys[0].localeCompare(b.keys[0]));
        const merged = [];
        for (const cluster of list) {
            const target = merged.find(m => metresBetween(m.coord, cluster.coord) <= mergeM);
            if (target) {
                for (const lineId of cluster.lineIds) target.lineIds.add(lineId);
                target.keys.push(...cluster.keys);
                if (target.bearing === null) target.bearing = cluster.bearing;
            } else {
                merged.push({coord: cluster.coord, lineIds: new Set(cluster.lineIds), keys: [...cluster.keys], bearing: cluster.bearing});
            }
        }
        for (const m of merged) for (const key of m.keys) pointOf.set(key, m.coord);
        platforms.set(stationSlug, {
            points: merged.map(m => ({coord: m.coord, lineIds: [...m.lineIds].sort(), bearing: m.bearing})),
            links: merged.length > 1 ? spanningLinks(merged.map(m => m.coord)) : []
        });
    }

    // New geometry per corridor, shared by all its lines.
    const moved = new Map();
    for (const [corridorId, corridor] of corridors) {
        const coords = corridor.coords.map(c => c.slice());
        coords[0] = pointOf.get(`${corridorId}|0`) || coords[0];
        coords[coords.length - 1] = pointOf.get(`${corridorId}|1`) || coords[coords.length - 1];
        moved.set(corridorId, coords);
    }

    return {
        platforms,
        features: (features || []).map(feature => {
            const coords = feature && feature.properties && moved.get(feature.properties.corridorId);
            return coords && feature.properties.type === 'railway' ?
                {...feature, geometry: {...feature.geometry, coordinates: coords}} : feature;
        })
    };
}

/**
 * placeLondonPlatforms applied to the loaded route-display data.
 * @param {Object} displayData - A FeatureCollection of railway features.
 * @returns {Object} The same collection with moved ends and a `platforms`
 *     object keyed by station-group slug.
 */
export function withLondonPlatforms(displayData) {
    if (!displayData || !Array.isArray(displayData.features)) return displayData;
    const {features, platforms} = placeLondonPlatforms(displayData.features);
    return {...displayData, features, platforms: Object.fromEntries(platforms)};
}
