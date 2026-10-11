// Run against `npm run serve` after build:london. Playwright can be supplied by
// PLAYWRIGHT_MODULE_PATH; BROWSER_PATH optionally selects an installed Chromium.
// Uses real route assets and fixed train fixtures, with empty basemap tiles so
// camera/mesh/selection regressions do not depend on a Mapbox token or TfL feeds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

(async () => {
    const output = process.env.VISUAL_OUTPUT || '/tmp/london-train-visuals';
    fs.mkdirSync(output, {recursive: true});
    const browser = await chromium.launch({headless: true,
        ...(process.env.BROWSER_PATH ? {executablePath: process.env.BROWSER_PATH} : {})});
    try {
        const page = await browser.newPage({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error' && /shader|WebGL|THREE|TypeError|ReferenceError/i.test(message.text())) errors.push(message.text());
        });
        await page.route('**/*.vector.pbf*', route => route.fulfill({body: Buffer.alloc(0)}));
        await page.route('**/config.local.js', route => route.fulfill({contentType: 'text/javascript', body: ''}));
        await page.route('**/api/trains*', route => route.fulfill({status: 404, body: '{}'}));
        await page.route('**/api.tfl.gov.uk/**', route => route.fulfill({contentType: 'application/json', body: '[]'}));
        await page.route('**/mini-tokyo.appspot.com/**', route => route.fulfill({contentType: 'application/json', body: '[]'}));
        await page.goto(process.env.APP_URL || 'http://127.0.0.1:3000/?city=london', {waitUntil: 'domcontentloaded'});
        await page.waitForFunction(() => typeof map !== 'undefined' && map._londonTrafficLayerReady);
        const fixtures = await page.evaluate(() => {
            map.stopLondonLiveTrains();
            map.clearLondonLiveTrafficTrains();
            map._londonSearchPanelOpen = false;
            map.renderLondonSearchPanel();
            window.visualTrains = [];
            for (const name of ['Baker Street', 'Barbican']) {
                const lines = new Set();
                for (const railway of map.railways.getAll()) {
                    const index = railway.stations.findIndex(s => s.title.en.includes(name));
                    if (index < 1 || index >= railway.stations.length - 1 || lines.has(railway.lineId)) continue;
                    lines.add(railway.lineId);
                    for (const direction of [-1, 1]) {
                        const train = {type: 'train', id: `visual-${name}-${railway.id}-${direction}`, n: 'Test',
                            r: railway, d: railway.ascending, liveTfL: true, sectionIndex: index, sectionLength: direction};
                        map.trafficLayer.addObject(train);
                        // A zero-progress dwell with a valid direction; unchanged during captures.
                        map.trafficLayer.updateObject(train, map.trafficLayer.computeRenderer.uniforms.timeOffset.value + 100000, 100000, 50000, 4e-10, 50000, 4e-10);
                        visualTrains.push(train);
                    }
                }
            }
            return visualTrains.map(t => ({id: t.id, instanceID: t.instanceID}));
        });
        assert.ok(fixtures.length >= 10, `expected busy interchange fixtures; got ${fixtures.length}`);
        const checks = [];
        for (const [station, centre] of [['baker-street', [-0.1571, 51.5226]], ['barbican', [-0.0978, 51.5202]]]) {
            for (const [zoom, pitch, bearing] of [[14, 0, 0], [16, 45, 0], [18, 60, 110]]) {
                for (const theme of ['light', 'dark']) {
                    await page.evaluate(({centre, zoom, pitch, bearing, theme}) => {
                        map.map.jumpTo({center: centre, zoom, pitch, bearing});
                        map.toggleLondonTheme(theme);
                    }, {centre, zoom, pitch, bearing, theme});
                    await page.waitForTimeout(1200);
                    const state = await page.evaluate(() => {
                        const layer = map.trafficLayer;
                        const points = [...(layer.londonTrainScreenPoints || new Map())];
                        return {zoom: map.getZoom(), shaderZoom: layer.ogCarMeshSet.uniforms.zoom.value,
                            sharedGeometry: layer.ogCarMeshSet.mesh.geometry === layer.ogCarMeshSet.pickingMesh.geometry,
                            points: points.map(([id, point]) => ({id, ...point, picked: layer.pickObject('ground', point)?.instanceID,
                                offset: layer.londonTrainOffsets.get(id)})),
                            instances: visualTrains.map(t => ({id: t.id, instanceID: t.instanceID})),
                            counts: [layer.ogCarMeshSet.geometry.instanceCount, layer.ugCarMeshSet.geometry.instanceCount], triangles: layer.ogCarMeshSet.geometry.index.count / 3};
                    });
                    assert.equal(state.shaderZoom, state.zoom, 'train camera scale must follow map zoom');
                    assert.equal(state.sharedGeometry, true);
                    assert.equal(state.triangles, 396);
                    assert.deepEqual(state.instances, fixtures, 'one stable instance per logical train');
                    assert.ok(state.points.length > 0);
                    fs.writeFileSync(path.join(output, 'latest-state.json'), JSON.stringify({station, zoom, pitch, theme, ...state}, null, 2));
                    await page.screenshot({path: path.join(output, 'latest-view.png')});
                    for (const point of state.points) {
                        assert.ok(Math.hypot(point.offset.x, point.offset.y) <= 40.001);
                        assert.equal(point.picked, point.id, 'each displaced train must be individually selectable');
                    }
                    const name = `${station}-${theme}-z${zoom}-p${pitch}-b${bearing}`;
                    await page.screenshot({path: path.join(output, `${name}.png`)});
                    checks.push({name, ...state});
                }
            }
        }
        // Resize and a continuous camera move exercise the real Mapbox listeners.
        await page.setViewportSize({width: 900, height: 700});
        await page.evaluate(() => map.map.easeTo({center: [-0.1571, 51.5226], zoom: 15.5, pitch: 35, bearing: -70, duration: 600}));
        await page.waitForTimeout(1000);
        assert.equal(await page.evaluate(() => map.trafficLayer.ogCarMeshSet.uniforms.zoom.value), 15.5);
        // Rendered centres must also work through the pointer/hover path.
        const target = await page.evaluate(() => {
            const entries = [...map.trafficLayer.londonTrainScreenPoints];
            const [id, p] = entries.find(([, p]) => p.x > 100 && p.x < 800 && p.y > 160 && p.y < 600);
            return {id, ...p};
        });
        await page.mouse.move(target.x, target.y);
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => map.markedObject?.instanceID), target.id);
        await page.mouse.click(target.x, target.y);
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => map.trackedObject?.instanceID), target.id);
        await page.evaluate(() => {map.trackObject(); map.markObject();});
        const movement = await page.evaluate(async () => {
            const layer = map.trafficLayer;
            const train = visualTrains[0];
            const before = layer.getObjectPosition(train).coord;
            layer.updateObject(train, layer.computeRenderer.uniforms.timeOffset.value, 10000, 5000, 4e-8, 5000, 4e-8);
            let after, distance;
            for (let i = 0; i < 20; i++) {
                await new Promise(resolve => setTimeout(resolve, 150));
                after = layer.getObjectPosition(train).coord;
                distance = Math.hypot(after.lng - before.lng, after.lat - before.lat);
                if (distance > 0.000001) break;
            }
            return {distance, before, after};
        });
        assert.ok(movement.distance > 0.000001, `trains must still move along their real route: ${JSON.stringify(movement)}`);
        const fade = await page.evaluate(async () => {
            const layer = map.trafficLayer;
            const train = visualTrains[3];
            const id = train.instanceID;
            const readOpacity = () => {
                const renderer = layer.context.renderer;
                const compute = layer.computeRenderer;
                const target = compute.dataVariable[compute.currentTextureIndex];
                const previous = renderer.getRenderTarget();
                const gl = renderer.getContext();
                const pixel = new Float32Array(4);
                renderer.setRenderTarget(target);
                gl.readBuffer(gl.COLOR_ATTACHMENT1);
                gl.readPixels(id % target.width, Math.floor(id / target.width), 1, 1, gl.RGBA, gl.FLOAT, pixel);
                gl.readBuffer(gl.COLOR_ATTACHMENT0);
                renderer.setRenderTarget(previous);
                renderer.resetState();
                return pixel[3];
            };
            const before = readOpacity();
            const offset = layer.londonTrainOffsets.get(id);
            const removed = layer.removeObject(train);
            await new Promise(resolve => setTimeout(resolve, 200));
            const during = readOpacity();
            const retainedOffset = layer.londonTrainOffsets.get(id);
            await removed;
            await new Promise(resolve => setTimeout(resolve, 200));
            return {before, during, after: readOpacity(), offset, retainedOffset};
        });
        assert.ok(fade.before > 0.8 && fade.during > 0 && fade.during < fade.before);
        assert.equal(fade.after, 0, 'lifecycle fade must reach zero');
        assert.deepEqual(fade.retainedOffset, fade.offset, 'fading train must keep its visual slot');
        const performanceCheck = await page.evaluate(async () => {
            const layer = map.trafficLayer;
            let count = 0;
            for (const railway of map.railways.getAll()) {
                for (let index = 1; index < railway.stations.length - 1 && count < 400; index++) {
                    const train = {type: 'train', id: `load-${count++}`, r: railway, sectionIndex: index, sectionLength: 1};
                    layer.addObject(train);
                    layer.updateObject(train, layer.computeRenderer.uniforms.timeOffset.value + 100000, 100000, 50000, 4e-10, 50000, 4e-10);
                }
            }
            map.map.jumpTo({center: [-0.1276, 51.5074], zoom: 10, pitch: 0});
            const original = layer.layoutLondonTrains;
            const timings = [];
            layer.layoutLondonTrains = function() {
                const start = performance.now();
                original.call(this);
                timings.push(performance.now() - start);
            };
            await new Promise(resolve => setTimeout(resolve, 2000));
            layer.layoutLondonTrains = original;
            timings.sort((a, b) => a - b);
            return {fleet: layer.objects.size, samples: timings.length, medianMs: timings[Math.floor(timings.length / 2)],
                p95Ms: timings[Math.floor(timings.length * 0.95)]};
        });
        assert.ok(performanceCheck.samples >= 10);
        assert.ok(performanceCheck.p95Ms < 16.7, `layout exceeded a frame budget: ${JSON.stringify(performanceCheck)}`);
        assert.deepEqual(errors, [], 'no JavaScript/WebGL/shader errors');
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({fixtures, checks, movement, fade, performanceCheck, errors}, null, 2));
        console.log(`PASS: ${checks.length} theme/zoom/pitch/bearing views, ${fixtures.length} stable train instances, resize, hover, tracking, movement and fade. Layout p95: ${performanceCheck.p95Ms.toFixed(1)}ms for ${performanceCheck.fleet} trains. Screenshots: ${output}`);
    } finally {
        await browser.close();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
