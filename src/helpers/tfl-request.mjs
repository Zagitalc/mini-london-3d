// Builds the ordered list of URLs the browser tries for a TfL API path:
// configured same-origin proxies first, then TfL directly. Third-party CORS
// proxies are deliberately not supported, since they would see any app key.

const TFL_ORIGIN = 'https://api.tfl.gov.uk';

/**
 * Whether a configured base points at TfL itself, compared by parsed host
 * rather than substring, so "api.tfl.gov.uk.example.com" does not count.
 * @param {string} base - Configured proxy base or URL.
 * @returns {boolean} True for TfL's own API origin.
 */
export function isTflApiBase(base) {
    try {
        return new URL(base, 'https://relative.invalid').hostname === 'api.tfl.gov.uk';
    } catch (e) {
        return false;
    }
}

/**
 * Lists the URLs to try for a TfL path, most preferred first.
 * @param {Object} options - Request options.
 * @param {string} options.path - TfL path with optional query, e.g. "/Line/victoria/Arrivals".
 * @param {Array<string>} [options.proxyBases] - Same-origin proxy bases such as "/tfl".
 * @param {string} [options.appKey] - Browser-side key, only ever sent to TfL itself.
 * @param {string} [options.appId] - Browser-side app ID, only ever sent to TfL itself.
 * @returns {Array<string>} URLs to try in order, without duplicates.
 */
export function buildTflRequestUrls({path, proxyBases = [], appKey, appId}) {
    const direct = new URL(`${TFL_ORIGIN}${path}`);
    if (appKey) direct.searchParams.set('app_key', appKey);
    if (appId) direct.searchParams.set('app_id', appId);

    const urls = [];
    for (const candidate of proxyBases) {
        let base = String(candidate || '').trim();
        while (base.endsWith('/')) base = base.slice(0, -1);
        if (!base || isTflApiBase(base)) continue;
        // The proxy adds its own key; ours never leaves for anywhere but TfL.
        urls.push(`${base}${path}`);
    }
    urls.push(direct.toString());

    return [...new Set(urls)];
}
