// Fetches TfL StopPoint details for every station in the London snapshot and
// writes assets/london-build-data/station-facilities.json.gz, updating the
// manifest. Run locally (the hosted build never calls TfL):
//
//   TFL_APP_KEY=... npm run build-data:london-facilities
//
// The key is read from the environment and never written to the output.

import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

import {gzipJSON} from '../src/helpers/deterministic-gzip.mjs';
import {extractLondonStationFacilities} from '../src/helpers/london-station-facilities.mjs';

const DATA_DIR = new URL('../assets/london-build-data/', import.meta.url);
const OUTPUT = 'station-facilities.json.gz';
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 4;

const appKey = process.env.TFL_APP_KEY;
if (!appKey) {
    console.warn('TFL_APP_KEY is not set; calling TfL anonymously, which may hit the rate limit.');
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchStopPoint(id) {
    const url = new URL(`https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(id)}`);
    if (appKey) url.searchParams.set('app_key', appKey);

    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url, {headers: {Accept: 'application/json'}});
        if (res.ok) return res.json();
        if (attempt >= MAX_ATTEMPTS || (res.status !== 429 && res.status < 500)) {
            throw new Error(`HTTP ${res.status}`);
        }
        await sleep(1000 * 2 ** attempt);
    }
}

const stations = JSON.parse(gunzipSync(await readFile(new URL('stations.json.gz', DATA_DIR))));
const ids = [...new Set(stations.map(station => String(station.id).split('.').pop().toUpperCase()))].sort();
console.log(`Fetching ${ids.length} stop points…`);

const results = {};
const failures = [];
const keyCounts = new Map();
let next = 0;

await Promise.all(Array.from({length: CONCURRENCY}, async () => {
    while (next < ids.length) {
        const id = ids[next++];
        try {
            const record = extractLondonStationFacilities(await fetchStopPoint(id));
            if (record) {
                results[id] = record;
                for (const {key} of record.facilities) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
            }
        } catch (e) {
            failures.push(`${id}: ${e.message}`);
        }
    }
}));

// Sorted keys keep the output byte-identical between runs with the same data.
const payload = {
    source: 'TfL Unified API, GET /StopPoint/{id} additionalProperties',
    stations: Object.fromEntries(Object.keys(results).sort().map(id => [id, results[id]]))
};
const compressed = await gzipJSON(payload);
await writeFile(new URL(OUTPUT, DATA_DIR), compressed);

const manifestUrl = new URL('manifest.json', DATA_DIR);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
manifest.files[OUTPUT] = {sha256: sha256(compressed), payloadSha256: sha256(JSON.stringify(payload))};
manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${OUTPUT}: ${Object.keys(results).length} of ${ids.length} stations have data, ${(compressed.length / 1024).toFixed(1)} KB.`);
console.log('Facility keys seen (station count):');
for (const [key, count] of [...keyCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${key}: ${count}`);
if (failures.length) {
    console.warn(`${failures.length} failed:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
}
