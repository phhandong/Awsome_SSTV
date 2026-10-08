import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';
import { REFRESH_INTERVAL } from './js/tracking-store.js';

const root = process.cwd();
const iss = await readFile('test-fixtures/iss.json', 'utf8');
const amateur = JSON.parse(await readFile('test-fixtures/amateur.json', 'utf8'));
const transponders = await readFile('test-fixtures/transponders.json', 'utf8');
const jamxTle = `JAMX01(2026-195F 100470)
1 A0470U 26195F   26280.19609334  .00004321  00000-0  26865-3 0  9997
2 A0470  97.5407 353.3186 0013970 123.6964 236.5599 15.10085176  6509`;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
await mkdir('test-artifacts', { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/Awsome_SSTV\//, '/');
    const file = resolve(root, path.replace(/^\//, '') || 'index.html'), rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('invalid path');
    res.setHeader('Content-Type', mime[extname(file)] || 'text/plain');
    res.setHeader('Cache-Control', 'no-store'); res.end(await readFile(file));
  } catch (_) { res.statusCode = 404; res.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const pick = id => `[data-satellite-id="${id}"]`;
const star = id => `[data-favorite-id="${id}"]`;
async function openPicker(page) { await page.click('#satelliteSelect'); await page.waitForSelector('#satelliteDialog[open]'); }
async function closePicker(page) { await page.keyboard.press('Escape'); await page.waitForSelector('#satelliteDialog:not([open])', { state: 'attached' }); }
async function contextWithFeeds() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
  const feed = { iss: 0, amateur: 0, trans: 0, body: JSON.stringify(amateur), transBody: transponders };
  await context.route('https://tledata.xanyi.eu.org/**', route => {
    const isTrans = new URL(route.request().url()).pathname.endsWith('/trans.json');
    if (isTrans) feed.trans++; else { feed.iss++; feed.amateur++; }
    return route.fulfill({ status: 200, contentType: 'application/json', body: isTrans ? feed.transBody : feed.body });
  });
  return { context, feed };
}
async function clock(page) { await page.clock.install({ time: new Date('2026-10-06T08:00:00Z') }); }

try {
  for (const prefix of ['/Awsome_SSTV/', '/']) {
    const { context, feed } = await contextWithFeeds();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.catalogMicStarts = 0;
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => {
        window.catalogMicStarts++; window.catalogStream = await original(...args); return window.catalogStream;
      };
    });
    await clock(page); await page.goto(base + prefix);
    await page.waitForFunction(() => document.getElementById('orbitDataStatus').textContent.includes('已更新'));
    assert.equal(feed.iss, 1); assert.equal(feed.amateur, 1, 'one complete TLE snapshot contains ISS and directory');
    await page.click('#trackTab');
    await page.waitForFunction(() => /已更新|已读取缓存/.test(document.getElementById('catalogDataStatus').textContent));
    assert.equal(feed.amateur, 1);
    const claims = await page.evaluate(async () => {
      const { TrackingStore } = await import('./js/tracking-store.js');
      const stores = [new TrackingStore(indexedDB), new TrackingStore(indexedDB)];
      return Promise.all(stores.map(store => store.claimRequest(Date.now(), 'test:concurrent-directory')));
    });
    assert.equal(claims.filter(Boolean).length, 1, 'IndexedDB claims are atomic across store instances');
    await page.waitForFunction(() => /已更新|已缓存/.test(document.getElementById('transponderDataStatus').textContent));
    await openPicker(page); await page.fill('#satelliteSearch', '25544');
    assert.match(await page.textContent(pick('celestrak:25544')), /437\.800000.*145\.990000.*亚音 67\.0 Hz/s);
    assert.doesNotMatch(await page.textContent(pick('celestrak:25544')), /星历已缓存|自动更新|下次可检查/);
    assert.equal(await page.isVisible('#satelliteCatalogStatus'), false);
    await page.click('.satellite-radio-more summary');
    assert.equal(await page.getAttribute('#satelliteSelect', 'value'), 'celestrak:25544', 'expanding frequencies does not switch target');
    assert.equal(await page.locator('.satellite-radio-more').evaluate(el => el.open), true);
    await page.click('.satellite-radio-more summary');
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const radioLayout = await page.evaluate(() => {
        const list = document.getElementById('satelliteResults');
        return { overflow: list.scrollWidth > list.clientWidth,
          frequencySize: parseFloat(getComputedStyle(list.querySelector('.satellite-radio-value')).fontSize),
          toneSize: parseFloat(getComputedStyle(list.querySelector('.satellite-radio-tags')).fontSize) };
      });
      assert.equal(radioLayout.overflow, false);
      assert.ok(radioLayout.frequencySize >= 18 && radioLayout.toneSize >= 16);
    }
    await page.screenshot({ path: `test-artifacts/satellite-radio-${prefix === '/' ? 'root' : 'subpath'}.png` });
    await closePicker(page);
    await openPicker(page); await page.fill('#satelliteSearch', '  aO-7  ');
    assert.equal(await page.locator('.satellite-row').count(), 1);
    await page.click(star('celestrak:7530'));
    assert.equal(await page.getAttribute(star('celestrak:7530'), 'aria-pressed'), 'true');
    assert.equal(await page.getAttribute('#satelliteSelect', 'value'), 'celestrak:25544', 'favorite does not change target');
    assert.equal(await page.isVisible('#satelliteDialog'), true);
    await closePicker(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'satelliteSelect', 'Escape restores focus');
    await page.focus('#satelliteSelect'); await page.keyboard.press('Enter');
    await page.click('[data-catalog-filter="favorites"]');
    assert.equal(await page.locator('.satellite-row').count(), 1);
    await page.focus(pick('celestrak:7530')); await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute('#satelliteSelect', 'value'), 'celestrak:7530');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'satelliteSelect');
    assert.match(await page.textContent('#frequencyStatus'), /尚未设置下行频率/);
    await page.click('#trackingSettingsOpen');
    await page.fill('#observerLat', '31.23'); await page.fill('#observerLon', '121.47'); await page.click('#observerForm button');
    await page.waitForFunction(() => document.querySelectorAll('.pass-row').length > 0);
    await page.click('#trackingSettingsClose');
    await openPicker(page); await page.fill('#satelliteSearch', '100123');
    assert.equal(await page.locator(pick('celestrak:100123')).count(), 1);
    assert.match(await page.textContent(pick('celestrak:100123')), /435\.000000.*435\.100000.*145\.900000.*146\.000000.*上行 LSB.*反相/s);
    await page.fill('#satelliteSearch', 'no-match'); assert.match(await page.textContent('#satelliteResultStatus'), /没有匹配/);
    await page.fill('#satelliteSearch', '');
    for (const viewport of [{ width: 390, height: 550 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(() => document.getElementById('satelliteResults').getBoundingClientRect().bottom <= innerHeight);
      const boxes = await page.evaluate(() => {
        const search = document.getElementById('satelliteSearch').getBoundingClientRect();
        const results = document.getElementById('satelliteResults').getBoundingClientRect();
        return { searchBottom: search.bottom, resultBottom: results.bottom, listHeight: results.height,
          touch: [...document.querySelectorAll('#satelliteDialog button')].every(button => button.hidden || button.getBoundingClientRect().height >= 44), viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(boxes.searchBottom <= boxes.viewport && boxes.resultBottom <= boxes.viewport && boxes.listHeight > 0, JSON.stringify(boxes));
      assert.equal(boxes.touch, true); assert.equal(boxes.overflow, false);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // Emulate the VisualViewport shrink/offset reported by a mobile soft keyboard.
    await page.evaluate(() => {
      window.originalCatalogViewport = window.visualViewport;
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: { height: 240, offsetTop: 24 } });
      window.dispatchEvent(new Event('resize'));
    });
    assert.equal(await page.locator('#satelliteDialog.is-compact').count(), 1);
    assert.equal(await page.evaluate(() => document.getElementById('satelliteDialog').getBoundingClientRect().height <= 224), true);
    await page.locator(pick('celestrak:7530')).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.getElementById('satelliteResults').getBoundingClientRect().height >= 88), true);
    await page.locator('#satelliteSearch').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalCatalogViewport });
      window.dispatchEvent(new Event('resize'));
    });
    await page.screenshot({ path: `test-artifacts/satellite-picker-${prefix === '/' ? 'root' : 'subpath'}.png` });
    await closePicker(page);
    await page.click('#trackingSettingsOpen');
    await page.setInputFiles('#orbitFile', { name: 'iss.json', mimeType: 'application/json', buffer: Buffer.from(iss) });
    await page.waitForFunction(() => document.getElementById('satelliteSelect').value === 'import:25544');
    await page.click('#trackingSettingsClose');
    await openPicker(page); await page.click('[data-catalog-filter="imports"]');
    assert.equal(await page.locator('.satellite-row').count(), 1);
    await page.click(star('import:25544')); await page.click('[data-catalog-filter="favorites"]');
    assert.equal(await page.locator('.satellite-row').count(), 2);
    assert.equal(await page.locator(pick('celestrak:25544')).count(), 0, 'automatic and imported ISS have separate favorites');
    await closePicker(page);

    // Directory interactions share the actual microphone stream and live canvas.
    await page.click('#trackingReceiveBtn');
    await page.waitForFunction(() => document.getElementById('micReceiveBtn').getAttribute('aria-pressed') === 'true');
    await page.evaluate(async () => {
      window.catalogCanvas = document.getElementById('resultCanvas'); window.originalCatalogStream = window.catalogStream;
      const app = await import('./js/app.js');
      app.beginReceiverFrame({ frameId: 999, width: 8, height: 4, mode: { name: 'TEST' } });
      const pixels = new Uint8ClampedArray(8 * 4); for (let i = 0; i < pixels.length; i += 4) pixels.set([20, 180, 60, 255], i);
      app.applyReceiverFramePatch({ frameId: 999, y: 0, rowCount: 1, pixels, rows: 1, totalRows: 4 });
    });
    await openPicker(page); await page.fill('#satelliteSearch', '7530'); await page.click(pick('celestrak:7530'));
    assert.equal(await page.evaluate(() => window.catalogMicStarts), 1);
    assert.equal(await page.evaluate(() => window.originalCatalogStream === window.catalogStream && window.catalogStream.getAudioTracks()[0].readyState === 'live'), true);
    assert.equal(await page.getAttribute('#micReceiveBtn', 'aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => Array.from(window.catalogCanvas.getContext('2d').getImageData(0, 0, 1, 1).data)), [20, 180, 60, 255]);
    assert.equal(await page.evaluate(() => window.catalogCanvas === document.getElementById('resultCanvas')), true);
    await page.click('#trackingReceiveBtn'); await page.waitForFunction(() => !document.getElementById('recordingSaveDialog').hidden); await page.click('#recordingSaveNo');

    feed.body = JSON.stringify(amateur.filter(item => item.NORAD_CAT_ID !== 7530));
    await page.clock.fastForward(REFRESH_INTERVAL);
    await page.waitForFunction(() => document.getElementById('orbitEpoch').textContent.includes('未在最新目录中'));
    assert.equal(feed.amateur, 2);
    await openPicker(page); await page.fill('#satelliteSearch', '7530');
    assert.match(await page.textContent('#satelliteResults'), /未在最新目录中/);
    assert.equal(await page.getAttribute(star('celestrak:7530'), 'aria-pressed'), 'true'); await closePicker(page);
    await page.waitForFunction(() => navigator.serviceWorker.ready.then(registration => !!registration.active));
    await page.reload(); await page.click('#trackTab');
    await page.waitForFunction(() => document.getElementById('orbitEpoch').textContent.includes('未在最新目录中'));
    assert.equal(await page.getAttribute('#satelliteSelect', 'value'), 'celestrak:7530', 'missing selected target survives reload');
    feed.body = JSON.stringify(amateur.map(item => item.NORAD_CAT_ID === 7530 ? { ...item, OBJECT_NAME: 'AO-7 renamed' } : item));
    await page.clock.fastForward(REFRESH_INTERVAL);
    await page.waitForFunction(() => document.getElementById('satelliteSelectName').textContent === 'AO-7 renamed');
    assert.doesNotMatch(await page.textContent('#orbitEpoch'), /未在最新目录中/);
    feed.body = '<html>Server Error</html>';
    await page.clock.fastForward(REFRESH_INTERVAL);
    await page.waitForFunction(() => document.getElementById('catalogDataStatus').textContent.includes('TLE 行格式'));
    assert.equal(await page.getAttribute('#satelliteSelect', 'value'), 'celestrak:7530');
    const calls = { iss: feed.iss, amateur: feed.amateur };
    await page.click('#trackingSettingsOpen'); await page.click('#refreshOrbit');
    await page.waitForSelector('#refreshOrbit:not([disabled])'); await page.click('#trackingSettingsClose');
    assert.equal(feed.iss, calls.iss); assert.equal(feed.amateur, calls.amateur, 'failure and manual retry respect rate limit');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.fastForward(REFRESH_INTERVAL);
    assert.equal(feed.iss, calls.iss); assert.equal(feed.amateur, calls.amateur, 'background timers do not request either feed');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForSelector('#refreshOrbit:not([disabled])', { state: 'attached' });
    assert.equal(feed.amateur, calls.amateur + 1, 'return to foreground checks the eligible directory');
    await page.waitForFunction(() => navigator.serviceWorker.ready.then(registration => !!registration.active));
    await context.setOffline(true); await page.reload(); await page.click('#trackTab');
    await page.waitForFunction(() => document.getElementById('orbitAz').textContent !== '—');
    await openPicker(page); await page.fill('#satelliteSearch', '  RENAMED  ');
    assert.equal(await page.locator('.satellite-row').count(), 1);
    assert.equal(await page.getAttribute(star('celestrak:7530'), 'aria-pressed'), 'true');
    await page.fill('#satelliteSearch', ''); await page.click('[data-catalog-filter="favorites"]');
    assert.equal(await page.locator('.satellite-row').count(), 2);
    assert.equal(await page.getAttribute('#satelliteSelect', 'value'), 'celestrak:7530');
    assert.deepEqual(errors, []); await context.close();

    // Paste imports validate before switching, preserve drafts and work offline.
    const paste = await contextWithFeeds(), pastePage = await paste.context.newPage();
    const pasteErrors = []; pastePage.on('pageerror', error => pasteErrors.push(error.message));
    await clock(pastePage); await pastePage.goto(base + prefix); await pastePage.click('#trackTab');
    await pastePage.waitForFunction(() => /已更新|已读取缓存/.test(document.getElementById('catalogDataStatus').textContent));
    await pastePage.waitForFunction(() => document.getElementById('transponderDataStatus').textContent.includes('已更新'));
    assert.equal(paste.feed.iss, 1, 'entering tracking reuses the complete TLE snapshot');
    await pastePage.selectOption('#frequencySelect', 'remote-iss-voice');
    await pastePage.waitForFunction(() => document.getElementById('relaySummary').textContent.includes('67.0 Hz'));
    assert.match(await pastePage.textContent('#relaySummary'), /上行 145\.990000 MHz.*下行 437\.800000 MHz.*亚音 67\.0 Hz/);
    await pastePage.click('#trackingReceiveBtn');
    await pastePage.waitForFunction(() => document.getElementById('micReceiveBtn').getAttribute('aria-pressed') === 'true');
    await pastePage.click('#trackingSettingsOpen'); await pastePage.click('#orbitPasteOpen');
    assert.match(await pastePage.textContent('#transponderDetails'), /下行 437\.800000 MHz.*上行 145\.990000 MHz.*67\.0 Hz/s);
    assert.equal(await pastePage.evaluate(() => document.activeElement.id), 'orbitPasteText');
    await pastePage.click('#orbitPasteSubmit');
    assert.match(await pastePage.textContent('#orbitPasteStatus'), /导入失败/);
    const invalid = jamxTle.slice(0, -1) + '8';
    await pastePage.fill('#orbitPasteText', invalid); await pastePage.click('#orbitPasteSubmit');
    assert.match(await pastePage.textContent('#orbitPasteStatus'), /校验和/);
    assert.equal(await pastePage.inputValue('#orbitPasteText'), invalid);
    assert.equal(await pastePage.getAttribute('#satelliteSelect', 'value'), 'celestrak:25544');
    await pastePage.fill('#orbitPasteText', jamxTle); await pastePage.click('#orbitPasteCancel');
    assert.equal(await pastePage.getAttribute('#orbitPasteOpen', 'aria-expanded'), 'false');
    assert.equal(await pastePage.evaluate(() => document.activeElement.id), 'orbitPasteOpen');
    await pastePage.click('#orbitPasteOpen');
    assert.equal(await pastePage.inputValue('#orbitPasteText'), jamxTle, 'cancel preserves draft');
    for (const width of [320, 390]) {
      await pastePage.setViewportSize({ width, height: 568 });
      await pastePage.locator('#orbitPasteText').scrollIntoViewIfNeeded();
      assert.equal(await pastePage.evaluate(() => {
        const form = document.getElementById('orbitPasteForm'), text = document.getElementById('orbitPasteText');
        const box = text.getBoundingClientRect();
        return form.scrollWidth <= form.clientWidth && box.left >= 0 && box.right <= innerWidth;
      }), true, 'long TLE lines scroll inside textarea on narrow screens');
    }
    await pastePage.screenshot({ path: `test-artifacts/orbit-paste-${prefix === '/' ? 'root' : 'subpath'}.png` });
    await pastePage.click('#orbitPasteSubmit');
    await pastePage.waitForFunction(() => document.getElementById('satelliteSelect').value === 'import:100470');
    await pastePage.waitForSelector('#orbitPasteForm', { state: 'hidden' });
    assert.equal(await pastePage.isVisible('#orbitPasteForm'), false);
    assert.equal(await pastePage.inputValue('#orbitPasteText'), '');
    assert.match(await pastePage.textContent('#orbitDataStatus'), /已导入 1 颗/);
    assert.match(await pastePage.textContent('#relaySummary'), /上行 145\.950000 MHz.*下行 435\.500000 MHz.*亚音 未提供/);
    assert.equal(await pastePage.getAttribute('#micReceiveBtn', 'aria-pressed'), 'true');
    await pastePage.click('#orbitPasteOpen'); await pastePage.fill('#orbitPasteText', iss); await pastePage.click('#orbitPasteSubmit');
    await pastePage.waitForFunction(() => document.getElementById('satelliteSelect').value === 'import:25544');
    await pastePage.waitForSelector('#orbitPasteForm', { state: 'hidden' });
    await pastePage.setInputFiles('#orbitFile', { name: 'jamx.tle', mimeType: 'text/plain', buffer: Buffer.from(jamxTle) });
    await pastePage.waitForFunction(() => document.getElementById('satelliteSelect').value === 'import:100470');
    assert.match(await pastePage.textContent('#relaySummary'), /亚音 未提供/, 'transponder cache works offline with imported TLE');
    const savedImports = await pastePage.evaluate(async () => {
      const { TrackingStore } = await import('./js/tracking-store.js'); return new TrackingStore(indexedDB).get('imports');
    });
    assert.equal(savedImports.length, 2, 'file and pasted imports update the same local records');
    await pastePage.click('#trackingSettingsClose');
    await pastePage.waitForFunction(() => navigator.serviceWorker.ready.then(registration => !!registration.active));
    await paste.context.setOffline(true); await pastePage.reload(); await pastePage.click('#trackTab');
    await pastePage.waitForFunction(() => document.getElementById('satelliteSelect').value === 'import:100470');
    await pastePage.click('#trackingSettingsOpen'); await pastePage.click('#orbitPasteOpen');
    await pastePage.fill('#orbitPasteText', iss); await pastePage.click('#orbitPasteSubmit');
    await pastePage.waitForFunction(() => document.getElementById('satelliteSelect').value === 'import:25544');
    assert.deepEqual(pasteErrors, []); await paste.context.close();
    console.log(`PASS paste ${prefix}: invalid/empty input, preserved drafts, TLE/OMM, narrow screens, ongoing reception, shared file imports and offline persistence`);

    // Seed a pre-directory database, including a selected manual import and position.
    const legacy = await contextWithFeeds(), legacyPage = await legacy.context.newPage();
    await clock(legacyPage); await legacyPage.goto(base + prefix + 'encode.html');
    await legacyPage.evaluate(async text => {
      const { parseElements } = await import('./js/orbit-core.js');
      const { TrackingStore } = await import('./js/tracking-store.js'); const store = new TrackingStore(indexedDB);
      await store.set('iss', parseElements(text, 'celestrak')[0]); await store.set('imports', parseElements(text));
      await store.set('selected', 'import:25544'); await store.set('lastRequest', Date.now());
      await store.set('observer', { latitude: 31.23, longitude: 121.47, altitude: 0 });
    }, iss);
    await legacyPage.goto(base + prefix); await legacyPage.click('#trackTab');
    await legacyPage.waitForFunction(() => /已更新|已读取缓存/.test(document.getElementById('catalogDataStatus').textContent));
    assert.equal(legacy.feed.iss, 1); assert.equal(legacy.feed.amateur, 1, 'old source timestamp does not suppress new source');
    assert.equal(await legacyPage.getAttribute('#satelliteSelect', 'value'), 'import:25544');
    await legacyPage.waitForFunction(() => document.getElementById('orbitAz').textContent !== '—');
    await openPicker(legacyPage); await legacyPage.click('[data-catalog-filter="favorites"]');
    assert.match(await legacyPage.textContent('#satelliteResultStatus'), /尚未收藏/);
    await legacyPage.click('[data-catalog-filter="imports"]'); assert.equal(await legacyPage.locator('.satellite-row').count(), 1);
    await legacy.context.close();
    console.log(`PASS catalog ${prefix}: lazy feeds, atomic limits, keyboard/touch/search, distinct favorites, audio/canvas continuity, disappearing/renamed targets, failed updates, offline persistence and legacy database`);
  }
  const large = await contextWithFeeds();
  large.feed.body = JSON.stringify([amateur[0], ...Array.from({ length: 600 }, (_, index) => ({ ...amateur[1], NORAD_CAT_ID: 30000 + index, OBJECT_NAME: `LARGE ${String(index).padStart(3, '0')}` }))]);
  const largePage = await large.context.newPage(); await clock(largePage); await largePage.goto(base + '/'); await largePage.click('#trackTab');
  await largePage.waitForFunction(() => document.getElementById('catalogDataStatus').textContent.includes('600 颗'));
  await openPicker(largePage); assert.equal(await largePage.locator('.satellite-row').count(), 100);
  await largePage.click('#satelliteMore'); assert.equal(await largePage.locator('.satellite-row').count(), 200);
  await largePage.fill('#satelliteSearch', '30599'); assert.equal(await largePage.locator('.satellite-row').count(), 1);
  assert.equal(await largePage.isVisible('#satelliteMore'), false);
  await largePage.click(pick('celestrak:30599')); assert.equal(await largePage.getAttribute('#satelliteSelect', 'value'), 'celestrak:30599');
  assert.equal(large.feed.iss, 1); await large.context.close();
  console.log('PASS large catalog: bounded DOM, load more and search across the complete catalog');
  const offline = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await offline.route('https://tledata.xanyi.eu.org/**', route => route.abort());
  const page = await offline.newPage(); await clock(page); await page.goto(base + '/');
  await page.waitForFunction(() => document.getElementById('orbitDataStatus').textContent.includes('暂无缓存'));
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(registration => !!registration.active));
  await offline.setOffline(true); await page.reload(); await page.click('#trackTab');
  await page.waitForFunction(() => document.getElementById('catalogDataStatus').textContent.includes('暂无缓存'));
  await openPicker(page); assert.match(await page.textContent('#satelliteResults'), /ISS.*等待星历/s);
  await page.click('[data-catalog-filter="imports"]'); assert.match(await page.textContent('#satelliteResultStatus'), /暂无本地导入/);
  await offline.close();
  console.log('PASS empty offline catalog: app shell opens and presents ISS placeholder/import guidance');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
