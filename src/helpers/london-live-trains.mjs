export const LONDON_ROUTE_ENTRY_TTS_THRESHOLD = 240;

export function selectLondonStationCandidate(candidates, stationIndexLookup) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    if (!stationIndexLookup) return candidates[0];

    for (const candidate of candidates) {
        if (candidate && candidate.station && stationIndexLookup.has(candidate.station.id)) {
            return candidate;
        }
    }
    return candidates[0];
}

export function inferLondonDirectionStep(predictions, prevIndex, nextIndexHint, sectionLength = 0) {
    let score = 0;

    if (prevIndex !== undefined && nextIndexHint !== undefined && nextIndexHint !== prevIndex) {
        return nextIndexHint > prevIndex ? 1 : -1;
    }
    for (let i = 1; i < predictions.length; i++) {
        const diff = predictions[i].stationIndex - predictions[i - 1].stationIndex;

        if (diff > 0) {
            score += 1 / diff;
        } else if (diff < 0) {
            score -= 1 / -diff;
        }
    }
    if (score) {
        return score > 0 ? 1 : -1;
    }
    if (typeof sectionLength === 'number' && sectionLength !== 0) {
        return sectionLength > 0 ? 1 : -1;
    }
    return 0;
}

export function scoreLondonRouteCandidate({
    predictions,
    currentIndexHint,
    prevIndexHint,
    nextIndexHint,
    sticky = false
}) {
    const firstPrediction = predictions[0];
    let score = predictions.length * 10;

    if (currentIndexHint !== undefined) {
        score += 200;
    }
    if (prevIndexHint !== undefined) {
        score += 120;
    }
    if (nextIndexHint !== undefined) {
        score += 120;
    }
    if (firstPrediction) {
        if (currentIndexHint !== undefined) {
            score += Math.max(0, 80 - Math.abs(firstPrediction.stationIndex - currentIndexHint) * 20);
        }
        if (prevIndexHint !== undefined) {
            score += Math.max(0, 60 - Math.abs(firstPrediction.stationIndex - prevIndexHint - 1) * 20);
            score += Math.max(0, 60 - Math.abs(firstPrediction.stationIndex - prevIndexHint + 1) * 20);
        }
        if (nextIndexHint !== undefined) {
            score += Math.max(0, 80 - Math.abs(firstPrediction.stationIndex - nextIndexHint) * 20);
        }
    }

    return score + (sticky ? 25 : 0);
}

export function estimateLondonMissingNextStopTime({
    firstPredictionTimeToStation,
    between = false,
    locationLower = ''
}) {
    let estimatedTimeToStation = 30;

    if (Number.isFinite(firstPredictionTimeToStation)) {
        estimatedTimeToStation = Math.max(
            15,
            Math.min(firstPredictionTimeToStation * 0.5, firstPredictionTimeToStation - 15)
        );
    }
    if (between) {
        return Math.max(20, Math.min(60, estimatedTimeToStation));
    }
    if (locationLower.startsWith('approaching ')) {
        return Math.max(10, Math.min(30, estimatedTimeToStation));
    }
    return estimatedTimeToStation;
}

export function selectLondonNextPrediction({
    predictions,
    predictionsByIndex,
    prevIndex,
    nextIndexHint,
    nextStation,
    directionStep,
    locationLower = '',
    between = false
}) {
    let next = null;
    let step = directionStep || 1;

    if (nextIndexHint !== undefined) {
        next = predictionsByIndex.get(nextIndexHint) || null;
        if (!next && nextStation && prevIndex !== undefined && Math.abs(nextIndexHint - prevIndex) === 1) {
            next = {
                station: nextStation,
                stationIndex: nextIndexHint,
                timeToStation: estimateLondonMissingNextStopTime({
                    firstPredictionTimeToStation: predictions[0] && predictions[0].timeToStation,
                    between,
                    locationLower
                }),
                stationName: nextStation.title.en,
                expectedArrival: NaN
            };
        }
    }

    if (!next && prevIndex !== undefined) {
        const adjacentIndex = prevIndex + step;

        next = predictionsByIndex.get(adjacentIndex) || predictions.find(p =>
            step > 0 ? p.stationIndex > prevIndex : p.stationIndex < prevIndex
        ) || null;
    }

    return next || predictions[0] || null;
}

export function findFollowingLondonPrediction({
    predictions,
    nextIndex,
    directionStep,
    nextTimeToStation
}) {
    for (const prediction of predictions) {
        if (prediction.stationIndex !== nextIndex &&
            prediction.timeToStation >= nextTimeToStation &&
            (directionStep > 0 ? prediction.stationIndex > nextIndex : prediction.stationIndex < nextIndex)) {
            return prediction;
        }
    }
    return null;
}

export function shouldSkipLondonRouteEntry({
    hasLocationHint,
    nextTimeToStation,
    threshold = LONDON_ROUTE_ENTRY_TTS_THRESHOLD
}) {
    return !hasLocationHint && Number.isFinite(nextTimeToStation) && nextTimeToStation > threshold;
}
