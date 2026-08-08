import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
await mkdir(join(ROOT, 'test-artifacts'), { recursive: true });
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg'],
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = normalize(join(ROOT, relative));
    if (!file.startsWith(ROOT)) throw new Error('invalid path');
    response.setHeader('Content-Type', mime.get(extname(file)) || 'application/octet-stream');
    response.end(await readFile(file));
  } catch (_) {
    response.statusCode = 404;
    response.end('Not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

async function verifyViewport(name, viewport) {
  const context = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#micStartBtn');

  const decoded = await page.evaluate(async () => {
    const [{ encode }, { getMode }, { WebSSTVDecoder }, ui] = await Promise.all([
      import('./js/encoder.js'), import('./js/modes.js'), import('./js/web-receiver.js'), import('./js/ui.js'),
    ]);
    const mode = getMode(2);
    const rgba = new Uint8ClampedArray(mode.width * mode.height * 4);
    for (let y = 0; y < mode.height; y++) for (let x = 0; x < mode.width; x++) {
      const i = (y * mode.width + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.round(255 * x / mode.width);
      rgba[i + 3] = 255;
    }
    const pcm = encode({ rgba }, mode, { sampleRate: 11025 });
    const decoder = new WebSSTVDecoder();
    const result = await decoder.decode(pcm, 11025, {
      dsp: { engine: 'mmsstv', bpf: true }, emitFrames: false,
    });
    ui.renderToCanvas(document.getElementById('resultCanvas'), result.pixels, result.width, result.height);
    const canvas = document.getElementById('resultCanvas');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
    decoder.destroy();
    return { mode: result.mode.name, width: result.width, height: result.height, pixelSum: sum };
  });
  if (decoded.mode !== 'B/W 8' || decoded.pixelSum <= 0) throw new Error(`${name}: Worker/canvas decode failed`);

  await page.click('#micStartBtn');
  await page.waitForFunction(() => ['搜索信号', '已锁定'].includes(document.getElementById('receiverStatus').textContent));
  await page.click('#micStopBtn');
  await page.waitForFunction(() => document.getElementById('receiverStatus').textContent === '已停止');

  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    clippedButtons: [...document.querySelectorAll('button')].filter(button => button.scrollWidth > button.clientWidth + 1).map(button => button.id),
    canvas: { width: document.getElementById('resultCanvas').clientWidth, height: document.getElementById('resultCanvas').clientHeight },
  }));
  if (layout.overflow > 1) throw new Error(`${name}: horizontal overflow ${layout.overflow}px`);
  if (layout.clippedButtons.length) throw new Error(`${name}: clipped buttons ${layout.clippedButtons.join(',')}`);
  if (layout.canvas.width <= 0 || layout.canvas.height <= 0) throw new Error(`${name}: blank canvas layout`);
  if (errors.length) throw new Error(`${name}: page errors: ${errors.join('; ')}`);
  await page.waitForFunction(() => document.getElementById('toast').hidden);
  if (name === 'mobile') await page.locator('.decoder').scrollIntoViewIfNeeded();
  else await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `test-artifacts/${name}.png`, fullPage: false });
  await context.close();
  console.log(`${name}: ${viewport.width}x${viewport.height}, ${decoded.mode} ${decoded.width}x${decoded.height}, no overflow`);
}

try {
  await verifyViewport('desktop', { width: 1440, height: 1000 });
  await verifyViewport('mobile', { width: 390, height: 844 });
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
