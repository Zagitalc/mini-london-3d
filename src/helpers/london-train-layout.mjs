// Close-up decluttering only. Overview markers stay on their route anchors.
// Both ground distance and screen distance bound every presentation offset.
export const LONDON_TRAIN_MAX_OFFSET = 40;

export const LONDON_TRAIN_MAX_OFFSET_METRES = 20;

export function getLondonTrainOffsetLimit(zoom, pixelsPerMetre, perspectivePerMetre = 0) {
    if (!Number.isFinite(pixelsPerMetre)) return 0;
    const t = Math.max(0, Math.min(1, (zoom - 15) / 2));
    const fade = t * t * (3 - 2 * t);
    // Perspective divides a projected ground offset by (1 + q · distance).
    // Use its largest denominator over the permitted ground disc, so the
    // screen-space disc fits inside it even toward the camera's horizon.
    const metres = LONDON_TRAIN_MAX_OFFSET_METRES;
    const groundLimit = Math.max(0, pixelsPerMetre) * metres / (1 + metres * Math.max(0, perspectivePerMetre));
    return Math.min(LONDON_TRAIN_MAX_OFFSET, groundLimit) * fade;
}

export function clampLondonTrainOffset(offset, limit) {
    const distance = Math.hypot(offset.x, offset.y);
    const ratio = distance ? Math.min(1, limit / distance) : 0;
    return {x: offset.x * ratio, y: offset.y * ratio};
}

// Smallest projected scale of a metre in any ground-plane direction. Using
// either axis alone overestimates the available space on pitched/rotated maps.
export function getMinimumPixelsPerMetre(origin, east, north) {
    const ax = east.x - origin.x, ay = east.y - origin.y;
    const bx = north.x - origin.x, by = north.y - origin.y;
    const trace = ax * ax + ay * ay + bx * bx + by * by;
    const determinant = ax * by - ay * bx;
    return Math.sqrt(Math.max(0, (trace - Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant))) / 2));
}

function overlaps(a, b) {
    return Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth + 2 &&
        Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight + 2;
}

export function layoutLondonTrainMarkers(markers, previous = new Map()) {
    const placed = [];
    const offsets = new Map();
    const sorted = markers.slice().sort((a, b) => a.key.localeCompare(b.key));

    for (const marker of sorted) {
        const limit = Math.max(0, Math.min(LONDON_TRAIN_MAX_OFFSET, marker.maxOffset || 0));
        if (!limit) {
            offsets.set(marker.id, {x: 0, y: 0});
            placed.push(marker);
            continue;
        }
        const neighbours = sorted.filter(other => other !== marker && overlaps(marker, other));
        const old = previous.get(marker.id);
        const candidates = [{x: 0, y: 0}];
        // Keep an established slot while the group is crowded, independent of
        // feed order. Reclaim the true position when the group disperses.
        if (neighbours.length && old) {
            candidates.unshift(clampLondonTrainOffset(old, limit));
        }
        const step = Math.min(limit, Math.max(6, Math.min(14, marker.breadth + 3)));
        for (let distance = step; distance <= limit; distance += step) {
            for (const sign of [-1, 1]) {
                candidates.push({x: marker.nx * distance * sign, y: marker.ny * distance * sign});
            }
        }
        // Crossings need more than perpendicular slots. Sample a bounded disc
        // so crowded groups can use distinct centres even when boxes touch.
        for (const radius of [limit / 3, limit * 2 / 3, limit]) {
            for (let i = 0; i < 12; i++) {
                const angle = i * Math.PI / 6;
                candidates.push({x: Math.cos(angle) * radius, y: Math.sin(angle) * radius});
            }
        }
        let best = candidates[0];
        let bestCount = Infinity;
        for (const candidate of candidates) {
            const box = {...marker, x: marker.x + candidate.x, y: marker.y + candidate.y};
            let count = 0;
            for (const other of placed) {
                const dx = Math.abs(box.x - other.x), dy = Math.abs(box.y - other.y);
                const overlapX = Math.max(0, box.halfWidth + other.halfWidth + 2 - dx);
                const overlapY = Math.max(0, box.halfHeight + other.halfHeight + 2 - dy);
                count += overlapX * overlapY + Math.max(0, 8 - Math.hypot(dx, dy)) * 1000;
            }
            if (count < bestCount) {
                best = candidate;
                bestCount = count;
            }
            if (!count) break;
        }
        offsets.set(marker.id, best);
        placed.push({...marker, x: marker.x + best.x, y: marker.y + best.y});
    }
    return offsets;
}
