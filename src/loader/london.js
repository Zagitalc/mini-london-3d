import nearestPointOnLine from '@turf/nearest-point-on-line';
import turfLength from '@turf/length';
import turfDistance from '@turf/distance';
import lineSliceAlong from '@turf/line-slice-along';
import { lineString, point } from '@turf/helpers';
import { updateDistances } from '../helpers/helpers-geojson';
import { loadJSON, saveJSON } from './helpers';

const DATA_DIR = process.env.MT3D_DATA_DIR || 'data';
const ZOOMS = [13, 14, 15, 16, 17, 18];

const DEMO_START_MIN = 5 * 60;
const DEMO_END_MIN = 23 * 60;
const DEMO_HEADWAY_MIN = 10;
const DEMO_TRAVEL_MIN = 2;
const DEMO_DWELL_MIN = 1;

function toTimeString(totalMinutes) {
    const minutes = ((totalMinutes % 1440) + 1440) % 1440;
    const hh = `${Math.floor(minutes / 60)}`.padStart(2, '0');
    const mm = `${minutes % 60}`.padStart(2, '0');
    return `${hh}:${mm}`;
}

function buildRailDirections(railways) {
    const directions = new Map();

    for (const railway of railways) {
        if (railway.ascending && !directions.has(railway.ascending)) {
            directions.set(railway.ascending, { id: railway.ascending, title: { en: railway.ascending } });
        }
        if (railway.descending && !directions.has(railway.descending)) {
            directions.set(railway.descending, { id: railway.descending, title: { en: railway.descending } });
        }
    }

    return Array.from(directions.values());
}

function buildGeometryLookup(data) {
    if (!data) return new Map();
    if (Array.isArray(data)) {
        return new Map(data.filter(Boolean).map(entry => [entry.id, entry.coordinates || entry.coords || []]));
    }
    if (typeof data === 'object') {
        return new Map(Object.entries(data).map(([id, coordinates]) => [id, coordinates || []]));
    }
    return new Map();
}

function reorderLineByStations(lineCoords, stationCoords) {
    if (!Array.isArray(lineCoords) || lineCoords.length < 2 || !Array.isArray(stationCoords) || stationCoords.length < 2) {
        return lineCoords;
    }
    const line = lineString(lineCoords);
    const length = turfLength(line);
    if (!isFinite(length) || length <= 0) return lineCoords;

    const stationOffsets = stationCoords.map(coord =>
        nearestPointOnLine(line, point(coord)).properties.location
    );
    const startOffset = stationOffsets[0] ?? 0;

    const unwrapped = stationOffsets.map(offset =>
        offset >= startOffset ? offset - startOffset : offset - startOffset + length
    );
    let inversions = 0;
    for (let i = 1; i < unwrapped.length; i++) {
        if (unwrapped[i] < unwrapped[i - 1]) inversions++;
    }
    const shouldReverse = inversions > unwrapped.length / 2;

    const looped = turfDistance(point(lineCoords[0]), point(lineCoords[lineCoords.length - 1])) < 0.2;

    let reordered = lineCoords;
    if (looped && startOffset > 0) {
        const first = lineSliceAlong(line, startOffset, length);
        const second = lineSliceAlong(line, 0, startOffset);
        const coords = first.geometry.coordinates.concat(second.geometry.coordinates.slice(1));
        reordered = coords;
    }

    if (shouldReverse) {
        reordered = reordered.slice().reverse();
    }

    return reordered;
}

function buildFeatures(railways, stationLookup, geometryLookup) {
    const features = [];

    for (const railway of railways) {
        const coords = [];
        const stationCoords = [];

        for (const stationId of railway.stations || []) {
            const station = stationLookup.get(stationId);
            if (!station || !Array.isArray(station.coord)) continue;
            coords.push(station.coord);
            stationCoords.push(station.coord);
        }

        const geometryCoords = geometryLookup && geometryLookup.get(railway.id);
        const baseLineCoords = Array.isArray(geometryCoords) && geometryCoords.length >= 2
            ? geometryCoords
            : coords;

        if (baseLineCoords.length < 2) continue;

        const lineCoords = reorderLineByStations(baseLineCoords, stationCoords);
        const line = lineString(lineCoords);
        const length = turfLength(line);
        const stationOffsets = stationCoords.map(coord =>
            nearestPointOnLine(line, point(coord)).properties.location
        );

        for (const zoom of ZOOMS) {
            const feature = {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: lineCoords
                },
                properties: {
                    id: `${railway.id}.${zoom}`,
                    type: 0,
                    color: railway.color || '#0098d4',
                    width: 8,
                    zoom,
                    altitude: 1,
                    length,
                    'station-offsets': stationOffsets
                }
            };
            updateDistances(feature);
            features.push(feature);
        }
    }

    return {
        type: 'FeatureCollection',
        features
    };
}

function buildTimetablesForRailway(railway, stationIds, directionId, directionSlug) {
    const timetables = [];
    let seq = 1;

    for (let start = DEMO_START_MIN; start <= DEMO_END_MIN; start += DEMO_HEADWAY_MIN) {
        const tt = [];
        let t = start;

        for (let i = 0; i < stationIds.length; i++) {
            const s = stationIds[i];

            if (i === 0) {
                tt.push({ s, d: toTimeString(t) });
                continue;
            }

            t += DEMO_TRAVEL_MIN;

            if (i === stationIds.length - 1) {
                tt.push({ s, a: toTimeString(t) });
            } else {
                tt.push({ s, a: toTimeString(t), d: toTimeString(t + DEMO_DWELL_MIN) });
                t += DEMO_DWELL_MIN;
            }
        }

        const idBase = `${railway.id}.demo.${directionSlug}.${seq}`;

        timetables.push({
            id: `${idBase}.Weekday`,
            t: idBase,
            r: railway.id,
            n: `${seq}`.padStart(3, '0'),
            d: directionId,
            os: [stationIds[0]],
            ds: [stationIds[stationIds.length - 1]],
            tt
        });
        seq += 1;
    }

    return timetables;
}

function buildTimetables(railways) {
    const all = [];

    for (const railway of railways) {
        const forwardStations = railway.stations || [];
        const reverseStations = forwardStations.slice().reverse();

        if (forwardStations.length < 2) continue;

        const upId = railway.ascending || 'Ascending';
        const downId = railway.descending || 'Descending';
        const upSlug = String(upId).replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || 'up';
        const downSlug = String(downId).replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || 'down';

        all.push(...buildTimetablesForRailway(railway, forwardStations, upId, upSlug));
        all.push(...buildTimetablesForRailway(railway, reverseStations, downId, downSlug));
    }

    return all;
}

export default async function () {
    const [railways, stations] = await Promise.all([
        loadJSON(`${DATA_DIR}/railways.json`),
        loadJSON(`${DATA_DIR}/stations.json`)
    ]);
    const geometryData = await loadJSON(`${DATA_DIR}/railway-geometries.json`).catch(() => null);
    const geometryLookup = buildGeometryLookup(geometryData);

    const stationLookup = new Map(stations.map(st => [st.id, st]));
    const featureCollection = buildFeatures(railways, stationLookup, geometryLookup);
    const railDirections = buildRailDirections(railways);
    const timetables = buildTimetables(railways);

    saveJSON('build/data/features.json.gz', featureCollection);
    saveJSON('build/data/rail-directions.json.gz', railDirections);
    saveJSON('build/data/train-types.json.gz', []);
    saveJSON('build/data/train-vehicles.json.gz', []);

    // Reuse the same demo timetable across all calendar variants.
    saveJSON('build/data/timetable-weekday.json.gz', timetables);
    saveJSON('build/data/timetable-holiday.json.gz', timetables);
    saveJSON('build/data/timetable-saturday.json.gz', timetables);
    saveJSON('build/data/timetable-sunday-holiday.json.gz', timetables);

}
