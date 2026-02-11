// scripts/tfl_tube_to_data_london.mjs
// Build data-london railways/stations/station-groups + geometries for all Tube lines.
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = 'data-london';
const BASE_URL = 'https://api.tfl.gov.uk';
const APP_ID = process.env.TFL_APP_ID || '';
const APP_KEY = process.env.TFL_APP_KEY || '';

const DEFAULT_CAR_COMPOSITION = 8;
const TFL_LINE_COLORS = {
  bakerloo: '#B36305',
  central: '#E32017',
  circle: '#FFD300',
  district: '#00782A',
  'hammersmith-city': '#F3A9BB',
  jubilee: '#A0A5A9',
  metropolitan: '#9B0056',
  northern: '#000000',
  piccadilly: '#003688',
  victoria: '#0098D4',
  'waterloo-city': '#95CDBA'
};

const LINE_SLUG_OVERRIDES = {
  'hammersmith-city': 'hammersmith',
  'waterloo-city': 'waterloo'
};

function cleanName(name) {
  return String(name || '')
    .replace(/ Underground Station/gi, '')
    .replace(/ Station/gi, '')
    .trim();
}

function slugifyLineId(lineId) {
  const id = String(lineId || '').toLowerCase();
  return LINE_SLUG_OVERRIDES[id] || id;
}

function tfl(pathname) {
  const url = new URL(BASE_URL + pathname);
  if (APP_ID) url.searchParams.set('app_id', APP_ID);
  if (APP_KEY) url.searchParams.set('app_key', APP_KEY);
  return fetch(url).then(async res => {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TfL ${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  });
}

function haversineMeters(a, b) {
  const toRad = d => d * Math.PI / 180;
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
  const cleaned = coords.filter(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return cleaned.length >= 2 ? cleaned : null;
}

function extractCandidateLines(geojson) {
  const lines = [];
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === 'LineString') {
      const line = normalizeLine(g.coordinates);
      if (line) lines.push(line);
    } else if (g.type === 'MultiLineString') {
      for (const part of g.coordinates || []) {
        const line = normalizeLine(part);
        if (line) lines.push(line);
      }
    }
  }
  return lines;
}

function mergeLinesIntoSegments(lines, maxJoinMeters = 200) {
  if (!lines.length) return [];
  const remaining = lines.map(line => line.slice());
  const segments = [];

  while (remaining.length) {
    let merged = remaining.shift();
    let changed = true;

    while (changed) {
      changed = false;
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

        const dStartToStart = haversineMeters(start, lStart);
        const dStartToEnd = haversineMeters(start, lEnd);
        const dEndToStart = haversineMeters(end, lStart);
        const dEndToEnd = haversineMeters(end, lEnd);

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

      if (bestIdx === -1 || bestDist > maxJoinMeters) {
        break;
      }

      const next = remaining.splice(bestIdx, 1)[0];
      const line = bestReverse ? next.slice().reverse() : next;
      merged = bestAtStart ? line.concat(merged) : merged.concat(line);
      changed = true;
    }

    segments.push(merged);
  }

  return segments;
}

function minDistanceToLine(line, coord) {
  let best = Infinity;
  for (const p of line) {
    const d = haversineMeters(p, coord);
    if (d < best) best = d;
  }
  return best;
}

function pickBestLine(segments, stationCoords) {
  if (!segments.length || !stationCoords.length) return null;
  let best = null;
  let bestCount = -1;
  let bestTotal = Infinity;
  const maxDist = 400; // meters

  for (const line of segments) {
    let count = 0;
    let total = 0;
    for (const coord of stationCoords) {
      const d = minDistanceToLine(line, coord);
      if (d <= maxDist) count++;
      total += Math.min(d, maxDist);
    }
    if (count > bestCount || (count === bestCount && total < bestTotal)) {
      best = line;
      bestCount = count;
      bestTotal = total;
    }
  }
  return best;
}

function dedupeStationsById(stations) {
  const seen = new Set();
  const out = [];
  for (const st of stations) {
    if (seen.has(st.id)) continue;
    seen.add(st.id);
    out.push(st);
  }
  return out;
}

async function loadOsmGeojsonBySlug() {
  const entries = await fs.readdir(DATA_DIR);
  const bySlug = new Map();

  for (const entry of entries) {
    if (!entry.startsWith('osm-') || !entry.endsWith('.geojson')) continue;
    const slug = entry.slice(4, -8); // remove osm- and .geojson
    const raw = await fs.readFile(path.join(DATA_DIR, entry), 'utf8');
    const geojson = JSON.parse(raw);
    const lines = extractCandidateLines(geojson);
    const segments = mergeLinesIntoSegments(lines);
    if (segments.length) {
      bySlug.set(slug, segments);
    }
  }

  return bySlug;
}

async function main() {
  const lines = await tfl('/Line/Mode/tube');
  if (!Array.isArray(lines) || !lines.length) {
    throw new Error('TfL returned no tube lines.');
  }

  const osmSegmentsBySlug = await loadOsmGeojsonBySlug();

  const stations = [];
  const stationGroups = new Map();
  const railways = [];
  const geometries = [];

  for (const line of lines) {
    const lineId = line.id;
    const lineName = line.name || lineId;
    const lineColor = (
      line.colour ||
      line.color ||
      line.routeColour ||
      TFL_LINE_COLORS[lineId] ||
      '#0098D4'
    );
    const slug = slugifyLineId(lineId);

    const stopPoints = await tfl(`/Line/${lineId}/StopPoints`);
    const stopPointMap = new Map();
    for (const sp of stopPoints || []) {
      stopPointMap.set(sp.id, sp);
    }

    // Create station entries per line (lineId + stopPointId)
    for (const sp of stopPoints || []) {
      const stationId = `tfl.${lineId}.${sp.id}`;
      stations.push({
        id: stationId,
        railway: `tfl.${lineId}`,
        coord: [sp.lon, sp.lat],
        title: { en: cleanName(sp.commonName || sp.name) }
      });
      if (!stationGroups.has(sp.id)) stationGroups.set(sp.id, []);
      stationGroups.get(sp.id).push(stationId);
    }

    const seqData = await tfl(`/Line/${lineId}/Route/Sequence/all`);
    const sequences = Array.isArray(seqData?.stopPointSequences) && seqData.stopPointSequences.length
      ? seqData.stopPointSequences
      : [];

    const fallbackStops = Array.isArray(seqData?.stations) ? seqData.stations : stopPoints;

    const seqList = sequences.length ? sequences : [{
      direction: 'all',
      name: lineName,
      stopPoint: (fallbackStops || []).map(sp => ({ id: sp.id }))
    }];

    seqList.forEach((seq, index) => {
      const stopIds = (seq.stopPoint || [])
        .map(sp => sp.id)
        .filter(id => stopPointMap.has(id));

      if (stopIds.length < 2) return;

      const stationIds = stopIds.map(id => `tfl.${lineId}.${id}`);
      const branchSuffix = seqList.length > 1 ? `.${index + 1}` : '';
      const railwayId = `tfl.${lineId}${branchSuffix}`;
      const titleSuffix = seqList.length > 1 ? ` (${seq.name || seq.direction || `Branch ${index + 1}`})` : '';

      railways.push({
        id: railwayId,
        lineId,
        geometryId: railwayId,
        osmSlug: slug,
        title: { en: `${lineName}${titleSuffix}` },
        stations: stationIds,
        ascending: seq.direction === 'inbound' ? 'Inbound' : 'Northbound',
        descending: seq.direction === 'inbound' ? 'Outbound' : 'Southbound',
        color: lineColor,
        carComposition: DEFAULT_CAR_COMPOSITION
      });

      const stationCoords = stationIds
        .map(id => stations.find(s => s.id === id))
        .filter(Boolean)
        .map(s => s.coord);

      const segments = osmSegmentsBySlug.get(slug) || [];
      const bestLine = segments.length ? pickBestLine(segments, stationCoords) : null;
      const coords = Array.isArray(bestLine) && bestLine.length >= 2 ? bestLine : stationCoords;
      if (coords && coords.length >= 2) {
        geometries.push({ id: railwayId, coordinates: coords });
      }
    });
  }

  const stationGroupsArray = Array.from(stationGroups.values()).map(ids => [ids]);

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'stations.json'), JSON.stringify(dedupeStationsById(stations), null, 2));
  await fs.writeFile(path.join(DATA_DIR, 'railways.json'), JSON.stringify(railways, null, 2));
  await fs.writeFile(path.join(DATA_DIR, 'station-groups.json'), JSON.stringify(stationGroupsArray, null, 2));
  await fs.writeFile(path.join(DATA_DIR, 'railway-geometries.json'), JSON.stringify(geometries, null, 2));

  console.log(`Wrote ${railways.length} railways`);
  console.log(`Wrote ${stations.length} stations`);
  console.log(`Wrote ${stationGroupsArray.length} station groups`);
  console.log(`Wrote ${geometries.length} geometries`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
