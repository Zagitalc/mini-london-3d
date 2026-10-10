// Small rules for how a live train is drawn as it stops and starts.
//
// From a recording of the real site (9 October 2026): in one 10-second poll,
// 110 of 367 trains "departed" a station. Each one jumped from the platform to
// a median of 48% of the way along the next section, and 51 of them turned
// round on the spot, because a train standing at a station (a section of
// length zero) was always drawn facing the ascending direction.

/**
 * Which way to draw a train along its route.
 * @param {number} sectionLength - Station steps from the previous to the next station: -1, 0 or 1.
 * @param {number} headingStep - Sign of (next predicted station - current station), or 0 if unknown.
 * @param {number} [previousFacing] - How it was last drawn: -1 or 1.
 * @param {number} [directionStep] - Direction inferred from all its predictions, which defaults to 1.
 * @returns {number} 1 to draw it ascending, -1 descending.
 */
export function londonTrainFacing(sectionLength, headingStep, previousFacing, directionStep) {
    // Standing at a station: face where it goes next, else keep its last
    // facing; the inferred direction comes last because it defaults to 1.
    return Math.sign(sectionLength) || Math.sign(headingStep) || Math.sign(previousFacing) || Math.sign(directionStep) || 1;
}

/**
 * Timing for a train that has just left a station: it starts at the platform
 * now and reaches the next station when TfL predicts, instead of appearing
 * part-way along as if it had left earlier.
 * @param {Object} options - Options.
 * @param {number} options.nowOffset - Clock offset now, in milliseconds.
 * @param {number} options.timeToStation - Seconds until the next station.
 * @param {number} [options.minimumSeconds] - Shortest run to animate.
 * @returns {Object} {startOffset, endOffset, duration} in milliseconds.
 */
export function londonDepartureTiming({nowOffset, timeToStation, minimumSeconds = 8}) {
    const seconds = Math.max(minimumSeconds, Number.isFinite(timeToStation) ? timeToStation : 0);
    return {startOffset: nowOffset, endOffset: nowOffset + seconds * 1000, duration: seconds * 1000};
}
