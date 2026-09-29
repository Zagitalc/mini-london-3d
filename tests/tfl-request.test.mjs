import test from 'node:test';
import assert from 'node:assert/strict';

import {buildTflRequestUrls, isTflApiBase} from '../src/helpers/tfl-request.mjs';
import {normalizeLondonStationName, extractLondonClosurePairs} from '../src/helpers/london-closures.mjs';
import {parseLondonFacilityValue} from '../src/helpers/london-station-facilities.mjs';
import {stripLondonDirectionSuffix} from '../src/helpers/london-stations.mjs';

test('isTflApiBase compares the parsed host, not a substring', () => {
    assert.equal(isTflApiBase('https://api.tfl.gov.uk'), true);
    assert.equal(isTflApiBase('https://api.tfl.gov.uk/'), true);
    assert.equal(isTflApiBase('https://api.tfl.gov.uk.evil.example'), false);
    assert.equal(isTflApiBase('https://evil.example/?api.tfl.gov.uk'), false);
    assert.equal(isTflApiBase('/tfl'), false);
});

test('buildTflRequestUrls tries the proxy first and only ever sends the key to TfL', () => {
    const urls = buildTflRequestUrls({path: '/Line/victoria/Arrivals', proxyBases: ['/tfl/'], appKey: 'secret'});

    assert.deepEqual(urls, ['/tfl/Line/victoria/Arrivals', 'https://api.tfl.gov.uk/Line/victoria/Arrivals?app_key=secret']);
});

test('buildTflRequestUrls keeps fixed query parameters and drops TfL-looking proxies', () => {
    const urls = buildTflRequestUrls({
        path: '/Line/jubilee/Status/2026-10-03/to/2026-10-05?detail=true',
        proxyBases: ['/tfl', 'https://api.tfl.gov.uk', '']
    });

    assert.deepEqual(urls, [
        '/tfl/Line/jubilee/Status/2026-10-03/to/2026-10-05?detail=true',
        'https://api.tfl.gov.uk/Line/jubilee/Status/2026-10-03/to/2026-10-05?detail=true'
    ]);
    assert.deepEqual(buildTflRequestUrls({path: '/Line/victoria/Arrivals'}), ['https://api.tfl.gov.uk/Line/victoria/Arrivals']);
});

test('stripLondonDirectionSuffix removes the direction in parentheses', () => {
    assert.equal(stripLondonDirectionSuffix('Bakerloo (inbound)'), 'Bakerloo');
    assert.equal(stripLondonDirectionSuffix('  Central (Outbound)  '), 'Central');
    assert.equal(stripLondonDirectionSuffix('Towards Ealing Broadway'), 'Towards Ealing Broadway');
    assert.equal(stripLondonDirectionSuffix(null), '');
});

// Inputs shaped to make backtracking regexes take quadratic time or worse.
// Each parser must finish well within a generous budget.
function assertFast(label, fn) {
    const started = process.hrtime.bigint();
    fn();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 250, `${label} took ${ms.toFixed(1)} ms`);
}

test('text parsers stay fast on hostile input', () => {
    const spaces = ' '.repeat(50000);

    assertFast('stripLondonDirectionSuffix', () => stripLondonDirectionSuffix(`a${spaces}b`));
    assertFast('normalizeLondonStationName', () => normalizeLondonStationName(`underground${spaces}x`));
    assertFast('extractLondonClosurePairs', () => extractLondonClosurePairs(`between${spaces}and${spaces}`.repeat(3), new Map()));
    assertFast('parseLondonFacilityValue', () => parseLondonFacilityValue(`yes${' ('.repeat(20000)}x${')'.repeat(20000)}`));
});
