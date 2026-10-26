const METRES_PER_DEGREE = 111319.49;
const WIDTH = 360;
const HEIGHT = 300;

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'
    })[character]);
}

/**
 * Projects the small station extent in metres, preserving east/west scale.
 * @param {Array<number>} bounds - West, south, east and north in WGS84 degrees.
 * @returns {Object} Shared projection for street geometry and station routes.
 */
export function createLondonStationProjection(bounds) {
    const [west, south, east, north] = bounds;
    const longitudeScale = METRES_PER_DEGREE * Math.cos((south + north) / 2 * Math.PI / 180);
    const scale = Math.min(WIDTH / ((east - west) * longitudeScale), HEIGHT / ((north - south) * METRES_PER_DEGREE));
    const middleLongitude = (west + east) / 2;
    const middleLatitude = (south + north) / 2;

    return {
        metresToPixels: scale,
        project: point => [
            WIDTH / 2 + (point[0] - middleLongitude) * longitudeScale * scale,
            HEIGHT / 2 - (point[1] - middleLatitude) * METRES_PER_DEGREE * scale
        ]
    };
}

function pathData(coordinates, project) {
    return coordinates.map((point, index) => `${index ? 'L' : 'M'}${project(point).map(value => value.toFixed(2)).join(',')}`).join('');
}

/**
 * Separates nearby endpoint labels while retaining their geographic anchors.
 * @param {Array<number>} start - Projected start coordinate.
 * @param {Array<number>} end - Projected destination coordinate.
 * @returns {Array<Object>} Anchor and displayed position for each pin.
 */
export function layoutLondonStationPins(start, end) {
    const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (distance >= 40) return [start, end].map(anchor => ({anchor, position: [...anchor], displaced: false}));

    const direction = distance > 0 ? [(end[0] - start[0]) / distance, (end[1] - start[1]) / distance] : [1, 0];
    const offset = (46 - distance) / 2;
    const clamp = point => [Math.max(14, Math.min(WIDTH - 14, point[0])), Math.max(14, Math.min(HEIGHT - 14, point[1]))];
    let positions = [
        clamp([start[0] - direction[0] * offset, start[1] - direction[1] * offset]),
        clamp([end[0] + direction[0] * offset, end[1] + direction[1] * offset])
    ];
    if (Math.hypot(positions[1][0] - positions[0][0], positions[1][1] - positions[0][1]) < 40) {
        const middle = [Math.max(37, Math.min(WIDTH - 37, (start[0] + end[0]) / 2)), Math.max(14, Math.min(HEIGHT - 14, (start[1] + end[1]) / 2))];
        positions = [[middle[0] - 23, middle[1]], [middle[0] + 23, middle[1]]];
    }
    return [start, end].map((anchor, index) => ({anchor, position: positions[index], displaced: true}));
}

// Clip a label candidate to the map so long OSM ways never place text offscreen.
function visibleSegment(start, end) {
    const deltaX = end[0] - start[0];
    const deltaY = end[1] - start[1];
    let lower = 0;
    let upper = 1;
    const p = [-deltaX, deltaX, -deltaY, deltaY];
    const q = [start[0] - 20, WIDTH - 20 - start[0], start[1] - 20, HEIGHT - 35 - start[1]];
    for (let index = 0; index < 4; index++) {
        if (p[index] === 0) {
            if (q[index] < 0) return null;
        } else {
            const ratio = q[index] / p[index];
            if (p[index] < 0) lower = Math.max(lower, ratio);
            else upper = Math.min(upper, ratio);
            if (lower > upper) return null;
        }
    }
    return [
        [start[0] + lower * deltaX, start[1] + lower * deltaY],
        [start[0] + upper * deltaX, start[1] + upper * deltaY]
    ];
}

function streetLabels(features, project) {
    const byName = new Map();
    for (const feature of features.filter(item => item.kind === 'road' && item.name && item.name.length <= 22)) {
        const points = feature.coordinates.map(project);
        for (let index = 1; index < points.length; index++) {
            const segment = visibleSegment(points[index - 1], points[index]);
            if (!segment) continue;
            const [start, end] = segment;
            const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
            const current = byName.get(feature.name) || {total: 0, length: 0};
            current.total += length;
            byName.set(feature.name, current);
            if (length < current.length) continue;
            let angle = Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI;
            if (angle > 90) angle -= 180;
            if (angle < -90) angle += 180;
            Object.assign(current, {length, angle, x: (start[0] + end[0]) / 2, y: (start[1] + end[1]) / 2});
        }
    }
    return [...byName.entries()].filter(([name, position]) => position.total >= name.length * 4.8 && position.length >= 18).map(([name, position]) =>
        `<text class="london-topology-road-label" transform="translate(${position.x.toFixed(2)},${position.y.toFixed(2)}) rotate(${position.angle.toFixed(2)})" text-anchor="middle">${escapeHTML(name)}</text>`
    ).join('');
}

function landmarkLabels(features, project) {
    return features.filter(feature => feature.kind === 'building' && ['Chiltern Court', 'Madame Tussauds'].includes(feature.name)).map(feature => {
        const points = feature.coordinates.map(project);
        const x = points.reduce((sum, point) => sum + point[0], 0) / points.length;
        const y = points.reduce((sum, point) => sum + point[1], 0) / points.length;
        if (x < 60 || x > WIDTH - 60 || y < 15 || y > HEIGHT - 35) return '';
        return `<text class="london-topology-building-label" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle">${escapeHTML(feature.name)}</text>`;
    }).join('');
}

/**
 * Renders a bundled geographic street map beneath the station's route.
 * @param {Object|null} context - Normalized OpenStreetMap snapshot.
 * @param {Array<Object>} nodes - Labelled platform and street connection points.
 * @param {Array<Object>} points - Selected route coordinates from TfL.
 * @param {string} fromId - Selected starting area.
 * @param {string} toId - Selected destination area.
 * @param {Array<Object>} [segments] - Ordered route connections with source levels.
 * @returns {string} Accessible SVG and visible data attribution.
 */
export function londonStationMapHTML(context, nodes, points, fromId, toId, segments = []) {
    const coordinates = [...nodes.map(node => node.point), ...points]
        .filter(point => Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude));
    const fallbackBounds = [
        Math.min(...coordinates.map(point => point.longitude)) - 0.001,
        Math.min(...coordinates.map(point => point.latitude)) - 0.0005,
        Math.max(...coordinates.map(point => point.longitude)) + 0.001,
        Math.max(...coordinates.map(point => point.latitude)) + 0.0005
    ];
    const {project, metresToPixels} = createLondonStationProjection(context?.bounds || fallbackBounds);
    const features = context?.features || [];
    const fragments = [
        '<figure class="london-topology-map-figure">',
        `<svg class="london-topology-map" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Baker Street street map with the selected underground route">`,
        '<title>Baker Street station walking route on the street map</title>',
        '<desc>North is up. Streets and buildings are shown at ground level. The underground route is blue; S marks the start and D marks the destination. Route lines are approximate, not a station floor plan.</desc>',
        `<rect class="london-topology-ground" width="${WIDTH}" height="${HEIGHT}"/>`
    ];
    for (const feature of features.filter(item => item.kind === 'park' || item.kind === 'building')) {
        fragments.push(`<path class="london-topology-basemap-${feature.kind}" d="${pathData(feature.coordinates, project)}Z"/>`);
    }
    for (const feature of features.filter(item => item.kind === 'road')) {
        const roadMetres = ({trunk: 9, primary: 9, secondary: 8, tertiary: 7, residential: 6, service: 4})[feature.roadClass] || 5;
        const width = roadMetres * metresToPixels;
        const path = pathData(feature.coordinates, project);
        fragments.push(`<path class="london-topology-road-casing" d="${path}" stroke-width="${width + 2}"/>`);
        fragments.push(`<path class="london-topology-road" d="${path}" stroke-width="${width}"/>`);
    }
    for (const feature of features.filter(item => item.kind === 'footway')) {
        fragments.push(`<path class="london-topology-footway" d="${pathData(feature.coordinates, project)}"/>`);
    }
    fragments.push(streetLabels(features, project), landmarkLabels(features, project));
    if (segments.length) {
        for (const segment of segments) {
            const coordinates = segment.points.filter(point => Number.isFinite(point.longitude) && Number.isFinite(point.latitude));
            if (coordinates.length < 2) continue;
            const route = pathData(coordinates.map(point => [point.longitude, point.latitude]), project);
            fragments.push(`<g class="london-topology-route-segment" data-route-levels="${segment.levels.join(' ')}"><title>${escapeHTML(segment.label)}: ${escapeHTML(segment.description)}</title><path class="london-topology-route-halo" d="${route}"/><path class="london-topology-route-line" d="${route}"/></g>`);
        }
    } else if (points.length > 1) {
        const route = pathData(points.map(point => [point.longitude, point.latitude]), project);
        fragments.push(`<path class="london-topology-route-halo" d="${route}"/>`, `<path class="london-topology-route-line" d="${route}"/>`);
    }
    const selectedIds = new Set([String(fromId), String(toId)]);
    const startNode = nodes.find(node => String(node.id) === String(fromId));
    const endNode = nodes.find(node => String(node.id) === String(toId));
    const validPoint = node => Number.isFinite(node?.point?.longitude) && Number.isFinite(node?.point?.latitude);
    const pinLayout = validPoint(startNode) && validPoint(endNode) ? layoutLondonStationPins(
        project([startNode.point.longitude, startNode.point.latitude]),
        project([endNode.point.longitude, endNode.point.latitude])
    ) : null;
    const orderedNodes = [...nodes].sort((first, second) => Number(selectedIds.has(String(first.id))) - Number(selectedIds.has(String(second.id))));
    for (const node of orderedNodes) {
        if (!Number.isFinite(node.point?.longitude) || !Number.isFinite(node.point?.latitude)) continue;
        const [x, y] = project([node.point.longitude, node.point.latitude]);
        const selected = String(node.id) === String(fromId) ? '1' : String(node.id) === String(toId) ? '2' : null;
        const title = `<title>${selected ? (selected === '1' ? 'Start: ' : 'Destination: ') : ''}${escapeHTML(node.label)}</title>`;
        if (selected) {
            const layout = pinLayout?.[selected === '1' ? 0 : 1];
            const [pinX, pinY] = layout?.position || [x, y];
            if (layout?.displaced) {
                fragments.push(`<path class="london-topology-pin-leader" d="M${x},${y}L${pinX},${pinY}"/>`);
                fragments.push(`<circle class="london-topology-pin-anchor ${selected === '1' ? 'start' : 'end'}" cx="${x}" cy="${y}" r="2.5"/>`);
            }
            fragments.push(`<g class="london-topology-pin ${selected === '1' ? 'start' : 'end'}" transform="translate(${pinX},${pinY})">${title}<circle r="11"/><text text-anchor="middle" dy="4">${selected === '1' ? 'S' : 'D'}</text></g>`);
        } else if (node.kind === 'street') {
            fragments.push(`<rect class="london-topology-node street" x="${x - 3.5}" y="${y - 3.5}" width="7" height="7" rx="1.5">${title}</rect>`);
        } else {
            fragments.push(`<circle class="london-topology-node platform" cx="${x}" cy="${y}" r="3.5" fill="${node.colour}">${title}</circle>`);
        }
    }
    const scaleWidth = 50 * metresToPixels;
    fragments.push(
        '<g class="london-topology-map-furniture"><path d="M338,36L338,19M334,24L338,19L342,24"/><text x="338" y="14" text-anchor="middle">N</text>',
        `<path d="M16,278v5h${scaleWidth}v-5"/><text x="16" y="273">50 m</text></g>`,
        '</svg>',
        '<figcaption class="london-topology-attribution">',
        `<span>${features.length ? 'Street map · north up' : 'Street map unavailable'}</span>`,
        '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>',
        '</figcaption>',
        pinLayout?.[0].displaced ? '<p class="london-topology-pin-note">Pins separated for clarity; thin lines show their locations.</p>' : '',
        '</figure>'
    );
    return fragments.join('');
}
