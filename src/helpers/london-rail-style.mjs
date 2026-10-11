// London route widths and adjacent lane separation in CSS pixels. Keep the
// street-level map readable, with a two-pixel gap between parallel lines.
export const LONDON_RAIL_WIDTH_PROFILE = [
    [9, 0.6], [10, 1.2], [11, 2.2], [12, 3.8], [13, 5.4],
    [14, 6.2], [15, 5.1], [16, 4.5], [17, 4.8], [18, 5.2], [19, 5.5]
];

export function londonRailSizeExpressions() {
    return {
        lineWidth: ['interpolate', ['linear'], ['zoom'], ...LONDON_RAIL_WIDTH_PROFILE.flat()],
        lineOffset: ['interpolate', ['linear'], ['zoom'],
            ...LONDON_RAIL_WIDTH_PROFILE.flatMap(([zoom, width]) =>
                [zoom, ['*', ['coalesce', ['get', 'laneOffset'], 0], width + 2]])]
    };
}
