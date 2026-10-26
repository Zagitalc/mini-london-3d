// Baker Street's preloaded TfL Stop Structure snapshot. The source provides
// navigable points and connections, not architectural floor-plan polygons.
import {londonStationMapHTML} from './london-station-map.mjs';

const TUBE_MODE = '2';

// Checked against TfL's Baker Street arrivals platform labels on 26 Oct 2026.
// Metropolitan areas are aggregate source groups, not platforms 1–4.
const BAKER_STREET_PLATFORMS = {
    BakSB: {symbol: 'BAK', number: 8}, BakNB: {symbol: 'BAK', number: 9},
    HamEB: {symbol: 'HAM', number: 5}, HamWB: {symbol: 'HAM', number: 6},
    JubSB: {symbol: 'JUB', number: 7}, JubNB: {symbol: 'JUB', number: 10}
};
const BAKER_STREET_SOURCE = 'https://tfl.gov.uk/tube/stop/940GZZLUBST/baker-street-underground-station';

const LINE_NAMES = {
    BAK: 'Bakerloo',
    CIR: 'Circle',
    HAM: 'Hammersmith & City',
    JUB: 'Jubilee',
    MET: 'Metropolitan'
};

const LINE_COLOURS = {BAK: '#b36305', CIR: '#d7ac00', HAM: '#e798b3', JUB: '#6b7479', MET: '#9b0056'};

const PATH_NAMES = {
    LEVEL: 'walkway',
    STAIRS: 'stairs',
    ESCALATOR: 'escalator',
    ELEVATOR: 'lift',
    RAMP: 'ramp'
};

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;'
    })[character]);
}

function getTubeLines(area) {
    return [...new Set((area.lines || [])
        .filter(line => line.mode === TUBE_MODE)
        .map(line => LINE_NAMES[line.symbol])
        .filter(Boolean))];
}

function getPlatformAreas(data) {
    return (data.areas || []).filter(area => getTubeLines(area).length > 0);
}

function getStreetAreas(data) {
    return (data.areas || []).filter(area => {
        const name = String(area.name || '');
        const isConnectable = (Number(area.type) & 32) === 32;
        const isBusArea = /^bus/i.test(name) || (area.lines || []).some(line => line.mode !== TUBE_MODE);
        return area.id !== '0' && isConnectable && !isBusArea && getTubeLines(area).length === 0;
    });
}

function directionLabel(areaName) {
    const match = String(areaName || '').match(/(NB|SB|EB|WB)$/);
    return ({NB: 'northbound', SB: 'southbound', EB: 'eastbound', WB: 'westbound'})[match && match[1]] || '';
}

function areaLabel(area, kind = 'platform', data) {
    const lines = getTubeLines(area);
    const direction = directionLabel(area.name);
    const lineLabel = lines.length ? lines.join(' + ') : '';

    if (kind === 'street') {
        return `Street access · ${area.name || 'unnamed'}`;
    }
    if (data?.stationId === '940GZZLUBST') {
        if (['MetWB', 'MetEB'].includes(area.name) && (area.lines || []).some(line => line.symbol === 'MET' && line.mode === TUBE_MODE)) {
            return `Metropolitan · ${area.name} group`;
        }
        const reference = BAKER_STREET_PLATFORMS[area.name];
        if (reference && (area.lines || []).some(line => line.symbol === reference.symbol && line.mode === TUBE_MODE)) {
            return `Platform ${reference.number} · ${lineLabel} · ${direction}`;
        }
    }
    return `${lineLabel}${direction ? ` · ${direction}` : ''}` || area.name;
}

/**
 * Finds the quickest directed path in one station's topology graph.
 * @param {Object} data - A normalized TfL Stop Structure snapshot.
 * @param {string} fromId - Starting area ID.
 * @param {string} toId - Destination area ID.
 * @returns {Object|null} The chosen path and total minutes, or null.
 */
export function findLondonStationPath(data, fromId, toId) {
    if (!data || fromId == null || toId == null) return null;
    const start = String(fromId);
    const destination = String(toId);
    const ids = new Set((data.areas || []).map(area => String(area.id)));
    if (!ids.has(start) || !ids.has(destination)) return null;
    if (start === destination) return {areas: [start], paths: [], duration: 0};

    const best = new Map([[start, 0]]);
    const previous = new Map();
    const pending = new Set([start]);

    while (pending.size) {
        let current = null;
        let currentCost = Infinity;
        for (const candidate of pending) {
            const cost = best.get(candidate);
            if (cost < currentCost) {
                current = candidate;
                currentCost = cost;
            }
        }
        if (current === null || current === destination) break;
        pending.delete(current);

        for (const edge of data.paths || []) {
            if (String(edge.from) !== current) continue;
            const next = String(edge.to);
            if (!ids.has(next)) continue;
            const edgeCost = edge.duration;
            if (!Number.isFinite(edgeCost) || edgeCost < 0) continue;
            const candidateCost = currentCost + edgeCost;
            if (candidateCost < (best.get(next) ?? Infinity)) {
                best.set(next, candidateCost);
                previous.set(next, {area: current, edge});
                pending.add(next);
            }
        }
    }

    if (!best.has(destination)) return null;
    const areas = [destination];
    const paths = [];
    let current = destination;
    while (current !== start) {
        const step = previous.get(current);
        if (!step) return null;
        paths.unshift(step.edge);
        areas.unshift(step.area);
        current = step.area;
    }
    return {areas, paths, duration: best.get(destination)};
}

function getPathPoints(data, route) {
    const areaById = new Map((data.areas || []).map(area => [String(area.id), area]));
    const points = [];
    for (const edge of route.paths) {
        let edgePoints = (edge.parts || []).flatMap(part => (part.points || [])
            .filter(point => Number.isFinite(point.longitude) && Number.isFinite(point.latitude)));
        if (edgePoints.length < 2) {
            edgePoints = [areaById.get(String(edge.from))?.point, areaById.get(String(edge.to))?.point]
                .filter(point => point && Number.isFinite(point.longitude) && Number.isFinite(point.latitude));
        }
        for (const point of edgePoints) {
            const last = points[points.length - 1];
            if (!last || last.longitude !== point.longitude || last.latitude !== point.latitude) points.push(point);
        }
    }
    return points;
}

function levelLabel(area) {
    return `Level ${area?.level ?? 'unknown'}`;
}

/**
 * Keep each listed connection in walking order, including up/down detours.
 * @param {Object} route - Chosen directed route.
 * @returns {Array<Object>} Source movements and their known level codes.
 */
export function getLondonStationRouteSteps(route) {
    return (route?.paths || []).flatMap(path => path.parts || []).map(part => {
        const points = part.points || [];
        const from = points[0]?.level;
        const to = points[points.length - 1]?.level;
        const known = Number.isFinite(from) && Number.isFinite(to);
        const movement = PATH_NAMES[part.type] || 'connection';
        const direction = known && from !== to ? (to > from ? 'up' : 'down') : '';
        return {
            points,
            levels: [...new Set(points.map(point => point.level).filter(Number.isFinite))],
            label: `${movement[0].toUpperCase()}${movement.slice(1)}${direction ? ` ${direction}` : ''}`,
            description: known ? `${levelLabel({level: from})} → ${levelLabel({level: to})}` : 'Level information unavailable',
            vertical: known && from !== to
        };
    });
}

function levelTransferHTML(steps) {
    if (!steps.length) return '<p class="london-topology-note">Detailed route steps are unavailable.</p>';
    const levels = [...new Set(steps.flatMap(step => step.levels))].sort((a, b) => a - b);
    const title = steps.some(step => step.vertical) ? 'Level changes in walking order' : 'Walking route';
    return [
        '<section class="london-topology-level-transfer" aria-label="Route steps in walking order">',
        `<h4 class="london-topology-level-title">${title}</h4>`,
        '<p class="london-topology-note">Start → Destination. Follow these connections in order.</p>',
        '<ol class="london-topology-level-sequence" role="list">',
        ...steps.map((step, index) => `<li data-route-levels="${step.levels.join(' ')}"><span class="london-topology-step-number" aria-hidden="true">${index + 1}</span><div><strong>${escapeHTML(step.label)}</strong><small>${escapeHTML(step.description)}</small></div></li>`),
        '</ol>',
        ...(levels.length ? [
            '<label class="london-topology-level-filter">Show on map<select class="london-topology-select" aria-label="Route level" data-topology-level>',
            '<option value="all">All route levels</option>',
            ...levels.map(level => `<option value="${level}">${escapeHTML(levelLabel({level}))}</option>`),
            '</select></label>',
            '<p class="london-topology-note london-topology-level-status" role="status">All route connections highlighted. Level codes are from TfL, not a floor plan.</p>'
        ] : []),
        '</section>'
    ].join('');
}

/**
 * Highlight source connections touching one selected level without hiding the
 * remaining journey, replacing controls, or requesting new data.
 * @param {HTMLElement} container - Route result container.
 * @param {string} level - Source level code or "all".
 */
export function setLondonStationRouteLevel(container, level) {
    const selected = String(level);
    for (const element of container.querySelectorAll('[data-route-levels]')) {
        const levels = element.dataset.routeLevels.split(' ');
        element.classList.toggle('is-level-muted', selected !== 'all' && !levels.includes(selected));
    }
    const status = container.querySelector('.london-topology-level-status');
    if (status) status.textContent = selected === 'all' ?
        'All route connections highlighted. Level codes are from TfL, not a floor plan.' :
        `Connections touching ${levelLabel({level: Number(selected)})} highlighted; other route connections remain visible.`;
}

function snapshotDateHTML(data) {
    for (const candidate of [data.dataBuild, data.generatedAt]) {
        const match = String(candidate || '').match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/);
        if (!match) continue;
        const date = new Date(`${match[1]}T00:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) continue;
        const label = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}).format(date);
        return `<p class="london-topology-freshness">Station paths snapshot · <time datetime="${match[1]}">${escapeHTML(label)}</time></p>`;
    }
    return '<p class="london-topology-freshness">Station paths snapshot date unavailable</p>';
}

function renderRoute(data, fromId, toId) {
    const route = findLondonStationPath(data, fromId, toId);
    const allAreas = data.areas || [];
    const platforms = getPlatformAreas(data);
    const streetAreas = getStreetAreas(data);
    const points = getPathPoints(data, route || {paths: []});
    const steps = getLondonStationRouteSteps(route);
    const nodes = [...platforms, ...streetAreas].map(area => ({
        id: area.id,
        point: area.point,
        kind: streetAreas.includes(area) ? 'street' : 'platform',
        label: areaLabel(area, streetAreas.includes(area) ? 'street' : 'platform', data),
        colour: LINE_COLOURS[(area.lines || []).find(line => line.mode === TUBE_MODE)?.symbol] || '#555'
    }));
    const map = londonStationMapHTML(data.context, nodes, points, fromId, toId, steps);

    if (!route) {
        return [
            '<div class="london-topology-empty">No walking path is listed between these two areas.</div>',
            map
        ].join('');
    }

    const pathTypes = [...new Set(route.paths.flatMap(path => (path.parts || []).map(part => part.type)))]
        .map(type => PATH_NAMES[type] || 'walkway');
    const areaById = new Map(allAreas.map(area => [String(area.id), area]));
    const start = areaById.get(String(fromId));
    const destination = areaById.get(String(toId));
    const destinationKind = streetAreas.some(area => String(area.id) === String(toId)) ? 'street' : 'platform';
    const routeDescription = pathTypes.length ? pathTypes.join(' · ') : 'walkway';
    const minutes = Math.max(1, Math.round(route.duration));


    return [
        `<div class="london-topology-route-summary" aria-live="polite" aria-atomic="true"><div><strong>About ${minutes} min</strong><small>TfL walking estimate</small></div><span>${escapeHTML(routeDescription)}</span></div>`,
        '<p class="london-topology-note london-topology-route-confidence">Approximate corridor geometry · TfL level codes</p>',
        ...([start, destination].some(area => ['MetWB', 'MetEB'].includes(area?.name)) ? [
            '<p class="london-topology-note">Metropolitan groups do not identify individual platforms 1–4. Check the departure board for your platform.</p>'
        ] : []),
        levelTransferHTML(steps),
        map,
        '<div class="london-topology-endpoints">',
        `<div><span class="london-topology-endpoint-number start" aria-hidden="true">S</span><p><strong>${escapeHTML(start ? areaLabel(start, 'platform', data) : 'Starting platform')}</strong><small>Start · ${escapeHTML(levelLabel(start))}</small></p></div>`,
        `<div><span class="london-topology-endpoint-number end" aria-hidden="true">D</span><p><strong>${escapeHTML(destination ? areaLabel(destination, destinationKind, data) : 'Destination')}</strong><small>Destination · ${escapeHTML(levelLabel(destination))}</small></p></div>`,
        '</div>',
        '<div class="london-topology-legend"><span><i class="route"></i>Schematic route</span><span><i class="street"></i>Street connection</span></div>'
    ].join('');
}

/**
 * Builds an interactive, station-specific route-map panel.
 * @param {Object} data - A normalized TfL Stop Structure snapshot.
 * @param {Object} [selection] - Previously selected start/destination areas.
 * @returns {string} Safe HTML for the drawer.
 */
export function londonStationTopologyHTML(data, selection = {}) {
    if (!data || !Array.isArray(data.areas) || !Array.isArray(data.paths)) return '';
    const platforms = getPlatformAreas(data);
    const streetAreas = getStreetAreas(data);
    if (!platforms.length || !streetAreas.length) return '';
    const fromId = platforms.some(area => String(area.id) === String(selection.from))
        ? String(selection.from)
        : String(platforms[0].id);
    const destinations = [...streetAreas, ...platforms.filter(area => String(area.id) !== fromId)];
    const toId = destinations.some(area => String(area.id) === String(selection.to))
        ? String(selection.to)
        : String(destinations[0]?.id || '');
    const options = (areas, selectedId, kindForArea) => areas.map(area => [
        `<option value="${escapeHTML(area.id)}"${String(area.id) === selectedId ? ' selected' : ''}>`,
        escapeHTML(areaLabel(area, kindForArea(area), data)),
        '</option>'
    ].join('')).join('');

    return [
        '<section class="london-drawer-section london-topology-card">',
        '<div class="london-section-heading-row"><h3>Station route map</h3><span class="london-topology-source">Baker Street</span></div>',
        '<p class="london-topology-copy">Compare TfL’s listed walking routes between platform areas and street connections.</p>',
        snapshotDateHTML(data),
        '<div class="london-topology-controls">',
        '<label>From<select class="london-topology-select" data-topology-role="from" aria-label="Starting platform">',
        options(platforms, fromId, () => 'platform'),
        '</select></label>',
        '<label>To<select class="london-topology-select" data-topology-role="to" aria-label="Destination platform or street access">',
        londonStationTopologyDestinationOptionsHTML(data, fromId, toId),
        '</select></label>',
        '</div>',
        `<div class="london-topology-result">${londonStationTopologyRouteHTML(data, fromId, toId)}</div>`,
        '<p class="london-topology-note">Underground paths are shown over the street map; corridor shapes are approximate. Street links use TfL’s codes.</p>',
        '<p class="london-topology-note">Walking estimates exclude live crowding and lift or escalator outages.</p>',
        '<details class="london-topology-steps london-topology-evidence"><summary>Coverage and source checks</summary>',
        '<p class="london-topology-note">Eight platform areas are represented. Metropolitan areas group multiple platforms; street links retain unnamed TfL codes. Level numbers are source codes, not measured depths or a count of floors.</p>',
        '<p class="london-topology-note">Connections, levels and walking estimates match the supplied TfL Stop Structure snapshot. Corridor shapes and walking times have not been checked on site.</p>',
        ...(data.stationId === '940GZZLUBST' ? [`<p class="london-topology-note">Six platform numbers and directions checked against <a href="${BAKER_STREET_SOURCE}">TfL’s station information</a> on <time datetime="2026-10-26">26 Oct 2026</time>. Metropolitan platform numbers are unresolved.</p>`] : []),
        '</details>',
        '<p class="london-topology-note">Data provided by Transport for London.</p>',
        '</section>'
    ].join('');
}

/**
 * Builds the selected route summary and schematic.
 * @param {Object} data - A normalized TfL Stop Structure snapshot.
 * @param {string} fromId - Starting area ID.
 * @param {string} toId - Destination area ID.
 * @returns {string} Safe HTML for the route result.
 */
export function londonStationTopologyRouteHTML(data, fromId, toId) {
    return renderRoute(data, fromId, toId);
}

/**
 * Refreshes destinations when the origin changes without replacing either select.
 * @param {Object} data - Station topology.
 * @param {string} fromId - Starting platform.
 * @param {string} toId - Preferred destination, if still valid.
 * @returns {string} Options with a valid selected destination.
 */
export function londonStationTopologyDestinationOptionsHTML(data, fromId, toId) {
    const streetAreas = getStreetAreas(data);
    const destinations = [...streetAreas, ...getPlatformAreas(data).filter(area => String(area.id) !== String(fromId))];
    const selectedId = destinations.some(area => String(area.id) === String(toId)) ? String(toId) : String(destinations[0]?.id);
    return destinations.map(area => `<option value="${escapeHTML(area.id)}"${String(area.id) === selectedId ? ' selected' : ''}>${escapeHTML(areaLabel(area, streetAreas.includes(area) ? 'street' : 'platform', data))}</option>`).join('');
}

export {getPlatformAreas, getStreetAreas};
