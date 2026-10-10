import test from 'node:test';
import assert from 'node:assert/strict';

import {londonPlatformLabel, londonTrainEtaLabel, londonTrainPopupHTML} from '../src/helpers/london-train-popup.mjs';

test('the countdown reads Due under 45 seconds, then whole minutes', () => {
    assert.equal(londonTrainEtaLabel(NaN), null);
    assert.equal(londonTrainEtaLabel(-5000), 'Due', 'a late train is still due');
    assert.equal(londonTrainEtaLabel(44000), 'Due');
    assert.equal(londonTrainEtaLabel(50000), '1 min');
    assert.equal(londonTrainEtaLabel(4 * 60000 + 20000), '4 min');
});

test('platform names are tidied, and placeholders dropped', () => {
    assert.equal(londonPlatformLabel('Westbound - Platform 1'), 'Westbound · Platform 1');
    assert.equal(londonPlatformLabel('Platform 3'), 'Platform 3');
    assert.equal(londonPlatformLabel('null'), '');
    assert.equal(londonPlatformLabel('Platform Unavailable'), '');
    assert.equal(londonPlatformLabel(undefined), '');
});

test('the card shows line, destination, next stop with platform and countdown, previous stop and train', () => {
    const html = londonTrainPopupHTML({
        lineTitle: 'Victoria', colors: '#0098D4', destination: 'Brixton', trainNumber: '201',
        next: {name: 'Oxford Circus', time: '18:04', platform: 'Southbound - Platform 5', etaLabel: '2 min'},
        previous: {name: 'Warren Street', time: '18:02'}
    });
    assert.match(html, /<strong>Victoria<\/strong><span>to Brixton<\/span>/);
    assert.match(html, /background-color:#0098D4/);
    assert.match(html, /<strong>Oxford Circus<\/strong><span class="london-train-popup-meta">Southbound · Platform 5<\/span>/);
    assert.match(html, /<strong>2 min<\/strong><span>18:04<\/span>/);
    assert.match(html, /Warren Street · 18:02/);
    assert.match(html, /Train 201/);
});

test('missing parts are left out, and text is escaped', () => {
    const html = londonTrainPopupHTML({lineTitle: 'H&C <b>', colors: ['#F3A9BB', '#9B0056']});
    assert.match(html, /H&amp;C &lt;b&gt;/);
    assert.equal((html.match(/background-color:/g) || []).length, 2);
    for (const part of ['london-train-popup-next', 'london-train-popup-previous', 'london-train-popup-footer', '<span>to ']) {
        assert.ok(!html.includes(part), `${part} is left out`);
    }
    assert.ok(!londonTrainPopupHTML({lineTitle: 'X', next: {name: 'A'}}).includes('london-train-popup-eta'), 'no countdown block without a time');
});
