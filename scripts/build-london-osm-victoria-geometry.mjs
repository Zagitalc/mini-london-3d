// scripts/build-london-osm-victoria-geometry.mjs
// Convert OSM/Overpass GeoJSON for the Victoria line into data-london/railway-geometries.json
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = "data-london/osm-victoria.geojson";
const DEFAULT_OUTPUT = "data-london/railway-geometries.json";
const RAILWAY_ID = "tfl.victoria";

function isNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}

function haversine(a, b) {
    const toRad = (d) => d * Math.PI / 180;
    const [lon1, lat1] = a;
    const [lon2, lat2] = b;
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const s1 = Math.sin(dLat / 2);
    const s2 = Math.sin(dLon / 2);
    const c = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
}

function normalizeLine(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const cleaned = coords.filter(p => Array.isArray(p) && p.length >= 2 && isNumber(p[0]) && isNumber(p[1]));
    return cleaned.length >= 2 ? cleaned : null;
}

function getFeatureLength(feature) {
    const g = feature && feature.geometry;
    if (!g) return 0;
    if (g.type === "LineString") return g.coordinates.length;
    if (g.type === "MultiLineString") {
        return (g.coordinates || []).reduce((sum, part) => sum + (part ? part.length : 0), 0);
    }
    return 0;
}

function pickDirectionFeatures(features) {
    if (!features.length) return features;

    const isFullRoute = (p) => {
        const from = (p?.from || "").toLowerCase();
        const to = (p?.to || "").toLowerCase();
        const a = "walthamstow central";
        const b = "brixton";
        return (from === a && to === b) || (from === b && to === a);
    };

    const full = features.filter(f => isFullRoute(f.properties || {}));
    if (!full.length) return features;

    // Prefer Walthamstow Central -> Brixton (southbound) if present
    const preferred = full.filter(f => {
        const from = (f.properties?.from || "").toLowerCase();
        const to = (f.properties?.to || "").toLowerCase();
        return from === "walthamstow central" && to === "brixton";
    });

    const candidates = preferred.length ? preferred : full;
    const best = candidates.reduce((best, f) => (getFeatureLength(f) > getFeatureLength(best) ? f : best), candidates[0]);
    return [best];
}

function extractLines(geojson) {
    const lines = [];
    const rawFeatures = Array.isArray(geojson?.features) ? geojson.features : [];
    const features = pickDirectionFeatures(rawFeatures);
    for (const f of features) {
        const g = f?.geometry;
        if (!g) continue;
        if (g.type === "LineString") {
            const line = normalizeLine(g.coordinates);
            if (line) lines.push(line);
        } else if (g.type === "MultiLineString") {
            for (const part of g.coordinates || []) {
                const line = normalizeLine(part);
                if (line) lines.push(line);
            }
        }
    }
    return lines;
}

function lineLengthMeters(line) {
    let total = 0;
    for (let i = 1; i < line.length; i++) {
        total += haversine(line[i - 1], line[i]);
    }
    return total;
}

function joinLines(lines, { maxJoinMeters = 200 } = {}) {
    if (!lines.length) return [];
    const remaining = lines.slice();
    remaining.sort((a, b) => b.length - a.length);

    const segments = [];

    while (remaining.length) {
        let merged = remaining.shift().slice();

        while (remaining.length) {
            let bestIdx = -1;
            let bestAtStart = false;
            let bestReverse = false;
            let bestDist = Infinity;

            const start = merged[0];
            const end = merged[merged.length - 1];

            for (let i = 0; i < remaining.length; i++) {
                const line = remaining[i];
                const lStart = line[0];
                const lEnd = line[line.length - 1];

                const dStartToStart = haversine(start, lStart);
                const dStartToEnd = haversine(start, lEnd);
                const dEndToStart = haversine(end, lStart);
                const dEndToEnd = haversine(end, lEnd);

                const candidates = [
                    { dist: dStartToStart, atStart: true, reverse: true },
                    { dist: dStartToEnd, atStart: true, reverse: false },
                    { dist: dEndToStart, atStart: false, reverse: false },
                    { dist: dEndToEnd, atStart: false, reverse: true }
                ];

                for (const c of candidates) {
                    if (c.dist < bestDist) {
                        bestDist = c.dist;
                        bestIdx = i;
                        bestAtStart = c.atStart;
                        bestReverse = c.reverse;
                    }
                }
            }

            if (bestIdx === -1) break;
            if (bestDist > maxJoinMeters) {
                // Too large of a gap; keep as a separate segment.
                break;
            }

            const next = remaining.splice(bestIdx, 1)[0];
            const line = bestReverse ? next.slice().reverse() : next;
            merged = bestAtStart ? line.concat(merged) : merged.concat(line);
        }

        segments.push(merged);
    }

    if (segments.length === 1) return segments[0];

    // Keep the longest continuous segment to avoid straight-line bridges.
    let best = segments[0];
    let bestLen = lineLengthMeters(best);
    for (let i = 1; i < segments.length; i++) {
        const len = lineLengthMeters(segments[i]);
        if (len > bestLen) {
            bestLen = len;
            best = segments[i];
        }
    }
    return best;
}

async function main() {
    const inputPath = process.argv[2] || DEFAULT_INPUT;
    const outputPath = process.argv[3] || DEFAULT_OUTPUT;

    const raw = await fs.readFile(inputPath, "utf8");
    const geojson = JSON.parse(raw);
    const lines = extractLines(geojson);
    if (!lines.length) {
        throw new Error("No LineString geometries found in the GeoJSON.");
    }

    const merged = joinLines(lines);
    if (merged.length < 2) {
        throw new Error("Merged line has too few points.");
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify([{ id: RAILWAY_ID, coordinates: merged }], null, 2));

    console.log(`Wrote ${merged.length} points to ${outputPath}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
