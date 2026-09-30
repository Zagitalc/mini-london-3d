import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LONDON_DARK_BASE,
    classifyLondonBaseLayer,
    contrastRatio,
    londonBaseMapPaintUpdates,
    londonDarkLineColour,
    londonEmissiveUpdates,
    londonLightingTime,
    londonRailLineColourExpression
} from '../src/helpers/london-map-theme.mjs';

const composite = (id, type, sourceLayer, paint = {}) => ({id, type, source: 'composite', 'source-layer': sourceLayer, paint});

// Layer ids and source-layers as in Mapbox light-v11 (Streets v8 tiles).
const STYLE_LAYERS = [
    {id: 'land', type: 'background', paint: {'background-color': 'hsl(20, 20%, 95%)'}},
    composite('landcover', 'fill', 'landcover', {'fill-color': 'hsl(75, 25%, 88%)'}),
    composite('landuse', 'fill', 'landuse', {'fill-color': ['match', ['get', 'class'], 'park', 'hsl(110, 30%, 85%)', 'hsl(20, 20%, 95%)']}),
    composite('water', 'fill', 'water', {'fill-color': 'hsl(196, 60%, 85%)'}),
    composite('waterway', 'line', 'waterway', {'line-color': 'hsl(196, 60%, 85%)'}),
    composite('road-primary-case', 'line', 'road'),
    composite('road-primary', 'line', 'road', {'line-color': 'white'}),
    composite('tunnel-street-minor', 'line', 'road'),
    composite('road-path', 'line', 'road'),
    composite('road-rail', 'line', 'road'),
    composite('road-pedestrian-polygon', 'fill', 'road'),
    composite('building', 'fill', 'building'),
    {id: 'london-3d-buildings', type: 'fill-extrusion', source: 'composite', 'source-layer': 'building', paint: {'fill-extrusion-color': '#f7f8fa'}},
    composite('admin-0-boundary', 'line', 'admin'),
    composite('road-label', 'symbol', 'road'),
    {id: 'sky', type: 'sky', paint: {}},
    {id: 'london-railways', type: 'line', source: 'london-rail', paint: {'line-color': ['get', 'color']}},
    {id: 'london-stations', type: 'circle', source: 'london-rail', paint: {}}
];

test('classifyLondonBaseLayer recognises light-v11 layers and leaves the London overlays alone', () => {
    assert.deepEqual(STYLE_LAYERS.map(layer => [layer.id, classifyLondonBaseLayer(layer)]), [
        ['land', 'ground'],
        ['landcover', 'green'],
        ['landuse', 'landuse'],
        ['water', 'water'],
        ['waterway', 'water'],
        ['road-primary-case', 'casing'],
        ['road-primary', 'roadMajor'],
        ['tunnel-street-minor', 'road'],
        ['road-path', 'path'],
        ['road-rail', 'rail'],
        ['road-pedestrian-polygon', 'land'],
        ['building', 'building'],
        ['london-3d-buildings', 'building3d'],
        ['admin-0-boundary', 'boundary'],
        ['road-label', 'label'],
        ['sky', 'sky'],
        ['london-railways', null],
        ['london-stations', null]
    ]);
    assert.equal(classifyLondonBaseLayer(null), null);
    assert.equal(classifyLondonBaseLayer(composite('hillshade', 'fill', 'hillshade')), 'hillshade');
});

test('londonBaseMapPaintUpdates switches to the dark palette and restores the original light values', () => {
    const originals = new Map();
    const dark = new Map(londonBaseMapPaintUpdates(STYLE_LAYERS, 'dark', originals).map(([id, property, value]) => [`${id}|${property}`, value]));

    assert.equal(dark.get('land|background-color'), LONDON_DARK_BASE.ground);
    assert.equal(dark.get('water|fill-color'), LONDON_DARK_BASE.water);
    assert.equal(dark.get('road-primary|line-color'), LONDON_DARK_BASE.roadMajor);
    assert.equal(dark.get('london-3d-buildings|fill-extrusion-color'), LONDON_DARK_BASE.building3d);
    assert.equal(dark.get('road-label|text-halo-color'), LONDON_DARK_BASE.halo);
    assert.deepEqual(dark.get('landuse|fill-color').slice(0, 2), ['match', ['get', 'class']]);
    assert.ok(![...dark.keys()].some(key => key.startsWith('london-railways') || key.startsWith('london-stations')));

    // Once dark values are live, getStyle() reports them; the recorded originals must win.
    const darkened = STYLE_LAYERS.map(layer => ({...layer, paint: {...layer.paint, 'background-color': '#000'}}));
    const light = new Map(londonBaseMapPaintUpdates(darkened, 'light', originals).map(([id, property, value]) => [`${id}|${property}`, value]));
    assert.equal(light.get('land|background-color'), 'hsl(20, 20%, 95%)');
    assert.equal(light.get('london-3d-buildings|fill-extrusion-color'), '#f7f8fa');
    assert.equal(light.get('road-primary-case|line-color'), undefined);
    assert.ok(light.has('road-primary-case|line-color'), 'unset values are restored as defaults');
});

test('londonEmissiveUpdates covers flat base layers and the named overlays but not 3D buildings', () => {
    const updates = londonEmissiveUpdates(STYLE_LAYERS, ['london-railways', 'london-stations']);
    const keys = updates.map(([id, property]) => `${id}|${property}`);

    assert.ok(keys.includes('land|background-emissive-strength'));
    assert.ok(keys.includes('water|fill-emissive-strength'));
    assert.ok(keys.includes('road-label|text-emissive-strength'));
    assert.ok(keys.includes('london-railways|line-emissive-strength'));
    assert.ok(keys.includes('london-stations|circle-emissive-strength'));
    assert.ok(!keys.some(key => key.startsWith('london-3d-buildings') || key.startsWith('sky')));
    assert.ok(updates.every(([, , value]) => value === 1));
});

test('londonDarkLineColour keeps readable colours and lifts dark ones', () => {
    for (const colour of ['#B36305', '#E32017', '#FFD300', '#00782A', '#A0A5A9', '#0098D4']) {
        assert.equal(londonDarkLineColour(colour), colour);
    }
    assert.equal(londonDarkLineColour('#000000'), '#e3e7ee');
    for (const colour of ['#003688', '#9B0056']) {
        const lifted = londonDarkLineColour(colour);
        assert.notEqual(lifted, colour);
        assert.ok(contrastRatio(lifted, LONDON_DARK_BASE.ground) >= 3, `${colour} -> ${lifted}`);
    }
    assert.equal(londonDarkLineColour('not-a-colour'), 'not-a-colour');
    assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 1e-9);
});

test('londonRailLineColourExpression only overrides lines that need it, and only in dark mode', () => {
    const lines = [
        {lineId: 'northern', color: '#000000'},
        {lineId: 'victoria', color: '#0098D4'},
        {lineId: 'piccadilly', color: '#003688'}
    ];

    assert.deepEqual(londonRailLineColourExpression(lines, 'light'), ['get', 'color']);
    const dark = londonRailLineColourExpression(lines, 'dark');
    assert.deepEqual(dark.slice(0, 4), ['match', ['get', 'lineId'], 'northern', '#e3e7ee']);
    assert.equal(dark[4], 'piccadilly');
    assert.deepEqual(dark[dark.length - 1], ['get', 'color']);
    assert.ok(!dark.includes('victoria'));
    assert.deepEqual(londonRailLineColourExpression([{lineId: 'victoria', color: '#0098D4'}], 'dark'), ['get', 'color']);
});

test('londonLightingTime picks midday for light and the small hours for dark on the same date', () => {
    const now = Date.parse('2026-12-21T17:45:00Z');

    assert.equal(new Date(londonLightingTime('light', now)).toISOString(), '2026-12-21T12:30:00.000Z');
    assert.equal(new Date(londonLightingTime('dark', now)).toISOString(), '2026-12-21T00:30:00.000Z');
});
