// Baker Street's preloaded TfL Stop Structure snapshot. The source provides
// navigable points and connections, not architectural floor-plan polygons.

const TUBE_MODE = '2';

const LINE_NAMES = {
    BAK: 'Bakerloo',
    CIR: 'Circle',
    HAM: 'Hammersmith & City',
    JUB: 'Jubilee',
    MET: 'Metropolitan'
};

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

function areaLabel(area, kind = 'platform') {
    const lines = getTubeLines(area);
    const direction = directionLabel(area.name);
    const lineLabel = lines.length ? lines.join(' + ') : '';

    if (kind === 'street') {
        return `Street access · ${area.name || 'unnamed'}`;
    }
    return `${lineLabel}${direction ? ` · ${direction}` : ''} · ${area.name}`;
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
            const edgeCost = Number(edge.duration);
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

function projectPoint(point, bounds, width, height, padding) {
    const xRange = Math.max(bounds.maxX - bounds.minX, 1e-7);
    const yRange = Math.max(bounds.maxY - bounds.minY, 1e-7);
    const scale = Math.min((width - padding * 2) / xRange, (height - padding * 2) / yRange);
    const drawWidth = xRange * scale;
    const drawHeight = yRange * scale;
    const offsetX = (width - drawWidth) / 2;
    const offsetY = (height - drawHeight) / 2;
    return [
        offsetX + (point.longitude - bounds.minX) * scale,
        height - offsetY - (point.latitude - bounds.minY) * scale
    ];
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

function renderRoute(data, fromId, toId) {
    const route = findLondonStationPath(data, fromId, toId);
    const allAreas = data.areas || [];
    const platforms = getPlatformAreas(data);
    const streetAreas = getStreetAreas(data);
    const selectedIds = new Set([String(fromId), String(toId)]);
    const points = getPathPoints(data, route || {paths: []});
    const areaPoints = allAreas.filter(area => Number.isFinite(area.point?.longitude) && Number.isFinite(area.point?.latitude));
    const coordinateSet = [...areaPoints.map(area => area.point), ...points];
    const bounds = coordinateSet.reduce((result, point) => ({
        minX: Math.min(result.minX, point.longitude),
        maxX: Math.max(result.maxX, point.longitude),
        minY: Math.min(result.minY, point.latitude),
        maxY: Math.max(result.maxY, point.latitude)
    }), {minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity});
    const width = 320;
    const height = 170;
    const padding = 16;
    const svgParts = [];

    if (route && points.length > 1) {
        const polyline = points.map(point => projectPoint(point, bounds, width, height, padding).join(',')).join(' ');
        svgParts.push(`<polyline class="london-topology-route-line" points="${polyline}"/>`);
    }
    for (const area of platforms) {
        const position = projectPoint(area.point, bounds, width, height, padding);
        const isSelected = selectedIds.has(String(area.id));
        svgParts.push(`<circle class="london-topology-node platform${isSelected ? ' selected' : ''}" cx="${position[0]}" cy="${position[1]}" r="${isSelected ? 6 : 4}"/>`);
    }
    for (const area of streetAreas) {
        const position = projectPoint(area.point, bounds, width, height, padding);
        const isSelected = selectedIds.has(String(area.id));
        svgParts.push(`<rect class="london-topology-node street${isSelected ? ' selected' : ''}" x="${position[0] - 4}" y="${position[1] - 4}" width="8" height="8" rx="2"/>`);
    }

    if (!route) {
        return [
            '<div class="london-topology-empty">No walking path is listed between these two areas.</div>',
            `<svg class="london-topology-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="Baker Street platforms and street access points">`,
            ...svgParts,
            '</svg>'
        ].join('');
    }

    const pathTypes = [...new Set(route.paths.flatMap(path => (path.parts || []).map(part => part.type)))]
        .map(type => PATH_NAMES[type] || 'walkway');
    const areaById = new Map(allAreas.map(area => [String(area.id), area]));
    const destination = areaById.get(String(toId));
    const destinationKind = streetAreas.some(area => String(area.id) === String(toId)) ? 'street' : 'platform';
    const routeDescription = pathTypes.length ? pathTypes.join(' · ') : 'walkway';
    const minutes = Math.max(1, Math.round(route.duration));

    return [
        `<div class="london-topology-route-summary"><strong>${minutes} min</strong><span>${escapeHTML(routeDescription)}</span></div>`,
        `<p class="london-topology-destination">To ${escapeHTML(destination ? areaLabel(destination, destinationKind) : 'selected area')}</p>`,
        `<svg class="london-topology-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="Schematic route through Baker Street station">`,
        '<title>Selected route through Baker Street station</title>',
        ...svgParts,
        '</svg>',
        '<div class="london-topology-legend"><span><i class="platform"></i>Tube platform</span><span><i class="street"></i>Street connection</span></div>'
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
        escapeHTML(areaLabel(area, kindForArea(area))),
        '</option>'
    ].join('')).join('');

    return [
        '<section class="london-drawer-section london-topology-card">',
        '<div class="london-section-heading-row"><h3>Station route map</h3><span class="london-topology-source">TfL topology</span></div>',
        '<p class="london-topology-copy">Choose platforms to see the quickest listed walking route.</p>',
        '<div class="london-topology-controls">',
        '<label>From<select class="london-topology-select" data-topology-role="from" aria-label="Starting platform">',
        options(platforms, fromId, () => 'platform'),
        '</select></label>',
        '<label>To<select class="london-topology-select" data-topology-role="to" aria-label="Destination platform or street access">',
        options(destinations, toId, area => streetAreas.includes(area) ? 'street' : 'platform'),
        '</select></label>',
        '</div>',
        `<div class="london-topology-result">${londonStationTopologyRouteHTML(data, fromId, toId)}</div>`,
        '<p class="london-topology-note">Street links are unnamed in TfL’s source; this schematic does not show corridor shapes.</p>',
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

export {getPlatformAreas, getStreetAreas};
