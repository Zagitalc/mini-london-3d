// The hover card for a live London train: line and destination, the next
// stop with its platform and a countdown, then the previous stop. Plain
// HTML from plain values, so it can be unit-tested.

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, s => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'})[s]);
}

/**
 * How long until the train reaches its next stop, as shown on the card.
 * @param {number} ms - Milliseconds until arrival.
 * @returns {string|null} "Due", "1 min", "4 min", or null if unknown.
 */
export function londonTrainEtaLabel(ms) {
    if (!Number.isFinite(ms)) return null;
    if (ms < 45000) return 'Due';
    return `${Math.max(1, Math.round(ms / 60000))} min`;
}

/**
 * Tidies a TfL platform name: "Westbound - Platform 1" becomes "Westbound · Platform 1".
 * @param {string} platform - TfL platformName.
 * @returns {string} The platform for display, or '' if there is none.
 */
export function londonPlatformLabel(platform) {
    const text = String(platform || '').trim().replace(/\s+-\s+/g, ' · ');
    return /^(null|unknown|platform unavailable)$/i.test(text) ? '' : text;
}

/**
 * Builds the card.
 * @param {Object} train - What to show.
 * @param {string} train.lineTitle - Line name, e.g. "Hammersmith & City".
 * @param {string|Array<string>} train.colors - Line colour, or up to three colours.
 * @param {string} [train.destination] - Where it is going.
 * @param {string} [train.trainNumber] - TfL vehicle or train number.
 * @param {Object} [train.next] - {name, time, platform, etaLabel}.
 * @param {Object} [train.previous] - {name, time}.
 * @returns {string} HTML for the popup.
 */
export function londonTrainPopupHTML({lineTitle, colors, destination, trainNumber, next, previous}) {
    const bars = (Array.isArray(colors) ? colors.slice(0, 3) : [colors || '#0098D4'])
        .map(color => `<span style="background-color:${escapeHTML(color)};"></span>`).join('');
    const platform = next ? londonPlatformLabel(next.platform) : '';

    return [
        '<div class="london-train-popup">',
        '<div class="london-train-popup-header">',
        `<span class="london-train-popup-bar" aria-hidden="true">${bars}</span>`,
        '<div class="london-train-popup-heading">',
        `<strong>${escapeHTML(lineTitle)}</strong>`,
        destination ? `<span>to ${escapeHTML(destination)}</span>` : '',
        '</div>',
        '</div>',
        next && next.name ? [
            '<div class="london-train-popup-next">',
            '<div class="london-train-popup-next-copy">',
            '<span class="london-train-popup-label">Next stop</span>',
            `<strong>${escapeHTML(next.name)}</strong>`,
            platform ? `<span class="london-train-popup-meta">${escapeHTML(platform)}</span>` : '',
            '</div>',
            next.etaLabel || next.time ? [
                '<div class="london-train-popup-eta">',
                next.etaLabel ? `<strong>${escapeHTML(next.etaLabel)}</strong>` : '',
                next.time ? `<span>${escapeHTML(next.time)}</span>` : '',
                '</div>'
            ].join('') : '',
            '</div>'
        ].join('') : '',
        previous && previous.name ?
            `<div class="london-train-popup-previous"><span class="london-train-popup-label">Previous</span> ${escapeHTML(previous.name)}${previous.time ? ` · ${escapeHTML(previous.time)}` : ''}</div>` : '',
        trainNumber ? `<div class="london-train-popup-footer">Train ${escapeHTML(trainNumber)}</div>` : '',
        '</div>'
    ].join('');
}
