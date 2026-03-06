import test from 'node:test';
import assert from 'node:assert/strict';

import { applyLondonStationGroups, buildLondonStationGroupIdLookup } from '../src/helpers/london-stations.mjs';

test('buildLondonStationGroupIdLookup maps every station in a group to the primary station id', () => {
    const lookup = buildLondonStationGroupIdLookup([
        [[
            'tfl.bakerloo.940GZZLUBST',
            'tfl.circle.940GZZLUBST',
            'tfl.jubilee.940GZZLUBST'
        ]]
    ]);

    assert.equal(lookup.get('tfl.bakerloo.940GZZLUBST'), 'tfl.bakerloo.940GZZLUBST');
    assert.equal(lookup.get('tfl.circle.940GZZLUBST'), 'tfl.bakerloo.940GZZLUBST');
    assert.equal(lookup.get('tfl.jubilee.940GZZLUBST'), 'tfl.bakerloo.940GZZLUBST');
});

test('applyLondonStationGroups assigns a shared rendered group id across lines', () => {
    const stations = [
        { id: 'tfl.bakerloo.940GZZLUOXC', altitude: 0 },
        { id: 'tfl.central.940GZZLUOXC', altitude: 0 },
        { id: 'tfl.victoria.940GZZLUOXC', altitude: -10 }
    ];

    applyLondonStationGroups(stations, [
        [[
            'tfl.bakerloo.940GZZLUOXC',
            'tfl.central.940GZZLUOXC',
            'tfl.victoria.940GZZLUOXC'
        ]]
    ]);

    assert.equal(stations[0].group, 'tfl.bakerloo.940GZZLUOXC.og');
    assert.equal(stations[1].group, 'tfl.bakerloo.940GZZLUOXC.og');
    assert.equal(stations[2].group, 'tfl.bakerloo.940GZZLUOXC.ug');
});
