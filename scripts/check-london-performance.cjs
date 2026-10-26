// Live deployment acceptance check. GPU stays the host GPU; CPU throttling and
// mobile emulation do not substitute for measurements on a physical phone.
// PLAYWRIGHT_MODULE_PATH and BROWSER_PATH can select existing installations.
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

(async () => {
    const output = process.env.VISUAL_OUTPUT || '/tmp/london-performance';
    fs.mkdirSync(output, {recursive: true});
    const url = process.env.APP_URL || 'https://feat-baker-street-interchang.mini-london-3d.pages.dev/?city=london';
    const results = {url, testedAt: new Date().toISOString(), limitations: 'Chromium mobile emulation and 4x CPU throttling on the host GPU; no physical phone or slower GPU tested.', profiles: []};
    const browser = await chromium.launch({headless: process.env.HEADED !== '1',
        ...(process.env.BROWSER_PATH ? {executablePath: process.env.BROWSER_PATH} : {})});
    try {
        for (const profile of [
            {name: 'desktop-cpu-4x', viewport: {width: 1280, height: 800}, deviceScaleFactor: 2, cpuRate: 4},
            {name: 'mobile-chromium', viewport: {width: 390, height: 844}, deviceScaleFactor: 3, isMobile: true, hasTouch: true, cpuRate: 1}
        ].filter(profile => !process.env.PROFILE || profile.name === process.env.PROFILE)) {
            const {name, cpuRate, ...options} = profile;
            const context = await browser.newContext(options);
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', {rate: cpuRate});
            const result = {name, cpuRate, ...options, errors: [], legacyRequests: 0, trainPolls: 0, topologyLoads: 0, phases: []};
            results.profiles.push(result);
            page.on('pageerror', error => result.errors.push(error.message));
            page.on('request', request => {
                const u = new URL(request.url());
                if (u.hostname === 'mini-tokyo.appspot.com') result.legacyRequests++;
                if (u.pathname === '/api/trains') result.trainPolls++;
                if (u.pathname.endsWith('/station-topology.json.gz')) result.topologyLoads++;
            });
            const started = Date.now();
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            await page.waitForFunction(() => typeof map !== 'undefined' && map.initialized && map._londonTrafficLayerReady && map._londonLiveTrafficTrains?.size > 20, null, {timeout: 90000});
            result.readyMS = Date.now() - started;
            if (!results.bundleSHA256) {
                const bundle = await context.request.get(new URL('mini-tokyo-3d.min.js', url).href);
                assert.ok(bundle.ok());
                results.bundleSHA256 = createHash('sha256').update(await bundle.body()).digest('hex');
            }
            // Use the real search UI and keep the station drawer mounted through
            // multiple live polls and an Eco/Normal round-trip.
            const search = page.getByRole('button', {name: 'Search & Filter', exact: true});
            if (!await page.getByPlaceholder('Find a station').isVisible()) await search.click();
            await page.getByPlaceholder('Find a station').fill('Baker Street');
            await page.getByRole('button', {name: 'Baker Street Station', exact: true}).click();
            const from = page.getByLabel('Starting platform', {exact: true});
            const to = page.getByLabel('Destination platform or street access', {exact: true});
            await from.selectOption('2');
            await to.selectOption('6');
            // Mobile closes search automatically after station selection; wait
            // for that transition before deciding whether a close click is needed.
            await page.waitForTimeout(800);
            if (await page.getByRole('button', {name: 'Close search panel', exact: true}).isVisible()) await page.getByRole('button', {name: 'Close search panel', exact: true}).click();
            await page.evaluate(() => {
                window.acceptanceFrames = [];
                map.map.on('render', () => window.acceptanceFrames.push(performance.now()));
            });
            for (const mode of ['normal', 'eco', 'normal']) {
                await page.evaluate(mode => map.setEcoMode(mode), mode);
                await page.waitForTimeout(5000);
                await page.evaluate(() => {window.acceptanceFrames = []; window.acceptanceStart = performance.now();});
                await page.waitForTimeout(20000);
                const sample = await page.evaluate(() => {
                    const frames = window.acceptanceFrames;
                    const gaps = frames.slice(1).map((x, i) => x - frames[i]).sort((a, b) => a - b);
                    return {mode: map.getEcoMode(), fps: frames.length / ((performance.now() - window.acceptanceStart) / 1000),
                        frameGapP95MS: gaps[Math.floor(gaps.length * .95)], visibility: document.visibilityState,
                        trains: map._londonLiveTrafficTrains.size,
                        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1};
                });
                result.phases.push(sample);
                assert.equal(sample.visibility, 'visible');
                assert.ok(sample.fps > (mode === 'eco' ? 5 : 10), `animation stalled: ${JSON.stringify(sample)}`);
                if (mode === 'eco') assert.ok(sample.fps <= 35, `Eco exceeded its redraw budget: ${sample.fps}`);
                assert.equal(sample.horizontalOverflow, false);
                assert.equal(await from.inputValue(), '2');
                assert.equal(await to.inputValue(), '6');
            }
            await to.selectOption('3');
            await page.locator('.london-topology-level-transfer').waitFor();
            await page.locator('.london-topology-controls').scrollIntoViewIfNeeded();
            result.selectBounds = await from.boundingBox();
            assert.ok(result.selectBounds.width > 100 && result.selectBounds.height >= 44);
            await page.screenshot({path: path.join(output, `${name}-light.png`)});
            await page.evaluate(() => map.toggleLondonTheme('dark'));
            await page.waitForTimeout(1500);
            await page.screenshot({path: path.join(output, `${name}-dark.png`)});
            assert.equal(result.legacyRequests, 0);
            assert.equal(result.errors.length, 0, result.errors.join('\n'));
            assert.equal(result.topologyLoads, 1, 'topology should be fetched once and reused through live polls');
            assert.ok(result.trainPolls >= 2, 'live London polling must still run');
            console.log(JSON.stringify(result));
            await context.close();
        }
    } finally {
        fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(results, null, 2));
        await browser.close();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
