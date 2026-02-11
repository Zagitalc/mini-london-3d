// scripts/tfl_victoria_geometry_to_data_london.mjs
import fs from "node:fs/promises";

const APP_ID = process.env.TFL_APP_ID || "";
const APP_KEY = process.env.TFL_APP_KEY || "";

const LINE_ID = "victoria";
const OUTPUT_PATH = "data-london/railway-geometries.json";
const RAILWAY_ID = "tfl.victoria";

function tfl(url) {
    const u = new URL(url);
    if (APP_ID) u.searchParams.set("app_id", APP_ID);
    if (APP_KEY) u.searchParams.set("app_key", APP_KEY);
    return fetch(u).then(r => {
        if (!r.ok) throw new Error(`TfL ${r.status} ${r.statusText} for ${u}`);
        return r.json();
    });
}

function isNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}

function normalizePair(pair) {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    let x = Number(pair[0]);
    let y = Number(pair[1]);
    if (!isNumber(x) || !isNumber(y)) return null;
    // If it looks like [lat, lon], swap to [lon, lat].
    const looksLikeLat = v => v >= 48 && v <= 62;
    const looksLikeLon = v => v >= -4 && v <= 4;
    if (looksLikeLat(x) && looksLikeLon(y)) {
        [x, y] = [y, x];
    }
    return [x, y];
}

function coordsFromString(lineString) {
    const nums = String(lineString).match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 4) return [];
    const coords = [];
    for (let i = 0; i < nums.length - 1; i += 2) {
        const pair = normalizePair([Number(nums[i]), Number(nums[i + 1])]);
        if (pair) coords.push(pair);
    }
    return coords;
}

function coordsFromArray(value) {
    if (!Array.isArray(value)) return [];
    if (value.length === 0) return [];
    if (Array.isArray(value[0])) {
        const flat = [];
        for (const item of value) {
            const coords = coordsFromArray(item);
            if (coords.length) flat.push(...coords);
        }
        return flat;
    }
    const pair = normalizePair(value);
    return pair ? [pair] : [];
}

function collectLineStrings(data) {
    const collected = [];

    const pushCoords = (coords) => {
        if (Array.isArray(coords) && coords.length >= 2) collected.push(coords);
    };

    const handleValue = (value) => {
        if (value == null) return;
        if (typeof value === "string") {
            pushCoords(coordsFromString(value));
            return;
        }
        if (Array.isArray(value)) {
            const coords = coordsFromArray(value);
            if (coords.length) {
                pushCoords(coords);
                return;
            }
            for (const item of value) handleValue(item);
            return;
        }
        if (typeof value === "object") {
            if (value.lineString) handleValue(value.lineString);
            if (value.lineStrings) handleValue(value.lineStrings);
        }
    };

    handleValue(data?.lineStrings);
    if (Array.isArray(data?.stopPointSequences)) {
        for (const seq of data.stopPointSequences) {
            handleValue(seq?.lineString);
            handleValue(seq?.lineStrings);
        }
    }
    if (Array.isArray(data?.orderedLineRoutes)) {
        for (const route of data.orderedLineRoutes) {
            handleValue(route?.lineString);
            handleValue(route?.lineStrings);
        }
    }
    return collected;
}

function coordsFromStopPointSequences(data) {
    if (!Array.isArray(data?.stopPointSequences)) return [];
    const longest = data.stopPointSequences.reduce((best, seq) => {
        const len = Array.isArray(seq?.stopPoint) ? seq.stopPoint.length : 0;
        return len > best.len ? { seq, len } : best;
    }, { seq: null, len: 0 });
    const stopPoints = longest.seq?.stopPoint || [];
    const coords = [];
    for (const sp of stopPoints) {
        if (isNumber(sp?.lon) && isNumber(sp?.lat)) coords.push([sp.lon, sp.lat]);
    }
    return coords;
}

function pickLongest(lines) {
    if (!lines.length) return [];
    return lines.reduce((best, line) => (line.length > best.length ? line : best), lines[0]);
}

async function main() {
    if (!APP_ID || !APP_KEY) {
        throw new Error("Missing TFL_APP_ID or TFL_APP_KEY. Export them in your shell before running.");
    }

    const data = await tfl(`https://api.tfl.gov.uk/Line/${LINE_ID}/Route/Sequence/all`);
    const lineStrings = collectLineStrings(data);
    let coords = pickLongest(lineStrings);

    if (!coords.length) {
        coords = coordsFromStopPointSequences(data);
    }

    if (coords.length < 2) {
        throw new Error("No usable line geometry found in TfL response.");
    }

    await fs.mkdir("data-london", { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify([{ id: RAILWAY_ID, coordinates: coords }], null, 2));

    console.log(`Wrote ${coords.length} points to ${OUTPUT_PATH}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
