// Station facilities from TfL's StopPoint `additionalProperties`, baked into
// station-facilities.json.gz at build time by
// scripts/build-london-station-facilities.mjs and read by the station drawer.
//
// TfL returns entries such as {category: 'Facility', key: 'Lifts', value: '2'}
// and {category: ..., key: 'Zone', value: '1'}. Values are inconsistent:
// 'yes', 'no', '3', 'yes (male, female)', 'yes Piccadilly line only',
// '4 on platforms, 0 in ticket halls, 1 elsewhere', or unrelated free text.

const FACILITY_LABELS = [
    [/^toilets?$/i, 'Toilets'],
    [/^lifts?$/i, 'Lifts'],
    [/^escalators?$/i, 'Escalators'],
    [/wi-?fi/i, 'Wi-Fi'],
    [/^ticket halls?$/i, 'Ticket halls'],
    [/^gates?$/i, 'Ticket gates'],
    [/car park/i, 'Car park'],
    [/^cash machines?$/i, 'Cash machines'],
    [/^euro cash machines?$/i, 'Euro cash machines'],
    [/^payphones?$/i, 'Payphones'],
    [/waiting room/i, 'Waiting room'],
    [/^help points?$/i, 'Help points'],
    [/^bridge$/i, 'Footbridge'],
    [/^boarding ramps?$/i, 'Boarding ramp'],
    [/photo booths?/i, 'Photo booth']
];

// Labels whose 'yes …' qualifier changes the meaning, so it is kept.
const QUALIFIED_LABELS = new Set(['Boarding ramp']);

/**
 * Reads one facility value.
 * @param {string} value - Raw TfL value.
 * @returns {Object|null} {count, qualifier} when present, null when absent.
 */
export function parseLondonFacilityValue(value) {
    const text = String(value || '').trim();

    const yes = /^yes\b\s*[-–(]?\s*(.*?)\)?\.?$/i.exec(text);
    if (yes) {
        return {count: null, qualifier: yes[1] || null};
    }
    // Counts, including '1lift … and 1 lift …' and per-area breakdowns, are summed.
    if (/^\d/.test(text)) {
        const count = (text.match(/\d+/g) || []).reduce((sum, n) => sum + Number(n), 0);
        return count > 0 ? {count, qualifier: null} : null;
    }
    // 'no', 'none' and anything else ('Local authority facility nearby') count as absent.
    return null;
}

/**
 * Pulls the zone and facility entries out of a StopPoint response.
 * @param {Object} stopPoint - Parsed GET /StopPoint/{id} response.
 * @returns {Object|null} {zone, facilities: [{key, value}]}, or null if empty.
 */
export function extractLondonStationFacilities(stopPoint) {
    const properties = stopPoint && Array.isArray(stopPoint.additionalProperties) ? stopPoint.additionalProperties : [];
    let zone = null;
    const facilities = [];
    const seen = new Set();

    for (const property of properties) {
        if (!property || typeof property.key !== 'string') continue;
        const key = property.key.trim();
        const value = typeof property.value === 'string' ? property.value.trim() : '';

        if (key === 'Zone' && value) {
            zone = value;
        } else if (property.category === 'Facility' && !seen.has(key)) {
            seen.add(key);
            facilities.push({key, value});
        }
    }

    facilities.sort((a, b) => a.key.localeCompare(b.key));
    return zone || facilities.length ? {zone, facilities} : null;
}

/**
 * Builds the drawer model: a zone label and the facilities that are present.
 * @param {Object|null} record - Output of extractLondonStationFacilities.
 * @returns {Object|null} {zone, items: [{label, detail}]}, or null if nothing to show.
 */
export function describeLondonStationFacilities(record) {
    if (!record) return null;

    const items = [];
    for (const {key, value} of record.facilities || []) {
        const match = FACILITY_LABELS.find(([pattern]) => pattern.test(key));
        // Unrecognised keys are skipped rather than shown in TfL's raw wording.
        if (!match || items.some(item => item.label === match[1])) continue;
        const parsed = parseLondonFacilityValue(value);
        if (!parsed) continue;
        const label = match[1];
        const detail = parsed.count > 1 ? String(parsed.count) :
            QUALIFIED_LABELS.has(label) && parsed.qualifier ? parsed.qualifier : null;

        items.push({label, detail});
    }

    const zone = record.zone ? `Zone ${record.zone.replace(/\+/g, '/')}` : null;
    return zone || items.length ? {zone, items} : null;
}
