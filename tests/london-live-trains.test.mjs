import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findFollowingLondonPrediction,
    inferLondonDirectionStep,
    LONDON_ROUTE_ENTRY_TTS_THRESHOLD,
    scoreLondonRouteCandidate,
    selectLondonNextPrediction,
    selectLondonStationCandidate,
    shouldSkipLondonRouteEntry
} from '../src/helpers/london-live-trains.mjs';

test('selectLondonStationCandidate prefers the station on the active railway', () => {
    const trunkCandidate = { station: { id: 'tfl.metropolitan.baker-street' } };
    const branchCandidate = { station: { id: 'tfl.jubilee.baker-street' } };
    const stationIndexLookup = new Map([[branchCandidate.station.id, 4]]);

    assert.equal(
        selectLondonStationCandidate([trunkCandidate, branchCandidate], stationIndexLookup),
        branchCandidate
    );
});

test('inferLondonDirectionStep uses the location hint before sparse predictions', () => {
    const predictions = [
        { stationIndex: 11, timeToStation: 45 },
        { stationIndex: 15, timeToStation: 180 }
    ];

    assert.equal(inferLondonDirectionStep(predictions, 9, 10, 0), 1);
    assert.equal(inferLondonDirectionStep(predictions, 10, 9, 0), -1);
});

test('scoreLondonRouteCandidate favors the branch that matches the current location hint', () => {
    const trunkScore = scoreLondonRouteCandidate({
        predictions: [
            { stationIndex: 10, timeToStation: 40 },
            { stationIndex: 11, timeToStation: 90 },
            { stationIndex: 12, timeToStation: 150 }
        ]
    });
    const branchScore = scoreLondonRouteCandidate({
        predictions: [
            { stationIndex: 10, timeToStation: 40 },
            { stationIndex: 11, timeToStation: 90 }
        ],
        prevIndexHint: 9,
        nextIndexHint: 10
    });

    assert.ok(branchScore > trunkScore);
});

test('selectLondonNextPrediction synthesizes the immediate next stop when TfL skips it', () => {
    const nextStation = {
        id: 'tfl.central.marble-arch',
        title: { en: 'Marble Arch' }
    };
    const predictions = [
        { stationIndex: 7, timeToStation: 90, stationName: 'Lancaster Gate', expectedArrival: NaN }
    ];
    const predictionsByIndex = new Map(predictions.map(prediction => [prediction.stationIndex, prediction]));

    const next = selectLondonNextPrediction({
        predictions,
        predictionsByIndex,
        prevIndex: 5,
        nextIndexHint: 6,
        nextStation,
        directionStep: 1,
        between: true,
        locationLower: 'between bond street and marble arch'
    });

    assert.equal(next.stationIndex, 6);
    assert.equal(next.station, nextStation);
    assert.equal(next.timeToStation, 45);
});

test('findFollowingLondonPrediction only follows the train direction', () => {
    const following = findFollowingLondonPrediction({
        predictions: [
            { stationIndex: 6, timeToStation: 60 },
            { stationIndex: 9, timeToStation: 150 },
            { stationIndex: 5, timeToStation: 210 }
        ],
        nextIndex: 7,
        directionStep: 1,
        nextTimeToStation: 30
    });

    assert.deepEqual(following, { stationIndex: 9, timeToStation: 150 });
});

test('shouldSkipLondonRouteEntry ignores off-route trains until they reach the rendered geometry', () => {
    assert.equal(
        shouldSkipLondonRouteEntry({
            hasLocationHint: false,
            nextTimeToStation: LONDON_ROUTE_ENTRY_TTS_THRESHOLD + 1
        }),
        true
    );
    assert.equal(
        shouldSkipLondonRouteEntry({
            hasLocationHint: true,
            nextTimeToStation: LONDON_ROUTE_ENTRY_TTS_THRESHOLD + 300
        }),
        false
    );
});
