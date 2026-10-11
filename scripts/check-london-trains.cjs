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
        for (const [station, stationName] of [['baker-street', 'Baker Street'], ['barbican', 'Barbican']]) {
            // Centre on an actual platform, which can be outside the street-address
            // viewport at maximum zoom.
            const centre = await page.evaluate(name => {
                const train = visualTrains.find(t => t.id.includes(name));
                const coord = map.trafficLayer.getObjectPosition(train).coord;
                return [coord.lng, coord.lat];
            }, stationName);
            const maxZoom = await page.evaluate(() => map.map.getMaxZoom());
            for (const [zoom, pitch, bearing] of [[11, 0, 0], [13, 0, 0], [14, 0, 0], [15, 0, 0], [15.5, 35, -70], [16, 45, 0], [17, 0, 0], [18, 60, 110], [19, 0, 0], [20, 0, 0], [maxZoom, 0, 0], [18, 0, 0], [14, 45, -70]]) {
                for (const theme of ['light', 'dark']) {
                    await page.evaluate(({centre, zoom, pitch, bearing, theme}) => {
                        map.map.jumpTo({center: centre, zoom, pitch, bearing});
                        map.toggleLondonTheme(theme);
                    }, {centre, zoom, pitch, bearing, theme});
                    await page.waitForTimeout(650);
                    const state = await page.evaluate(() => {
                        const layer = map.trafficLayer;
                        const points = [...(layer.londonTrainScreenPoints || new Map())];
                        const u = layer.ogCarMeshSet.uniforms;
                        const project = p => {
                            layer.londonLayoutPoint.copy(p).project(layer.context.camera);
                            const v = layer.londonLayoutPoint;
                            return {x: (v.x + 1) / 2 * map.map.transform.width, y: (1 - v.y) / 2 * map.map.transform.height};
                        };
                        const anchors = new Map(visualTrains.map(t => {
                            const pos = layer.getObjectPosition(t);
                            const anchor = map.getModelPosition(pos.coord, pos.altitude);
                            const zoom0 = u.zoom.value + Math.log2(u.cameraZ.value / Math.abs(u.cameraZ.value - anchor.z));
                            const scale = 2 ** (14 - Math.max(13, Math.min(19, zoom0))) * u.modelScale.value * 100;
                            anchor.z += u.carLift.value * scale;
                            const centre = project(anchor);
                            const angle = -pos.bearing * Math.PI / 180;
                            const variation = 1 + t.instanceID % 256 / 256 * 0.03;
                            // Rendered mesh endpoints, including the shared shader zoom clamp.
                            const ends = [-1, 1].map(sign => project({x: anchor.x - Math.sin(angle) * sign * 0.64 * scale * variation,
                                y: anchor.y + Math.cos(angle) * sign * 0.64 * scale * variation, z: anchor.z}));
                            const point = layer.londonTrainScreenPoints.get(t.instanceID) || centre;
                            const ndcX = point.x / map.map.transform.width * 2 - 1;
                            const ndcY = 1 - point.y / map.map.transform.height * 2;
                            const near = layer.londonLayoutPoint.clone().set(ndcX, ndcY, -1).unproject(layer.context.camera);
                            const far = near.clone().set(ndcX, ndcY, 1).unproject(layer.context.camera);
                            const fraction = (anchor.z - near.z) / (far.z - near.z);
                            const hit = near.clone().lerp(far, fraction);
                            const displacementMetres = Math.hypot(hit.x - anchor.x, hit.y - anchor.y) / layer.baseModelScale;
                            return [t.instanceID, {anchor: centre, displacementMetres, length: Math.hypot(ends[0].x - ends[1].x, ends[0].y - ends[1].y)}];
                        }));
                        const rail = map.map.style.getLayer('london-railways');
                        return {zoom: map.getZoom(), shaderZoom: layer.ogCarMeshSet.uniforms.zoom.value,
                            sharedGeometry: layer.ogCarMeshSet.mesh.geometry === layer.ogCarMeshSet.pickingMesh.geometry,
                            points: points.map(([id, point]) => ({id, ...point, ...anchors.get(id), picked: layer.pickObject('ground', point)?.instanceID,
                                offset: layer.londonTrainOffsets.get(id)})),
                            instances: visualTrains.map(t => ({id: t.id, instanceID: t.instanceID})),
                            counts: [layer.ogCarMeshSet.geometry.instanceCount, layer.ugCarMeshSet.geometry.instanceCount], triangles: layer.ogCarMeshSet.geometry.index.count / 3, lineWidth: rail.paint.get('line-width').evaluate({zoom: map.getZoom()}, {properties: {laneOffset: 0}}), modelScaleFactor: u.modelScale.value / layer.baseModelScale};
                    });
                    assert.equal(state.shaderZoom, state.zoom, 'train camera scale must follow map zoom');
                    assert.equal(state.sharedGeometry, true);
                    assert.equal(state.triangles, 396);
                    assert.deepEqual(state.instances, fixtures, 'one stable instance per logical train');
                    assert.ok(state.points.length > 0);
                    if (zoom >= 16) assert.ok(state.lineWidth >= 4.5 && state.lineWidth <= 5.5);
                    fs.writeFileSync(path.join(output, 'latest-state.json'), JSON.stringify({station, zoom, pitch, theme, ...state}, null, 2));
                    await page.screenshot({path: path.join(output, 'latest-view.png')});
                    for (const point of state.points) {
                        assert.ok(Math.hypot(point.offset.x, point.offset.y) <= 40.001);
                        const displacement = Math.hypot(point.x - point.anchor.x, point.y - point.anchor.y);
                        assert.ok(displacement <= 40.001);
                        assert.ok(point.displacementMetres <= 20.05, `train moved too far from its anchor: ${point.displacementMetres}m`);
                        if (zoom <= 15) assert.ok(displacement < 0.001, 'overview trains must stay on their true anchors');
                        const picked = state.points.find(p => p.id === point.picked);
                        assert.ok(picked && Math.hypot(picked.x - point.x, picked.y - point.y) < 0.01,
                            'picking must follow the displayed centre; coincident overview trains may share a hit');
                        if (zoom >= 17 && pitch === 0) assert.ok(point.length >= 30 && point.length <= 55,
                            `close train footprint must remain readable and bounded: ${point.length}`);
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
            return {id: map.trafficLayer.pickObject('ground', p).instanceID, ...p};
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
            map.map.jumpTo({zoom: 14});
            await new Promise(resolve => setTimeout(resolve, 70));
            const overviewOffset = layer.londonTrainOffsets.get(id);
            await removed;
            await new Promise(resolve => setTimeout(resolve, 200));
            return {before, during, after: readOpacity(), offset, retainedOffset, overviewOffset};
        });
        assert.ok(fade.before > 0.8 && fade.during > 0 && fade.during < fade.before);
        assert.equal(fade.after, 0, 'lifecycle fade must reach zero');
        assert.deepEqual(fade.retainedOffset, fade.offset, 'fading train must keep its visual slot at the same zoom');
        assert.equal(Math.hypot(fade.overviewOffset.x, fade.overviewOffset.y), 0, 'zooming out must anchor fading trains too');
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
