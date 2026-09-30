// Polling for live London data (trains, line status, station departures).
// Each run is scheduled only after the previous one has finished, so slow
// responses never pile up, and nothing is fetched while the tab is hidden:
// the poller waits and runs as soon as the page is visible again.
// Timers and visibility are injectable so this can be unit-tested.

/**
 * Tracks page visibility for pollers; one document listener serves them all.
 * @param {Document} [doc] - The document to watch.
 * @returns {Object} {isHidden(), onVisible(callback) returning an unsubscribe function}.
 */
export function createDocumentVisibility(doc = typeof document !== 'undefined' ? document : null) {
    const listeners = new Set();

    if (doc) {
        doc.addEventListener('visibilitychange', () => {
            if (!doc.hidden) {
                for (const listener of Array.from(listeners)) listener();
            }
        });
    }
    return {
        isHidden: () => !!(doc && doc.hidden),
        onVisible(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}

/**
 * Creates a poller.
 * @param {Function} task - Called on every run; may return a promise.
 * @param {Object} options - Options.
 * @param {number} options.intervalMs - Delay between the end of one run and the start of the next.
 * @param {Object} options.visibility - From createDocumentVisibility, or a stand-in in tests.
 * @param {Function} [options.setTimer] - setTimeout or a stand-in.
 * @param {Function} [options.clearTimer] - clearTimeout or a stand-in.
 * @param {Function} [options.onError] - Called with any error the task throws.
 * @returns {Object} {start(), stop(), isRunning()}.
 */
export function createPoller(task, {
    intervalMs,
    visibility,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = id => clearTimeout(id),
    onError = () => {}
}) {
    let running = false;
    let generation = 0;
    let timer = null;
    // A run came due while the tab was hidden.
    let waiting = false;
    let unsubscribe = null;

    const schedule = gen => {
        if (gen !== generation) return;
        timer = setTimer(() => {
            timer = null;
            run(gen);
        }, intervalMs);
    };

    const run = async gen => {
        if (gen !== generation) return;
        if (visibility.isHidden()) {
            waiting = true;
            return;
        }
        waiting = false;
        try {
            await task();
        } catch (e) {
            onError(e);
        }
        schedule(gen);
    };

    return {
        start() {
            this.stop();
            running = true;
            const gen = generation;
            unsubscribe = visibility.onVisible(() => {
                if (waiting) run(gen);
            });
            run(gen);
        },
        stop() {
            generation++;
            running = false;
            waiting = false;
            if (timer !== null) {
                clearTimer(timer);
                timer = null;
            }
            if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
            }
        },
        isRunning: () => running
    };
}
