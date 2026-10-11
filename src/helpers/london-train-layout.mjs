// Presentation-only decluttering. The simulation positions and identities never
// move: nearby markers get a bounded screen offset shared by every render pass.
export const LONDON_TRAIN_MAX_OFFSET = 40;

function overlaps(a, b) {
    return Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth + 2 &&
        Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight + 2;
}

export function layoutLondonTrainMarkers(markers, previous = new Map()) {
    const placed = [];
    const offsets = new Map();
    const sorted = markers.slice().sort((a, b) => a.key.localeCompare(b.key));

    for (const marker of sorted) {
        const neighbours = sorted.filter(other => other !== marker && overlaps(marker, other));
        const old = previous.get(marker.id);
        const candidates = [{x: 0, y: 0}];
        // Keep an established slot while the group is crowded, independent of
        // feed order. Reclaim the true position when the group disperses.
        if (neighbours.length && old && Math.hypot(old.x, old.y) <= LONDON_TRAIN_MAX_OFFSET) {
            candidates.unshift(old);
        }
        const step = Math.max(6, Math.min(14, marker.breadth + 3));
        for (let distance = step; distance <= LONDON_TRAIN_MAX_OFFSET; distance += step) {
            for (const sign of [-1, 1]) {
                candidates.push({x: marker.nx * distance * sign, y: marker.ny * distance * sign});
            }
        }
        // Crossings need more than perpendicular slots. Sample a bounded disc
        // so crowded groups can use distinct centres even when boxes touch.
        for (const radius of [14, 28, LONDON_TRAIN_MAX_OFFSET]) {
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
