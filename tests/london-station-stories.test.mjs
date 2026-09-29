import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';

import {
    LONDON_STORY_MAX_LENGTH,
    describeLondonStationStories,
    validateLondonStationStories
} from '../src/helpers/london-station-stories.mjs';

const story = {
    text: 'Opened in 1863.',
    source: {title: 'Wikipedia: Baker Street tube station', url: 'https://en.wikipedia.org/wiki/Baker_Street_tube_station'},
    checked: '2026-09-29'
};
const known = new Map([['940GZZLUBST', 'Baker Street']]);

test('a well-formed story passes validation', () => {
    assert.deepEqual(validateLondonStationStories({stations: {'940GZZLUBST': {name: 'Baker Street', stories: [story]}}}, known), []);
});

test('validation rejects stories without a proper source or check date', () => {
    const cases = [
        [{...story, source: undefined}, /source needs a title/],
        [{...story, source: {title: 'x', url: 'http://example.com'}}, /https URL/],
        [{...story, source: {title: 'x', url: 'not a url'}}, /https URL/],
        [{...story, checked: undefined}, /"checked"/],
        [{...story, checked: '2026-02-30'}, /"checked"/],
        [{...story, text: ' '}, /text is empty/],
        [{...story, text: 'x'.repeat(LONDON_STORY_MAX_LENGTH + 1)}, /characters/]
    ];

    for (const [bad, pattern] of cases) {
        const errors = validateLondonStationStories({stations: {'940GZZLUBST': {name: 'Baker Street', stories: [bad]}}}, known);
        assert.match(errors.join('\n'), pattern);
    }
});

test('validation catches unknown IDs, wrong names and empty entries', () => {
    const errors = validateLondonStationStories({
        stations: {
            '940GZZLUXXX': {name: 'Nowhere', stories: [story]},
            '940GZZLUBST': {name: 'Bakers Street', stories: []}
        }
    }, known).join('\n');

    assert.match(errors, /940GZZLUXXX.*not a station/);
    assert.match(errors, /name should be "Baker Street"/);
    assert.match(errors, /needs at least one story/);
    assert.deepEqual(validateLondonStationStories(null), ['the file needs a "stations" object']);
});

test('describeLondonStationStories drops invalid stories and returns null when none remain', () => {
    assert.deepEqual(describeLondonStationStories({stories: [{...story, checked: 'soon'}, story]}), [{
        text: 'Opened in 1863.',
        sourceTitle: 'Wikipedia: Baker Street tube station',
        sourceUrl: 'https://en.wikipedia.org/wiki/Baker_Street_tube_station'
    }]);
    assert.equal(describeLondonStationStories({stories: [{...story, source: null}]}), null);
    assert.equal(describeLondonStationStories(undefined), null);
});

test('the committed stories file is valid against the London station snapshot', async () => {
    const data = JSON.parse(await readFile(new URL('../assets/london-station-stories.json', import.meta.url), 'utf8'));
    const stations = JSON.parse(gunzipSync(await readFile(new URL('../assets/london-build-data/stations.json.gz', import.meta.url))));
    const names = new Map(stations.map(station => [station.id.split('.').pop(), station.title.en]));

    assert.deepEqual(validateLondonStationStories(data, names), []);
});
