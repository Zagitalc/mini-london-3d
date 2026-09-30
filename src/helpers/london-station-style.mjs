// Screen-space sizing for London stations. Dots and interchange pills share
// one zoom scale: it matches the old look at zoom 14, shrinks when zoomed
// out and levels off when zoomed in, so stations never balloon across streets
// or vanish. Kept free of Mapbox objects so it can be unit-tested.

// Multiplier on the zoom-14 sizes below.
export const LONDON_STATION_SCALE = [
    [9, 0.15],
    [10, 0.25],
    [11, 0.4],
    [12, 0.62],
    [13, 0.82],
    [14, 1],
    [15, 1.15],
    [16, 1.3],
    [17, 1.4]
];

// Sizes at zoom 14, in CSS pixels.
const DOT_RADIUS = 5.5;
const DOT_STROKE = 1.8;
const PILL_HEIGHT = 14;
const PILL_LENGTH_PER_LINE = 10;
const PILL_STROKE = 2;
const LINK_WIDTH = 5;
const LINK_CASING = 1.6;
// Icons are drawn at this density so they stay sharp when scaled up.
export const LONDON_PILL_PIXEL_RATIO = 3;
export const LONDON_PILL_MAX_LINES = 6;

function scaled(base, minimum = 0) {
    return ['interpolate', ['linear'], ['zoom'], ...LONDON_STATION_SCALE.flatMap(([zoom, k]) => [zoom, Math.max(minimum, +(base * k).toFixed(3))])];
}

/**
 * Zoom expressions for station sizes.
 * @returns {Object} Dot radius and stroke width, pill icon size and connector widths, as Mapbox expressions.
 */
export function londonStationSizeExpressions() {
    return {
        dotRadius: scaled(DOT_RADIUS),
        dotStrokeWidth: scaled(DOT_STROKE, 0.4),
        pillIconSize: scaled(1),
        // Connectors between platform points of one station.
        linkWidth: scaled(LINK_WIDTH, 1),
        linkCasingWidth: scaled(LINK_WIDTH + 2 * LINK_CASING, 2)
    };
}

/**
 * The icon name for an interchange with a given number of lines.
 * @param {number} lineCount - Lines at the station.
 * @returns {string} Image id, e.g. "london-station-pill-3".
 */
export function londonPillImageId(lineCount) {
    const count = Math.min(LONDON_PILL_MAX_LINES, Math.max(2, Math.round(Number(lineCount)) || 2));
    return `london-station-pill-${count}`;
}

/**
 * The same choice as londonPillImageId, as a Mapbox expression.
 * @returns {Array} A Mapbox expression reading the feature's lineCount.
 */
export function londonPillImageExpression() {
    return ['concat', 'london-station-pill-', ['to-string', ['min', LONDON_PILL_MAX_LINES, ['max', 2, ['coalesce', ['get', 'lineCount'], 2]]]]];
}

/**
 * Draws a white capsule with a dark outline, lying east-west, as RGBA pixels
 * for map.addImage. Rotate it with icon-rotate = bearing - 90.
 * @param {number} lineCount - Lines at the station; longer pills for more lines.
 * @param {number} [pixelRatio] - Image pixels per CSS pixel.
 * @returns {Object} {width, height, data} with data as a Uint8Array.
 */
export function drawLondonPillImage(lineCount, pixelRatio = LONDON_PILL_PIXEL_RATIO) {
    const count = Math.min(LONDON_PILL_MAX_LINES, Math.max(2, Math.round(Number(lineCount)) || 2));
    const height = Math.ceil(PILL_HEIGHT * pixelRatio);
    const width = Math.ceil((PILL_HEIGHT + (count - 1) * PILL_LENGTH_PER_LINE) * pixelRatio);
    const radius = height / 2;
    const stroke = PILL_STROKE * pixelRatio;
    const data = new Uint8Array(width * height * 4);
    const coverage = d => Math.min(1, Math.max(0, 0.5 - d));

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const px = x + 0.5, py = y + 0.5;
            const cx = Math.min(Math.max(px, radius), width - radius);
            // Signed distance to the capsule edge: negative inside.
            const d = Math.hypot(px - cx, py - radius) - radius;
            const outer = coverage(d);
            if (!outer) continue;
            // 1 in the white fill, 0 in the outline ring.
            const fill = coverage(d + stroke);
            const shade = Math.round(255 * fill);
            const i = (y * width + x) * 4;
            // Straight (not premultiplied) alpha; Mapbox premultiplies on upload.
            data[i] = data[i + 1] = data[i + 2] = shade;
            data[i + 3] = Math.round(255 * outer);
        }
    }
    return {width, height, data};
}
