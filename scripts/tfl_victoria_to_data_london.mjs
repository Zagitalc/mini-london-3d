// scripts/tfl_victoria_to_data_london.mjs
import fs from "node:fs/promises";

const APP_ID = process.env.TFL_APP_ID || "";
const APP_KEY = process.env.TFL_APP_KEY || "";

function tfl(url) {
    const u = new URL(url);
    if (APP_ID) u.searchParams.set("app_id", APP_ID);
    if (APP_KEY) u.searchParams.set("app_key", APP_KEY);
    return fetch(u).then(r => {
        if (!r.ok) throw new Error(`TfL ${r.status} ${r.statusText} for ${u}`);
        return r.json();
    });
}

// Simple helpers
const slug = (s) =>
    s.replace(/&/g, "and")
        .replace(/[^a-zA-Z0-9]+/g, "")
        .replace(/^\d+/, "");

const LINE_ID = "tfl.victoria";
const LINE_NAME = "Victoria line";
const LINE_COLOR = "#0098D4"; // Victoria line light blue (close enough)
const CAR_COMPOSITION = 8; // typical on Victoria (good enough for MVP)

// 1) Get route sequence (ordered stop points)
async function fetchVictoriaStopsAndLineStrings() {
    const data = await tfl("https://api.tfl.gov.uk/Line/victoria/Route/Sequence/all");

    // In your response it's `stations`, `stopPointSequences`, and (optionally) `lineStrings`
    const stations = data.stations;
    if (!Array.isArray(stations) || stations.length === 0) {
        throw new Error("Unexpected TfL response: missing stations[]");
    }

    const stopPointSequences = data.stopPointSequences || [];
    const lineStrings = data.lineStrings || []; // optional
    return { stations, stopPointSequences, lineStrings };
}

// 1b) Get full stop points (ids + coords) for the line
async function fetchVictoriaStopPoints() {
    const data = await tfl("https://api.tfl.gov.uk/Line/victoria/StopPoints");
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error("Unexpected TfL response: missing stop points[]");
    }
    return data;
}


// 2) Convert to MT3D stations + railway
async function main() {
    const { stations: tflStations, stopPointSequences } = await fetchVictoriaStopsAndLineStrings();
    const stopPoints = await fetchVictoriaStopPoints();

    const stationById = new Map();
    for (const sp of stopPoints) stationById.set(sp.id, sp);
    for (const sp of tflStations) {
        if (!stationById.has(sp.id)) stationById.set(sp.id, sp);
    }

    // Long-term correct ordering: use TfL stopPointSequences (ordered stop points).
    // Prefer the longest sequence as the full line.
    const orderedStopIds = Array.isArray(stopPointSequences) && stopPointSequences.length
        ? (stopPointSequences.reduce((a, b) => (a.stopPoint?.length || 0) >= (b.stopPoint?.length || 0) ? a : b)
            .stopPoint || [])
            .map(sp => sp.id)
            .filter(id => stationById.has(id))
        : [];

    const orderedStations = orderedStopIds.length
        ? orderedStopIds.map(id => stationById.get(id)).filter(Boolean)
        : stopPoints;

    const stations = orderedStations.map(sp => ({
        // Use NaPTAN id as stable id, and prefix with line id to match MT3D style
        id: `${LINE_ID}.${sp.id}`,          // e.g. tfl.victoria.940GZZLUOXC
        railway: LINE_ID,
        coord: [sp.lon, sp.lat],
        title: { en: (sp.commonName || sp.name || "").replace(" Underground Station", "").trim() }
    }));


    // Build railway line
    const railway = [{
        id: LINE_ID,
        title: { en: LINE_NAME },
        stations: stations.map(s => s.id),
        ascending: "Northbound",
        descending: "Southbound",
        color: LINE_COLOR,
        carComposition: CAR_COMPOSITION
    }];


    // Minimal station-groups (required by your current stations loader)
    // For now: each station alone as its own group, in the same format loader expects (array-of-groups).
    // Your loader expects groups like [[[id1, id2,...]], ...] (from your earlier code).
    // We'll make each group: [[stationId]]
    const stationGroups = stations.map(s => [[s.id]]);

    await fs.mkdir("data-london", { recursive: true });
    await fs.writeFile("data-london/stations.json", JSON.stringify(stations, null, 2));
    await fs.writeFile("data-london/railways.json", JSON.stringify(railway, null, 2));
    await fs.writeFile("data-london/station-groups.json", JSON.stringify(stationGroups, null, 2));

    console.log(`Wrote ${stations.length} stations to data-london/stations.json`);
    console.log(`Wrote 1 railway to data-london/railways.json`);
    console.log(`Wrote station groups to data-london/station-groups.json`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
