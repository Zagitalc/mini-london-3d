// Records what the live-train code received and decided, so jumps and
// reversals seen on the real site can be replayed and explained offline.
// Turned on with ?record=trains; nothing is recorded otherwise.
//
// A recording keeps the last few minutes of polls. Each poll holds the
// arrivals per line exactly as the map used them, plus one decision per
// train: its state before and after, the renderer command and the direction
// it was drawn in. Events note when the tab was hidden or shown, and when
// the person pressed Mark because they saw something wrong.

import {compactArrival} from './london-train-feed.mjs';

export const TRAIN_RECORDING_SCHEMA = 1;

// The parts of a train state that explain movement on the map.
function summariseState(state) {
    if (!state) return null;
    return {
        state: state.state,
        routeId: state.routeId,
        direction: state.direction,
        stationId: state.stationId,
        sectionIndex: state.sectionIndex,
        sectionProgress: Number.isFinite(state.sectionProgress) ? Math.round(state.sectionProgress * 1000) / 1000 : state.sectionProgress,
        stalePhase: state.stalePhase,
        pendingRouteId: state.pendingRouteId
    };
}

/**
 * Creates a recorder.
 * @param {Object} [options] - Options.
 * @param {number} [options.maxAgeMs] - Polls older than this are dropped.
 * @param {Function} [options.now] - Clock, for tests.
 * @returns {Object} The recorder.
 */
export function createTrainRecorder({maxAgeMs = 10 * 60000, now = () => Date.now()} = {}) {
    const polls = [];
    const events = [];
    const startedAt = now();

    const prune = () => {
        const cutoff = now() - maxAgeMs;
        while (polls.length && polls[0].timestamp < cutoff) polls.shift();
        while (events.length && events[0].timestamp < cutoff) events.shift();
    };
    const currentPoll = timestamp => {
        for (let i = polls.length - 1; i >= 0; i--) {
            if (polls[i].timestamp === timestamp) return polls[i];
        }
        return null;
    };

    return {
        /**
         * Stores one poll's input.
         * @param {Object} poll - {timestamp, byLine: Map of lineId to {arrivals, success, observationsComplete}}.
         */
        recordPoll({timestamp, byLine}) {
            const lines = {};
            for (const [lineId, result] of byLine || []) {
                lines[lineId] = {
                    success: !!(result && result.success),
                    observationsComplete: !!(result && result.observationsComplete),
                    arrivals: (result && Array.isArray(result.arrivals) ? result.arrivals : []).map(compactArrival)
                };
            }
            polls.push({timestamp, lines, decisions: []});
            prune();
        },

        /**
         * Stores what happened to one train in a poll.
         * @param {number} timestamp - The poll's timestamp.
         * @param {Object} decision - {trainKey, lineId, vehicleId, kind, previousState, nextState, command, diagnostics, drawnRoute, drawnDirection, progress}.
         */
        recordDecision(timestamp, decision) {
            const poll = currentPoll(timestamp);
            if (!poll) return;
            poll.decisions.push({
                ...decision,
                previousState: summariseState(decision.previousState),
                nextState: summariseState(decision.nextState),
                progress: Number.isFinite(decision.progress) ? Math.round(decision.progress * 1000) / 1000 : decision.progress
            });
        },

        /**
         * Notes an event: tab visibility, or a mark from the person recording.
         * @param {string} type - 'hidden', 'visible' or 'mark'.
         * @param {Object} [detail] - Extra information, such as the tracked train.
         */
        recordEvent(type, detail = {}) {
            events.push({timestamp: now(), type, ...detail});
            prune();
        },

        pollCount: () => polls.length,
        markCount: () => events.filter(event => event.type === 'mark').length,

        /**
         * The recording as plain JSON, with a summary of suspect moments.
         * @param {Object} [meta] - Context to include, such as the page URL.
         * @returns {Object} The recording.
         */
        toJSON(meta = {}) {
            prune();
            const recording = {
                schema: TRAIN_RECORDING_SCHEMA,
                startedAt: new Date(startedAt).toISOString(),
                savedAt: new Date(now()).toISOString(),
                ...meta,
                events: events.slice(),
                polls: polls.slice()
            };
            return {...recording, summary: summariseTrainRecording(recording)};
        }
    };
}

/**
 * Finds the moments in a recording most likely to look wrong on the map.
 * @param {Object} recording - From recorder.toJSON().
 * @returns {Object} Counts per kind, and up to 50 examples with times and trains.
 */
export function summariseTrainRecording(recording) {
    const counts = {polls: 0, decisions: 0, rebinds: 0, directionFlips: 0, backwardMoves: 0, multiSectionJumps: 0, reappeared: 0, discarded: 0};
    const examples = [];
    const lastSeen = new Map();
    const note = (kind, poll, decision, extra = {}) => {
        if (examples.length < 50) {
            examples.push({kind, at: new Date(poll.timestamp).toISOString(), trainKey: decision.trainKey, lineId: decision.lineId, ...extra});
        }
    };

    for (const poll of (recording && recording.polls) || []) {
        counts.polls++;
        for (const decision of poll.decisions || []) {
            counts.decisions++;
            const before = decision.previousState;
            const after = decision.nextState;
            const previousSighting = lastSeen.get(decision.trainKey);

            if (decision.command === 'rebind') {
                counts.rebinds++;
                note('rebind', poll, decision, {from: before && before.routeId, to: after && after.routeId});
            }
            if (decision.kind === 'discard') {
                counts.discarded++;
                note('discard', poll, decision);
            }
            // A turn on the same route; a change of route shows up as a rebind.
            if (previousSighting && previousSighting.drawnDirection !== undefined && decision.drawnDirection !== undefined &&
                previousSighting.drawnRoute === decision.drawnRoute && previousSighting.drawnDirection !== decision.drawnDirection) {
                counts.directionFlips++;
                note('direction-flip', poll, decision, {from: previousSighting.drawnDirection, to: decision.drawnDirection});
            }
            if (before && after && before.routeId === after.routeId &&
                Number.isFinite(before.sectionIndex) && Number.isFinite(after.sectionIndex)) {
                const sections = after.sectionIndex - before.sectionIndex;
                if (Math.abs(sections) > 1) {
                    counts.multiSectionJumps++;
                    note('multi-section-jump', poll, decision, {sections});
                } else if (sections === 0 && after.sectionProgress < before.sectionProgress - 0.02) {
                    counts.backwardMoves++;
                    note('backward-move', poll, decision, {from: before.sectionProgress, to: after.sectionProgress});
                }
            }
            if (previousSighting && previousSighting.state === 'expired' && after && after.state !== 'expired') {
                counts.reappeared++;
                note('reappeared', poll, decision);
            }
            const drawn = decision.drawnDirection !== undefined ? decision : previousSighting || {};
            lastSeen.set(decision.trainKey, {drawnRoute: drawn.drawnRoute, drawnDirection: drawn.drawnDirection, state: after && after.state});
        }
    }
    return {counts, examples};
}
