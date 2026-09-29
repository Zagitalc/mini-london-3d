import test from 'node:test';
import assert from 'node:assert/strict';

import {
    describeLondonStationFacilities,
    extractLondonStationFacilities,
    parseLondonFacilityValue
} from '../src/helpers/london-station-facilities.mjs';

const stopPoint = {
    id: '940GZZLUBNK',
    additionalProperties: [
        {category: 'Geo', key: 'Zone', value: '1'},
        {category: 'Facility', key: 'Lifts', value: '4'},
        {category: 'Facility', key: 'Toilets', value: 'yes'},
        {category: 'Facility', key: 'Car park', value: 'no'},
        {category: 'Facility', key: 'Escalators', value: '1'},
        {category: 'Facility', key: 'Wi-Fi', value: 'yes'},
        {category: 'Facility', key: 'Something new', value: 'yes'},
        {category: 'Facility', key: 'Cash Machines', value: 'yes'},
        {category: 'Facility', key: 'Euro Cash Machines', value: 'yes'},
        {category: 'Facility', key: 'Boarding Ramps', value: 'yes'},
        {category: 'Facility', key: 'WiFi', value: 'yes'},
        {category: 'Facility', key: 'Lifts', value: '9'},
        {category: 'Address', key: 'Address', value: 'Princes Street'},
        null
    ]
};

test('extractLondonStationFacilities keeps the zone and facility entries only', () => {
    const record = extractLondonStationFacilities(stopPoint);

    assert.equal(record.zone, '1');
    assert.deepEqual(record.facilities.map(f => f.key), [
        'Boarding Ramps', 'Car park', 'Cash Machines', 'Escalators', 'Euro Cash Machines',
        'Lifts', 'Something new', 'Toilets', 'Wi-Fi', 'WiFi'
    ]);
    assert.equal(record.facilities.find(f => f.key === 'Lifts').value, '4');
});

test('extractLondonStationFacilities returns null when TfL has nothing useful', () => {
    assert.equal(extractLondonStationFacilities({additionalProperties: []}), null);
    assert.equal(extractLondonStationFacilities(null), null);
});

test('describeLondonStationFacilities drops absent, unknown and duplicate facilities and shows counts', () => {
    const model = describeLondonStationFacilities(extractLondonStationFacilities(stopPoint));

    assert.equal(model.zone, 'Zone 1');
    assert.deepEqual(model.items, [
        {label: 'Boarding ramp', detail: null},
        {label: 'Cash machines', detail: null},
        {label: 'Escalators', detail: null},
        {label: 'Euro cash machines', detail: null},
        {label: 'Lifts', detail: '4'},
        {label: 'Toilets', detail: null},
        {label: 'Wi-Fi', detail: null}
    ]);
});

test('describeLondonStationFacilities formats boundary zones and handles empty input', () => {
    assert.equal(describeLondonStationFacilities({zone: '2+3', facilities: []}).zone, 'Zone 2/3');
    assert.equal(describeLondonStationFacilities({zone: null, facilities: [{key: 'Car park', value: 'no'}]}), null);
    assert.equal(describeLondonStationFacilities(undefined), null);
});

test('parseLondonFacilityValue handles the value styles TfL actually uses', () => {
    assert.equal(parseLondonFacilityValue('no'), null);
    assert.equal(parseLondonFacilityValue('none'), null);
    assert.equal(parseLondonFacilityValue('0'), null);
    assert.equal(parseLondonFacilityValue(''), null);
    assert.equal(parseLondonFacilityValue('Local authority facility nearby'), null);
    assert.equal(parseLondonFacilityValue('0 on platforms, 0 in ticket halls, 0 elsewhere'), null);
    assert.equal(parseLondonFacilityValue('0 in ticket halls, 0 on platforms'), null);

    assert.deepEqual(parseLondonFacilityValue('yes'), {count: null, qualifier: null});
    assert.deepEqual(parseLondonFacilityValue('3'), {count: 3, qualifier: null});
    assert.deepEqual(parseLondonFacilityValue('4 on platforms, 0 in ticket halls, 1 elsewhere'), {count: 5, qualifier: null});
    assert.deepEqual(parseLondonFacilityValue('10on platforms, 0 in ticket halls, 0 elsewhere'), {count: 10, qualifier: null});
    assert.equal(
        parseLondonFacilityValue('1lift from street level to ticket hall and 1 lift from ticket hall to westbound platform only.').count,
        2
    );
    assert.deepEqual(parseLondonFacilityValue('yes Piccadilly line only'), {count: null, qualifier: 'Piccadilly line only'});
    assert.deepEqual(parseLondonFacilityValue('yes (male, female)'), {count: null, qualifier: 'male, female'});
    assert.deepEqual(parseLondonFacilityValue('yes - male & female coin op'), {count: null, qualifier: 'male & female coin op'});
});

test('describeLondonStationFacilities keeps line restrictions on boarding ramps only', () => {
    const model = describeLondonStationFacilities({zone: '4', facilities: [
        {key: 'Boarding Ramps', value: 'yes Piccadilly line only'},
        {key: 'Help Points', value: '0 on platforms, 0 in ticket halls, 0 elsewhere'},
        {key: 'Toilets', value: 'yes (male, female, disabled/baby-changing facilities)'}
    ]});

    assert.deepEqual(model.items, [
        {label: 'Boarding ramp', detail: 'Piccadilly line only'},
        {label: 'Toilets', detail: null}
    ]);
});
