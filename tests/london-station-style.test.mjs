import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LONDON_PILL_MAX_LINES,
    LONDON_PILL_PIXEL_RATIO,
    LONDON_STATION_SCALE,
    drawLondonPillImage,
    londonPillImageExpression,
    londonPillImageId,
    londonStationSizeExpressions
} from '../src/helpers/london-station-style.mjs';

const stops = expression => {
    assert.deepEqual(expression.slice(0, 3), ['interpolate', ['linear'], ['zoom']]);
    const pairs = [];
    for (let i = 3; i < expression.length; i += 2) pairs.push([expression[i], expression[i + 1]]);
    return pairs;
};

test('station sizes grow when zooming in, then level off instead of ballooning', () => {
    const {dotRadius, dotStrokeWidth, pillIconSize} = londonStationSizeExpressions();

    for (const expression of [dotRadius, dotStrokeWidth, pillIconSize]) {
        const values = stops(expression).map(([, value]) => value);
        for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1], 'never shrinks as you zoom in');
        // Mapbox holds the last stop's value for every zoom above it.
        assert.equal(stops(expression).at(-1)[0], LONDON_STATION_SCALE.at(-1)[0]);
        assert.ok(values.at(-1) / values[stops(expression).findIndex(([zoom]) => zoom === 14)] <= 1.5, 'at most 1.5x the zoom-14 size');
    }
    assert.deepEqual(stops(pillIconSize).find(([zoom]) => zoom === 14), [14, 1]);
    assert.ok(stops(dotStrokeWidth).every(([, width]) => width >= 0.4), 'outlines stay visible when zoomed out');
});

test('londonPillImageId clamps the line count to the icons that exist', () => {
    assert.equal(londonPillImageId(3), 'london-station-pill-3');
    assert.equal(londonPillImageId(1), 'london-station-pill-2');
    assert.equal(londonPillImageId(9), `london-station-pill-${LONDON_PILL_MAX_LINES}`);
    assert.equal(londonPillImageId(undefined), 'london-station-pill-2');
    assert.deepEqual(londonPillImageExpression().slice(0, 2), ['concat', 'london-station-pill-']);
});

test('drawLondonPillImage draws a white capsule with a dark outline and transparent corners', () => {
    const two = drawLondonPillImage(2);
    const five = drawLondonPillImage(5);
    const pixel = (image, x, y) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));

    assert.equal(two.height, five.height);
    assert.ok(five.width > two.width, 'more lines, longer pill');
    assert.ok(two.width > two.height, 'lies east-west');
    assert.equal(two.data.length, two.width * two.height * 4);
    assert.equal(two.height % LONDON_PILL_PIXEL_RATIO, 0);

    const midY = Math.floor(two.height / 2);
    assert.deepEqual(pixel(two, Math.floor(two.width / 2), midY), [255, 255, 255, 255], 'white centre');
    assert.deepEqual(pixel(two, 0, 0), [0, 0, 0, 0], 'transparent corner');
    const edge = pixel(two, Math.floor(two.width / 2), 1);
    assert.ok(edge[0] < 60 && edge[3] > 200, `dark opaque outline at the top edge, got ${edge}`);
});
