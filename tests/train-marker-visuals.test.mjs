import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_CAR_DIMENSIONS,
    getCarGeometryArguments,
    getLondonTrainScaleFactor,
    LONDON_TRAIN_DIMENSIONS,
    LONDON_TRAIN_SCALE_PROFILE,
    resolveCarDimensions,
    resolveCarModelScales,
    TRAIN_MARKER_AXES
} from '../src/helpers/train-marker-visuals.mjs';

test('train marker axes document lateral, longitudinal, and vertical dimensions', () => {
    assert.deepEqual(TRAIN_MARKER_AXES, {
        width: 'x-lateral',
        height: 'y-longitudinal',
        depth: 'z-vertical'
    });
});

test('car marker defaults preserve the existing Tokyo dimensions', () => {
    assert.deepEqual(resolveCarDimensions(), {
        width: 0.88,
        height: 1.76,
        depth: 0.88
    });
    assert.deepEqual(DEFAULT_CAR_DIMENSIONS, resolveCarDimensions({}));
});

test('London marker dimensions have a four-to-one longitudinal aspect ratio', () => {
    assert.equal(LONDON_TRAIN_DIMENSIONS.height / LONDON_TRAIN_DIMENSIONS.width, 4);
    assert.deepEqual(getCarGeometryArguments(LONDON_TRAIN_DIMENSIONS), [0.32, 1.28, 0.28]);
});

test('invalid dimension overrides fall back per axis without changing valid axes', () => {
    assert.deepEqual(resolveCarDimensions({width: 0.4, height: 0, depth: NaN}), {
        width: 0.4,
        height: 1.76,
        depth: 0.88
    });
});

test('delay-marker scale follows car scale by default and can be independent', () => {
    assert.deepEqual(resolveCarModelScales({modelScale: 2}), {
        modelScale: 2,
        delayMarkerModelScale: 2,
        independentDelayMarkerScale: false
    });
    assert.deepEqual(resolveCarModelScales({modelScale: 2, delayMarkerModelScale: 5}), {
        modelScale: 2,
        delayMarkerModelScale: 5,
        independentDelayMarkerScale: true
    });
});

test('London trains remain readable from street zoom through maximum zoom', () => {
    assert.equal(getLondonTrainScaleFactor(9), 0.20);
    assert.equal(getLondonTrainScaleFactor(14), 0.80);
    assert.equal(getLondonTrainScaleFactor(15.5), 0.78);
    const close = LONDON_TRAIN_SCALE_PROFILE.filter(([zoom]) => zoom >= 16);
    for (let i = 1; i < close.length; i++) assert.ok(close[i][1] >= close[i - 1][1]);
    // Pixel footprint includes the shared shader clamp and map's 2^zoom scale.
    const pixels = zoom => getLondonTrainScaleFactor(zoom) * 2 ** (zoom - Math.min(19, zoom));
    for (const zoom of [19, 19.5, 20, 21, 22]) assert.ok(Math.abs(pixels(zoom) - 0.95) < 1e-12);
});
