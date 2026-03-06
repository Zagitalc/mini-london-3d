import turfDistance from '@turf/distance';
import { point } from '@turf/helpers';

export function getOrderedLondonStationOffsets(stationCoords) {
    const offsets = [];
    let total = 0;

    for (let i = 0; i < stationCoords.length; i++) {
        if (i > 0) {
            total += turfDistance(point(stationCoords[i - 1]), point(stationCoords[i]));
        }
        offsets.push(total);
    }

    return offsets;
}

export function shouldUseStationOrderGeometry(stationOffsets, stationCoords) {
    let inversions = 0;
    let suspiciousSteps = 0;

    for (let i = 1; i < stationOffsets.length; i++) {
        const projectedStep = stationOffsets[i] - stationOffsets[i - 1];
        const directStep = turfDistance(point(stationCoords[i - 1]), point(stationCoords[i]));

        if (!Number.isFinite(projectedStep) || projectedStep < -1e-6) {
            inversions++;
            continue;
        }
        if (projectedStep > Math.max(directStep * 6, 5)) {
            suspiciousSteps++;
        }
    }

    return inversions > 0 || suspiciousSteps > 0;
}

export function getLondonStationAnchor(stations) {
    if (!Array.isArray(stations) || stations.length === 0) return null;
    if (stations.length === 1) return stations[0].coord;

    let bestCoord = stations[0].coord;
    let bestScore = Infinity;

    for (const station of stations) {
        if (!station || !Array.isArray(station.coord)) continue;
        let score = 0;

        for (const other of stations) {
            if (!other || !Array.isArray(other.coord)) continue;
            const dx = station.coord[0] - other.coord[0];
            const dy = station.coord[1] - other.coord[1];

            score += dx * dx + dy * dy;
        }
        if (score < bestScore) {
            bestScore = score;
            bestCoord = station.coord;
        }
    }

    return bestCoord;
}
