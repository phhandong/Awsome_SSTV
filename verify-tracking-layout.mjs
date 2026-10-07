import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.woff2':'font/woff2', '.svg':'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(`.${path === '/' ? '/index.html' : path}`);
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
await mkdir('test-artifacts', { recursive:true });
const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless:true });
try {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, serviceWorkers:'block' });
  await context.route('https://**', route => route.abort());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.click('#trackTab');
  for (const [width, height] of [[390,844],[375,667],[375,550],[320,568],[844,390],[1440,900]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path:`test-artifacts/layout-${width}x${height}.png`, animations:'disabled' });
    const layout = await page.evaluate(() => ({
      overflow:document.documentElement.scrollWidth > innerWidth,
      boxes:['skyPlot','trackingImageMount','trackingReceiveBtn','trackingLocate'].map(id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return { id, x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom };
      })
    }));
    assert.equal(layout.overflow, false, JSON.stringify(layout));
    assert.ok(layout.boxes.every(r => r.x >= 0 && r.y >= 0 && r.bottom <= height && r.right <= width && r.height > 0), JSON.stringify(layout));
  }
  await page.setViewportSize({ width:390, height:844 });
  await page.click('#trackingLocate');
  assert.equal(await page.locator('#locateObserver').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  await page.locator('#trackingImageMount .result-canvas-stage').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.isVisible('#trackingImageLargeMount #resultCanvas'), true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#trackingImageMount #resultCanvas');
  assert.equal(await page.locator('#trackingImageExpand').evaluate(el => el === document.activeElement), true);
  await page.click('#trackingSettingsOpen');
  await page.mouse.click(1, 1);
  assert.equal(await page.locator('#trackingSettings').evaluate(el => el.open), false);
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.screenshot({ path:'test-artifacts/layout-light.png', animations:'disabled' });
  assert.deepEqual(errors, []);
  console.log('PASS tracking layout: portrait, short screens, landscape, desktop, keyboard, backdrop and focus restoration');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
