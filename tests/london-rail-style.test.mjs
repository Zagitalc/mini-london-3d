import test from 'node:test';
import assert from 'node:assert/strict';
import {LONDON_RAIL_WIDTH_PROFILE, londonRailSizeExpressions} from '../src/helpers/london-rail-style.mjs';
import {getZoomProfileValue} from '../src/helpers/train-marker-visuals.mjs';

test('street and maximum zoom retain readable lines and separate adjacent lanes', () => {
    const {lineWidth, lineOffset} = londonRailSizeExpressions();
    for (const zoom of [16, 16.5, 17, 18, 19, 20, 21, 22]) {
        const width = getZoomProfileValue(zoom, LONDON_RAIL_WIDTH_PROFILE);
        assert.ok(width >= 4.5 && width <= 5.5);
    }
    for (let i = 3; i < lineWidth.length; i += 2) {
        assert.equal(lineWidth[i], lineOffset[i]);
        assert.equal(lineOffset[i + 1][2], lineWidth[i + 1] + 2);
    }
    assert.equal(lineWidth.at(-1), 5.5);
    assert.equal(lineOffset.at(-1)[2], 7.5);
});
