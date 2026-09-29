// Short, sourced facts about individual stations, kept by hand in
// assets/london-station-stories.json and shown at the bottom of the station
// drawer. Every story must name the page it was checked against and the date
// it was read, so nothing reaches the site on memory alone.
//
// File shape:
// {
//   "stations": {
//     "940GZZLUBST": {
//       "name": "Baker Street",
//       "stories": [{
//         "text": "...",
//         "source": {"title": "...", "url": "https://..."},
//         "checked": "2026-09-29"
//       }]
//     }
//   }
// }

export const LONDON_STORY_MAX_LENGTH = 280;
export const LONDON_STORY_MAX_PER_STATION = 2;

function isHttpsUrl(value) {
    try {
        return new URL(value).protocol === 'https:';
    } catch (e) {
        return false;
    }
}

function isCalendarDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const date = new Date(`${value}T00:00:00Z`);

    return !isNaN(date) && date.toISOString().slice(0, 10) === value;
}

/**
 * Checks a stories file.
 * @param {Object} data - Parsed london-station-stories.json.
 * @param {Map<string, string>} [knownStations] - Stop point ID to English name.
 * @returns {Array<string>} One message per problem; empty when the file is valid.
 */
export function validateLondonStationStories(data, knownStations) {
    const errors = [];

    if (!data || typeof data.stations !== 'object' || Array.isArray(data.stations)) {
        return ['the file needs a "stations" object'];
    }
    for (const [id, entry] of Object.entries(data.stations)) {
        const where = `${id}${entry && entry.name ? ` (${entry.name})` : ''}`;

        if (knownStations) {
            if (!knownStations.has(id)) {
                errors.push(`${where}: not a station in the London snapshot`);
            } else if (entry && entry.name !== knownStations.get(id)) {
                errors.push(`${where}: name should be "${knownStations.get(id)}"`);
            }
        }
        if (!entry || !Array.isArray(entry.stories) || entry.stories.length === 0) {
            errors.push(`${where}: needs at least one story`);
            continue;
        }
        if (entry.stories.length > LONDON_STORY_MAX_PER_STATION) {
            errors.push(`${where}: at most ${LONDON_STORY_MAX_PER_STATION} stories per station`);
        }
        entry.stories.forEach((story, index) => {
            const at = `${where} story ${index + 1}`;
            const text = story && typeof story.text === 'string' ? story.text.trim() : '';
            const source = story && story.source;

            if (!text) {
                errors.push(`${at}: text is empty`);
            } else if (text.length > LONDON_STORY_MAX_LENGTH) {
                errors.push(`${at}: text is ${text.length} characters (limit ${LONDON_STORY_MAX_LENGTH})`);
            }
            if (!source || typeof source.title !== 'string' || !source.title.trim()) {
                errors.push(`${at}: source needs a title`);
            }
            if (!source || !isHttpsUrl(source.url)) {
                errors.push(`${at}: source needs an https URL`);
            }
            if (!isCalendarDate(story && story.checked)) {
                errors.push(`${at}: "checked" must be the YYYY-MM-DD date the source was read`);
            }
        });
    }
    return errors;
}

/**
 * Picks the displayable stories for one station, dropping any invalid entry
 * so a bad hand edit hides one story rather than breaking the drawer.
 * @param {Object} entry - One value from the "stations" object.
 * @returns {Array<Object>|null} [{text, sourceTitle, sourceUrl}], or null.
 */
export function describeLondonStationStories(entry) {
    if (!entry || !Array.isArray(entry.stories)) return null;

    const stories = entry.stories
        .filter(story => validateLondonStationStories({stations: {x: {stories: [story]}}}).length === 0)
        .slice(0, LONDON_STORY_MAX_PER_STATION)
        .map(story => ({
            text: story.text.trim(),
            sourceTitle: story.source.title.trim(),
            sourceUrl: story.source.url
        }));

    return stories.length ? stories : null;
}
