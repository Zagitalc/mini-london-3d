import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import test from 'node:test';
import {
    findLondonStationPath,
    getPlatformAreas,
    getStreetAreas,
    londonStationTopologyHTML,
    londonStationTopologyRouteHTML
} from '../src/helpers/london-station-topology.mjs';

const topology = JSON.parse(gunzipSync(readFileSync(new URL('../assets/london-build-data/station-topology.json.gz', import.meta.url))));

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
    const html = londonStationTopologyHTML(topology, {from: '6', to: '10'});

    assert.match(html, /Starting platform/);
    assert.match(html, /Destination platform or street access/);
    assert.match(html, /Street access · A-M-N/);
    assert.match(html, /Street links are unnamed in TfL’s source/);
    assert.match(html, /value="6" selected/);
    assert.match(html, /value="10" selected/);
});
