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
    assert.doesNotMatch(unknown, /Invalid Date|datetime=/);
});
