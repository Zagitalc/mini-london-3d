// After build:london, exercise source-driven route/level views in a live browser.
// Supply PLAYWRIGHT_MODULE_PATH and optionally BROWSER_PATH for existing runtimes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

(async () => {
    const output = process.env.VISUAL_OUTPUT || '/tmp/london-levels';
    fs.mkdirSync(output, {recursive: true});
    const results = [];
    const url = process.env.APP_URL || 'http://127.0.0.1:3000/?city=london';
    const browser = await chromium.launch({headless: process.env.HEADED !== '1',
        ...(process.env.BROWSER_PATH ? {executablePath: process.env.BROWSER_PATH} : {})});
    try {
        for (const mobile of [false, true]) {
            const context = await browser.newContext({
                viewport: mobile ? {width: 390, height: 844} : {width: 1280, height: 900},
                deviceScaleFactor: mobile ? 3 : 2, isMobile: mobile, hasTouch: mobile
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            await page.waitForFunction(() => typeof map !== 'undefined' && map.initialized && map._londonTrafficLayerReady, null, {timeout: 60000});
            if (!await page.getByPlaceholder('Find a station').isVisible()) await page.getByRole('button', {name: 'Search & Filter', exact: true}).click();
            await page.getByPlaceholder('Find a station').fill('Baker Street');
            await page.getByRole('button', {name: 'Baker Street Station', exact: true}).click();
            const from = page.getByLabel('Starting platform', {exact: true});
            const to = page.getByLabel('Destination platform or street access', {exact: true});
            await from.waitFor();
            await page.waitForTimeout(800);
            if (await page.getByRole('button', {name: 'Close search panel', exact: true}).isVisible()) await page.getByRole('button', {name: 'Close search panel', exact: true}).click();
            const origins = await from.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
            let routes = 0, levelSelections = 0;
            for (const origin of origins) {
                await from.selectOption(origin);
                const destinations = await to.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
                for (const destination of destinations) {
                    await to.selectOption(destination);
                    const result = page.locator('.london-topology-result');
                    assert.ok(await result.locator('.london-topology-level-sequence li').count());
                    assert.deepEqual((await result.locator('.london-topology-pin text').allTextContents()).sort(), ['D', 'S']);
                    const select = page.getByLabel('Route level', {exact: true});
                    const levels = await select.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
                    for (const level of levels) {
                        await select.selectOption(level);
                        const correct = await result.locator('[data-route-levels]').evaluateAll((nodes, selected) => nodes.every(node =>
                            node.classList.contains('is-level-muted') === (selected !== 'all' && !node.dataset.routeLevels.split(' ').includes(selected))
                        ), level);
                        assert.ok(correct, `${origin} → ${destination}, level ${level}`);
                        levelSelections++;
                    }
                    await select.selectOption('all');
                    routes++;
                }
            }
            assert.equal(routes, 88);
            await from.selectOption('2');
            for (const [destination, expected] of [['7', ['Stairs up']], ['5', ['Escalator up', 'Escalator up', 'Stairs down', 'Stairs down', 'Stairs down']], ['6', ['Walkway']]]) {
                await to.selectOption(destination);
                assert.deepEqual(await page.locator('.london-topology-level-sequence strong').allTextContents(), expected);
            }
            await to.selectOption('5');
            await page.getByLabel('Route level', {exact: true}).selectOption('-3');
            assert.equal(await page.locator('.london-topology-route-segment:not(.is-level-muted)').count(), 3);
            await page.getByLabel('Route level', {exact: true}).scrollIntoViewIfNeeded();
            const profile = mobile ? 'mobile' : 'desktop';
            for (const theme of ['light', 'dark']) {
                await page.evaluate(theme => map.toggleLondonTheme(theme), theme);
                await page.waitForTimeout(800);
                await page.screenshot({path: path.join(output, `${profile}-${theme}-levels.png`)});
                await page.locator('.london-topology-map').scrollIntoViewIfNeeded();
                await page.screenshot({path: path.join(output, `${profile}-${theme}-map.png`)});
                await page.getByLabel('Route level', {exact: true}).scrollIntoViewIfNeeded();
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            assert.deepEqual(errors, []);
            results.push({profile, routes, levelSelections, errors});
            await context.close();
        }
    } finally {
        fs.writeFileSync(path.join(output, 'levels.json'), JSON.stringify({url, results}, null, 2));
        await browser.close();
    }
    console.log(JSON.stringify(results));
})().catch(error => {console.error(error); process.exitCode = 1;});
