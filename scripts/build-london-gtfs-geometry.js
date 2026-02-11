/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { unzipSync } from 'fflate';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function usage() {
    console.log('Usage: node scripts/build-london-gtfs-geometry.js <gtfs.zip|url> [out.json]');
    console.log('Example: node scripts/build-london-gtfs-geometry.js data-london/tfl-gtfs.zip data-london/railway-geometries.json');
}

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

function readInput(inputPath) {
    if (/^https?:\/\//i.test(inputPath)) {
        return fetchBuffer(inputPath);
    }
    return fs.promises.readFile(inputPath);
}

function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '"') {
            if (inQuotes && next === '"') {
                field += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (ch === ',' && !inQuotes) {
            row.push(field);
            field = '';
            continue;
        }

        if ((ch === '\n' || ch === '\r') && !inQuotes) {
            if (ch === '\r' && next === '\n') {
                i++;
            }
            row.push(field);
            field = '';
            if (row.length > 1 || row[0] !== '') {
                rows.push(row);
            }
            row = [];
            continue;
        }

        field += ch;
    }

    if (field.length || row.length) {
        row.push(field);
        rows.push(row);
    }

    if (!rows.length) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1).map(cols => {
        const obj = {};
        for (let i = 0; i < headers.length; i++) {
            obj[headers[i]] = cols[i] !== undefined ? cols[i].trim() : '';
        }
        return obj;
    });
}

function haversineKm(a, b) {
    const toRad = d => d * Math.PI / 180;
    const R = 6371;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function lineLength(coords) {
    let len = 0;
    for (let i = 1; i < coords.length; i++) {
        len += haversineKm(coords[i - 1], coords[i]);
    }
    return len;
}

function normalizeLineName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/line/g, '')
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function routeToRailwayId(route) {
    const name = route.route_short_name || route.route_long_name || route.route_desc || '';
    const norm = normalizeLineName(name);
    if (!norm) return null;
    return `tfl.${norm}`;
}

async function main() {
    const input = process.argv[2];
    if (!input) {
        usage();
        process.exit(1);
    }

    const outPath = process.argv[3] || path.resolve(__dirname, '..', 'data-london', 'railway-geometries.json');
    const railwaysPath = path.resolve(__dirname, '..', 'data-london', 'railways.json');
    const allowedRailways = new Set(JSON.parse(await fs.promises.readFile(railwaysPath, 'utf8')).map(r => r.id));

    const buffer = await readInput(input);
    const unzipped = unzipSync(new Uint8Array(buffer));

    const shapesFile = unzipped['shapes.txt'];
    const tripsFile = unzipped['trips.txt'];
    const routesFile = unzipped['routes.txt'];

    if (!shapesFile || !tripsFile || !routesFile) {
        console.error('Missing shapes.txt, trips.txt, or routes.txt in GTFS.');
        process.exit(1);
    }

    const shapes = parseCSV(Buffer.from(shapesFile).toString('utf8'));
    const trips = parseCSV(Buffer.from(tripsFile).toString('utf8'));
    const routes = parseCSV(Buffer.from(routesFile).toString('utf8'));

    const routeById = new Map(routes.map(r => [r.route_id, r]));

    const tripByRoute = new Map();
    for (const t of trips) {
        const routeId = t.route_id;
        const shapeId = t.shape_id;
        if (!routeId || !shapeId) continue;
        if (!tripByRoute.has(routeId)) tripByRoute.set(routeId, []);
        tripByRoute.get(routeId).push(shapeId);
    }

    const shapeCoords = new Map();
    for (const s of shapes) {
        const shapeId = s.shape_id;
        if (!shapeId) continue;
        const lat = Number(s.shape_pt_lat);
        const lon = Number(s.shape_pt_lon);
        const seq = Number(s.shape_pt_sequence);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(seq)) continue;
        if (!shapeCoords.has(shapeId)) shapeCoords.set(shapeId, []);
        shapeCoords.get(shapeId).push({ seq, coord: [lon, lat] });
    }

    for (const list of shapeCoords.values()) {
        list.sort((a, b) => a.seq - b.seq);
    }

    const geometry = [];

    for (const [routeId, shapeIds] of tripByRoute.entries()) {
        const route = routeById.get(routeId);
        if (!route) continue;
        const railwayId = routeToRailwayId(route);
        if (!railwayId || !allowedRailways.has(railwayId)) continue;

        let bestShape = null;
        let bestLen = -1;
        for (const shapeId of shapeIds) {
            const list = shapeCoords.get(shapeId);
            if (!list || list.length < 2) continue;
            const coords = list.map(item => item.coord);
            const len = lineLength(coords);
            if (len > bestLen) {
                bestLen = len;
                bestShape = coords;
            }
        }

        if (bestShape && bestShape.length >= 2) {
            geometry.push({ id: railwayId, coordinates: bestShape });
            console.log(`✔ ${railwayId} (${bestShape.length} points)`);
        }
    }

    if (!geometry.length) {
        console.warn('No matching railways found. Check GTFS routes vs data-london/railways.json IDs.');
    }

    await fs.promises.writeFile(outPath, JSON.stringify(geometry, null, 2));
    console.log(`Wrote ${geometry.length} line geometries to ${outPath}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
