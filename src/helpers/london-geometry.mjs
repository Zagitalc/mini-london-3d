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

export function smoothLondonStationLine(stationCoords, subdivisions = 4) {
    if (!Array.isArray(stationCoords) || stationCoords.length < 3) {
        return Array.isArray(stationCoords) ? stationCoords.slice() : [];
    }

    const smoothCoord = (p0, p1, p2, p3, t, index) => {
        const v0 = p0[index];
        const v1 = p1[index];
        const v2 = p2[index];
        const v3 = p3[index];
        const t2 = t * t;
        const t3 = t2 * t;

        return 0.5 * (
            (2 * v1) +
            (-v0 + v2) * t +
            (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
            (-v0 + 3 * v1 - 3 * v2 + v3) * t3
        );
    };

    const line = [stationCoords[0]];

    for (let i = 0; i < stationCoords.length - 1; i++) {
        const p0 = stationCoords[Math.max(0, i - 1)];
        const p1 = stationCoords[i];
        const p2 = stationCoords[i + 1];
        const p3 = stationCoords[Math.min(stationCoords.length - 1, i + 2)];

        for (let step = 1; step <= subdivisions; step++) {
            const t = step / subdivisions;
            line.push([
                smoothCoord(p0, p1, p2, p3, t, 0),
                smoothCoord(p0, p1, p2, p3, t, 1)
            ]);
        }
    }

    return line;
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
