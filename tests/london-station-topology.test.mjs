import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import test from 'node:test';
import {
    findLondonStationPath,
    getPlatformAreas,
    getStreetAreas,
    londonStationTopologyDestinationOptionsHTML,
    londonStationTopologyHTML,
    londonStationTopologyRouteHTML
} from '../src/helpers/london-station-topology.mjs';
import {createLondonStationProjection} from '../src/helpers/london-station-map.mjs';

const topology = JSON.parse(gunzipSync(readFileSync(new URL('../assets/london-build-data/station-topology.json.gz', import.meta.url))));
const context = JSON.parse(gunzipSync(readFileSync(new URL('../assets/london-build-data/baker-street-map.json.gz', import.meta.url))));

test('Baker Street snapshot exposes Tube platforms and non-bus street links', () => {
    assert.equal(topology.stationId, '940GZZLUBST');
    assert.equal(topology.areas.length, 21);
    assert.equal(topology.paths.length, 388);
    assert.deepEqual(getPlatformAreas(topology).map(area => area.name), [
        'BakSB', 'BakNB', 'HamEB', 'HamWB', 'JubSB', 'JubNB', 'MetWB', 'MetEB'
    ]);
    assert.deepEqual(getStreetAreas(topology).map(area => area.name), ['A-M-N', 'B-M-S', 'C-BAK', 'D-M-C']);
});

test('interchange route follows directed footpaths and includes walkway type and duration', () => {
    const route = findLondonStationPath(topology, '2', '6');

    assert.ok(route);
    assert.deepEqual(route.areas, ['2', '6']);
    assert.equal(route.duration, 2);
    assert.ok(route.paths.flatMap(path => path.parts).some(part => part.type === 'LEVEL'));
    assert.match(londonStationTopologyRouteHTML(topology, '2', '6'), /2 min/);
    assert.match(londonStationTopologyRouteHTML(topology, '2', '6'), /walkway/);
});

test('route panel explains unnamed street connections and supports saved selections', () => {
    const html = londonStationTopologyHTML({...topology, context}, {from: '6', to: '10'});

    assert.match(html, /Starting platform/);
    assert.match(html, /Destination platform or street access/);
    assert.match(html, /Street access · A-M-N/);
    assert.match(html, /Street links use TfL’s codes/);
    assert.match(html, /value="6" selected/);
    assert.match(html, /value="10" selected/);
});

test('street map and underground route share a metre-based geographic projection', () => {
    const {project, metresToPixels} = createLondonStationProjection(context.bounds);
    const [west, south, east, north] = context.bounds;
    for (const area of [...getPlatformAreas(topology), ...getStreetAreas(topology)]) {
        assert.ok(area.point.longitude >= west && area.point.longitude <= east);
        assert.ok(area.point.latitude >= south && area.point.latitude <= north);
    }
    const centre = [(west + east) / 2, (south + north) / 2];
    const east50m = [centre[0] + 50 / (111319.49 * Math.cos(centre[1] * Math.PI / 180)), centre[1]];
    const north50m = [centre[0], centre[1] + 50 / 111319.49];
    assert.ok(Math.abs(project(east50m)[0] - project(centre)[0] - 50 * metresToPixels) < 1e-7);
    assert.ok(Math.abs(project(centre)[1] - project(north50m)[1] - 50 * metresToPixels) < 1e-7);
    assert.ok(context.features.some(feature => feature.name === 'Baker Street' && feature.kind === 'road'));
    assert.ok(context.features.some(feature => feature.name === 'Marylebone Road' && feature.kind === 'road'));
    const html = londonStationTopologyRouteHTML({...topology, context}, '2', '10');
    assert.match(html, /london-topology-basemap-building/);
    assert.match(html, /Marylebone Road/);
    assert.match(html, /https:\/\/www.openstreetmap.org\/copyright/);
    assert.doesNotMatch(html, /NaN|Infinity/);
});

test('changing origin restores its previous platform as a destination and avoids self-routes', () => {
    const options = londonStationTopologyDestinationOptionsHTML(topology, '6', '6');
    assert.match(options, /value="2"/);
    assert.doesNotMatch(options, /value="6"/);
    assert.match(options, /value="10" selected/);
});

test('short vertical transfers show floor order and direction without simplifying a complex route', () => {
    const up = londonStationTopologyRouteHTML({...topology, context}, '2', '3');
    assert.match(up, /aria-label="stairs up from Level -5 to Level -4"/);
    assert.match(up, /london-topology-pin-leader/);
    assert.match(up, /Pins separated for clarity/);
    assert.match(up, /TfL walking estimate/);
    assert.ok(up.indexOf('Level -4</strong>') < up.indexOf('Level -5</strong>'));
    const down = londonStationTopologyRouteHTML({...topology, context}, '3', '2');
    assert.match(down, /aria-label="stairs down from Level -4 to Level -5"/);
    assert.ok(down.indexOf('Level -4</strong>') < down.indexOf('Level -5</strong>'));
    assert.doesNotMatch(londonStationTopologyRouteHTML(topology, '2', '6'), /london-topology-level-transfer/);
    assert.doesNotMatch(londonStationTopologyRouteHTML(topology, '2', '10'), /london-topology-level-transfer/);
});

test('snapshot dates use source metadata, fall back safely and never imply a live topology refresh', () => {
    const html = londonStationTopologyHTML(topology);
    assert.match(html, /Station paths snapshot · <time datetime="2026-10-26">26 Oct 2026<\/time>/);
    const fallback = londonStationTopologyHTML({...topology, dataBuild: null, generatedAt: '2026-10-25T23:30:00'});
    assert.match(fallback, /datetime="2026-10-25">25 Oct 2026/);
    const unknown = londonStationTopologyHTML({...topology, dataBuild: '2026-02-31', generatedAt: null});
    assert.match(unknown, /Station paths snapshot date unavailable/);
    assert.doesNotMatch(unknown.match(/<p class="london-topology-freshness">.*?<\/p>/)?.[0] || '', /Invalid Date|datetime=/);
});


test('six numbered platform labels match the reviewed TfL platform/direction references', () => {
    const html = londonStationTopologyHTML(topology);
    for (const [number, line, direction] of [
        [8, 'Bakerloo', 'southbound'], [9, 'Bakerloo', 'northbound'],
        [5, 'Circle + Hammersmith &amp; City', 'eastbound'], [6, 'Circle + Hammersmith &amp; City', 'westbound'],
        [7, 'Jubilee', 'southbound'], [10, 'Jubilee', 'northbound']
    ]) assert.ok(html.includes(`Platform ${number} · ${line} · ${direction}`));
    assert.match(html, /Coverage and source checks/);
    assert.match(html, /not been checked on site/);
    assert.match(html, /Level numbers are source codes/);
    assert.doesNotMatch(londonStationTopologyHTML({...topology, stationId: 'OTHER'}), /Platform 8 ·/);
});

test('Metropolitan groups never imply a specific numbered platform or a verified passenger direction', () => {
    const html = londonStationTopologyRouteHTML(topology, '8', '9');
    assert.match(html, /Metropolitan · MetWB group/);
    assert.match(html, /Metropolitan · MetEB group/);
    assert.match(html, /do not identify individual platforms 1–4/);
    assert.doesNotMatch(html, /Metropolitan · (westbound|eastbound)/);
    assert.match(html, /Approximate corridor geometry/);
    assert.match(html, /About \d+ min/);
});

test('every source path has valid directed endpoints, durations and continuous source levels', () => {
    const areas = new Map(topology.areas.map(area => [area.id, area]));
    for (const path of topology.paths) {
        assert.ok(areas.has(path.from) && areas.has(path.to));
        assert.ok(Number.isFinite(path.duration) && path.duration >= 0);
        assert.ok(path.parts.length);
        const first = path.parts[0].points[0];
        const lastPart = path.parts.at(-1);
        const last = lastPart.points.at(-1);
        assert.equal(first.areaId, path.from);
        assert.equal(last.areaId, path.to);
        assert.equal(first.level, areas.get(path.from).level);
        assert.equal(last.level, areas.get(path.to).level);
        for (let i = 1; i < path.parts.length; i++) {
            assert.equal(path.parts[i - 1].points.at(-1).areaId, path.parts[i].points[0].areaId);
            assert.equal(path.parts[i - 1].points.at(-1).level, path.parts[i].points[0].level);
        }
    }
});

test('all 88 selectable transfers match an independent all-pairs shortest-time calculation', () => {
    const ids = topology.areas.map(area => area.id);
    const times = new Map(ids.map(a => [a, new Map(ids.map(b => [b, a === b ? 0 : Infinity]))]));
    for (const path of topology.paths) times.get(path.from).set(path.to, Math.min(times.get(path.from).get(path.to), path.duration));
    for (const k of ids) for (const i of ids) for (const j of ids) {
        times.get(i).set(j, Math.min(times.get(i).get(j), times.get(i).get(k) + times.get(k).get(j)));
    }
    let checked = 0;
    for (const from of getPlatformAreas(topology)) {
        for (const to of [...getPlatformAreas(topology), ...getStreetAreas(topology)]) {
            if (from.id === to.id) continue;
            const route = findLondonStationPath(topology, from.id, to.id);
            assert.ok(route, `${from.name} to ${to.name}`);
            assert.equal(route.duration, times.get(from.id).get(to.id));
            assert.equal(route.paths.reduce((sum, path) => sum + path.duration, 0), route.duration);
            assert.ok(route.paths.every(path => topology.paths.includes(path)));
            checked++;
        }
    }
    assert.equal(checked, 88);
});

test('unknown endpoints and missing travel times cannot produce invented zero-minute shortcuts', () => {
    assert.equal(findLondonStationPath(topology, 'missing', 'missing'), null);
    const data = {areas: [{id: 'a'}, {id: 'b'}, {id: 'c'}], paths: [
        {from: 'a', to: 'missing', duration: 0}, {from: 'missing', to: 'b', duration: 0},
        {from: 'a', to: 'b', duration: null}, {from: 'a', to: 'b', duration: ''},
        {from: 'a', to: 'c', duration: 2}, {from: 'c', to: 'b', duration: 3}
    ]};
    assert.equal(findLondonStationPath(data, 'a', 'b').duration, 5);
});
