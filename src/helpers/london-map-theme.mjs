// Light and dark base map for London. The light theme keeps the Mapbox style's
// own colours; the dark theme repaints the same layers in place, so the
// London layers added on top are never rebuilt. Kept free of Mapbox objects
// so it can be unit-tested.

// Matches the dark UI surfaces (--london-bg #061125, cards rgba(10, 20, 46)).
export const LONDON_DARK_BASE = {
    ground: '#0c1629',
    land: '#0f1a30',
    green: '#0f2327',
    water: '#0a2141',
    building: '#131e35',
    buildingOutline: '#1a2640',
    building3d: '#18243f',
    road: '#1c2842',
    roadMajor: '#243150',
    casing: '#0c1629',
    path: '#16213a',
    rail: '#2b3754',
    boundary: '#34446a',
    label: '#8d9ab5',
    halo: '#0c1629',
    sky: 'hsl(222, 45%, 12%)'
};

// Minimum contrast for a tube line against the dark ground (WCAG non-text contrast).
const MIN_LINE_CONTRAST = 3;
// Near-black lines (the Northern) become near-white, as in TfL's own dark
// maps; lifting them to mid-grey would clash with the Jubilee line.
const DARK_NEUTRAL_LINE = '#e3e7ee';

const GREEN_CLASSES = [
    'park', 'grass', 'wood', 'scrub', 'cemetery', 'pitch', 'golf_course',
    'garden', 'playground', 'national_park', 'agriculture'
];
const MAJOR_ROAD = /motorway|trunk|primary|secondary/;
const PATH_ROAD = /path|pedestrian|steps|footway|cycleway|track/;
const RAIL_ROAD = /rail|transit/;

/**
 * Works out what a base-map layer draws, from its type, source-layer and id.
 * Only layers from the Mapbox "composite" source (plus background and sky)
 * are touched, so the London overlays keep their own colours.
 * @param {Object} layer - A style layer, as in map.getStyle().layers.
 * @returns {string|null} The role, or null to leave the layer alone.
 */
export function classifyLondonBaseLayer(layer) {
    if (!layer || typeof layer.id !== 'string') {
        return null;
    }
    if (layer.type === 'background') return 'ground';
    if (layer.type === 'sky') return 'sky';
    if (layer.source !== 'composite') return null;

    const sourceLayer = layer['source-layer'] || '';
    const id = layer.id;

    if (layer.type === 'symbol') return 'label';
    if (sourceLayer === 'water' || sourceLayer === 'waterway') return 'water';
    if (sourceLayer === 'building') {
        return layer.type === 'fill-extrusion' ? 'building3d' : layer.type === 'fill' ? 'building' : null;
    }
    if (sourceLayer === 'admin') return layer.type === 'line' ? 'boundary' : null;
    if (sourceLayer === 'landcover' || sourceLayer === 'national_park') return layer.type === 'fill' ? 'green' : null;
    if (sourceLayer === 'landuse' || sourceLayer === 'landuse_overlay') return layer.type === 'fill' ? 'landuse' : null;
    if (sourceLayer === 'hillshade') return layer.type === 'fill' ? 'hillshade' : null;
    if (sourceLayer === 'road' || sourceLayer === 'structure' || sourceLayer === 'aeroway') {
        if (layer.type === 'fill') return 'land';
        if (layer.type !== 'line') return null;
        if (sourceLayer === 'structure') return 'land';
        if (/case|casing|outline/.test(id)) return 'casing';
        if (RAIL_ROAD.test(id)) return 'rail';
        if (PATH_ROAD.test(id)) return 'path';
        return MAJOR_ROAD.test(id) ? 'roadMajor' : 'road';
    }
    return null;
}

/**
 * The dark-theme paint values for one layer.
 * @param {Object} layer - A style layer.
 * @param {Object} [colours] - Palette; defaults to LONDON_DARK_BASE.
 * @returns {Object|null} Paint property to value, or null to leave the layer alone.
 */
export function londonDarkBasePaint(layer, colours = LONDON_DARK_BASE) {
    const c = colours;

    switch (classifyLondonBaseLayer(layer)) {
    case 'ground': return {'background-color': c.ground};
    case 'sky': return {'sky-atmosphere-color': c.sky};
    case 'label': return {'text-color': c.label, 'text-halo-color': c.halo};
    case 'water': return layer.type === 'line' ? {'line-color': c.water} : layer.type === 'fill' ? {'fill-color': c.water} : null;
    case 'building': return {'fill-color': c.building, 'fill-outline-color': c.buildingOutline};
    case 'building3d': return {'fill-extrusion-color': c.building3d};
    case 'boundary': return {'line-color': c.boundary};
    case 'green': return {'fill-color': c.green};
    case 'landuse': return {'fill-color': ['match', ['get', 'class'], GREEN_CLASSES, c.green, c.land]};
    case 'hillshade': return {'fill-color': c.ground};
    case 'land': return {'fill-color': c.land};
    case 'casing': return {'line-color': c.casing};
    case 'rail': return {'line-color': c.rail};
    case 'path': return {'line-color': c.path};
    case 'roadMajor': return {'line-color': c.roadMajor};
    case 'road': return {'line-color': c.road};
    default: return null;
    }
}

/**
 * Lists the paint changes that bring the base map into a theme.
 * The first time a layer is seen, its current (light) values are recorded in
 * `originals`, so the light theme can be restored exactly.
 * @param {Array<Object>} layers - map.getStyle().layers.
 * @param {string} theme - 'dark' or 'light'.
 * @param {Map} originals - Layer id to recorded light paint values; updated in place.
 * @returns {Array<Array>} [layerId, property, value] triples for setPaintProperty.
 */
export function londonBaseMapPaintUpdates(layers, theme, originals) {
    const updates = [];

    for (const layer of layers || []) {
        const dark = londonDarkBasePaint(layer);
        if (!dark) continue;

        if (!originals.has(layer.id)) {
            const paint = layer.paint || {};
            originals.set(layer.id, Object.fromEntries(Object.keys(dark).map(property => [property, paint[property]])));
        }
        const values = theme === 'dark' ? dark : originals.get(layer.id);
        for (const [property, value] of Object.entries(values)) {
            updates.push([layer.id, property, value]);
        }
    }
    return updates;
}

const EMISSIVE_PROPERTY = {
    background: 'background-emissive-strength',
    fill: 'fill-emissive-strength',
    line: 'line-emissive-strength',
    circle: 'circle-emissive-strength'
};

/**
 * Makes flat layers ignore the scene lighting, so they show their palette
 * colours exactly in both themes. 3D buildings stay lit.
 * @param {Array<Object>} layers - map.getStyle().layers.
 * @param {Array<string>} [overlayIds] - London layers (tube lines, stations) to include.
 * @returns {Array<Array>} [layerId, property, 1] triples for setPaintProperty.
 */
export function londonEmissiveUpdates(layers, overlayIds = []) {
    const overlays = new Set(overlayIds);
    const updates = [];

    for (const layer of layers || []) {
        if (!layer || !(overlays.has(layer.id) || londonDarkBasePaint(layer))) continue;
        if (layer.type === 'symbol') {
            updates.push([layer.id, 'text-emissive-strength', 1], [layer.id, 'icon-emissive-strength', 1]);
        } else if (EMISSIVE_PROPERTY[layer.type]) {
            updates.push([layer.id, EMISSIVE_PROPERTY[layer.type], 1]);
        }
    }
    return updates;
}

/**
 * The moment whose sunlight the London scene uses: midday for the light
 * theme, the middle of the night for the dark one, on the same UTC date.
 * The theme, not the clock, decides whether it looks like day or night.
 * @param {string} theme - 'dark' or 'light'.
 * @param {number} now - Unix time in milliseconds.
 * @returns {number} Unix time in milliseconds.
 */
export function londonLightingTime(theme, now) {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), theme === 'dark' ? 0 : 12, 30);
}

function parseHex(hex) {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!match) return null;
    const digits = match[1].length === 3 ? match[1].replace(/./g, d => d + d) : match[1];
    return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16) / 255);
}

function toHex(rgb) {
    return `#${rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(rgb) {
    const [r, g, b] = rgb.map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two colours.
 * @param {string} a - Hex colour.
 * @param {string} b - Hex colour.
 * @returns {number} Ratio from 1 to 21.
 */
export function contrastRatio(a, b) {
    const [high, low] = [luminance(parseHex(a)), luminance(parseHex(b))].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
}

function rgbToHsl([r, g, b]) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const channel = t => {
        const x = (t + 1) % 1;
        return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
    };
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

/**
 * A line colour that stays readable on the dark ground: unchanged if it
 * already has enough contrast, otherwise lightened with the same hue.
 * @param {string} colour - Hex line colour.
 * @param {string} [ground] - Hex background colour.
 * @returns {string} Hex colour for the dark theme.
 */
export function londonDarkLineColour(colour, ground = LONDON_DARK_BASE.ground) {
    const rgb = parseHex(colour);
    if (!rgb) return colour;
    if (contrastRatio(colour, ground) >= MIN_LINE_CONTRAST) return colour;

    const [h, s, l] = rgbToHsl(rgb);
    if (s < 0.1 && l < 0.25) return DARK_NEUTRAL_LINE;

    let lightness = l;
    let candidate = colour;
    while (lightness < 0.9 && contrastRatio(candidate, ground) < MIN_LINE_CONTRAST) {
        lightness += 0.02;
        candidate = toHex(hslToRgb([h, s, lightness]));
    }
    return candidate;
}

/**
 * The line-color expression for the London railway layers.
 * @param {Array<Object>} lines - Line catalog entries with lineId and color.
 * @param {string} theme - 'dark' or 'light'.
 * @returns {Array|string} A Mapbox expression.
 */
export function londonRailLineColourExpression(lines, theme) {
    const colour = ['get', 'color'];
    if (theme !== 'dark') return colour;

    const pairs = [];
    for (const line of lines || []) {
        const dark = line && line.lineId ? londonDarkLineColour(line.color) : null;
        if (dark && dark.toLowerCase() !== String(line.color).toLowerCase()) {
            pairs.push(line.lineId, dark);
        }
    }
    return pairs.length ? ['match', ['get', 'lineId'], ...pairs, colour] : colour;
}
