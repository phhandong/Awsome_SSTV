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
    const [{ encode }, { getMode }, { WebSSTVDecoder }, ui, app] = await Promise.all([
      import('./js/encoder.js'), import('./js/modes.js'), import('./js/web-receiver.js'), import('./js/ui.js'), import('./js/app.js'),
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
    app.renderReceiverFrame(result);
    const canvas = document.getElementById('resultCanvas');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
    decoder.destroy();
    return { mode: result.mode.name, width: result.width, height: result.height, pixelSum: sum };
  });
  if (decoded.mode !== 'B/W 8' || decoded.pixelSum <= 0) throw new Error(`${name}: Worker/canvas decode failed`);

  const receiveOptions = await page.evaluate(() => {
    document.getElementById('autoReceive').checked = false;
    document.getElementById('modeSelect').value = '12';
    return import('./js/app.js').then(app => app.readReceiveOptions());
  });
  if (receiveOptions.mode !== 12 || 'autoSync' in receiveOptions) throw new Error(`${name}: manual receive did not use modeSelect`);
  await page.evaluate(() => { document.getElementById('autoReceive').checked = true; });

  for (const format of ['png', 'bmp']) {
    await page.selectOption('#imageFormat', format);
    const downloadPromise = page.waitForEvent('download');
    await page.click('#saveImageBtn');
    const download = await downloadPromise;
    const bytes = await readFile(await download.path());
    const signatureOk = format === 'png'
      ? bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length > 54 && bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.readUInt16LE(28) === 24;
    if (!signatureOk || !download.suggestedFilename().endsWith(`.${format}`)) {
      throw new Error(`${name}: invalid ${format.toUpperCase()} download`);
    }
  }

  if (name === 'desktop') {
    await page.setInputFiles('#wavInput', join(ROOT, 'asset', 'ROBOT36_test.mp3'));
    await page.waitForFunction(() => !document.getElementById('decodeEndSec').disabled, null, { timeout: 30000 });
    const duration = Number(await page.inputValue('#decodeEndSec'));
    await page.fill('#decodeStartSec', '1.0');
    await page.fill('#decodeEndSec', String(Math.max(1.1, duration - 1)));
    const rangeSync = await page.evaluate(() => ({
      left: parseFloat(document.getElementById('audioSelection').style.left),
      width: parseFloat(document.getElementById('audioSelection').style.width),
      invalid: document.getElementById('decodeStartSec').getAttribute('aria-invalid'),
    }));
    if (!(rangeSync.left > 0 && rangeSync.width > 0 && rangeSync.width < 100 && rangeSync.invalid === 'false')) {
      throw new Error('desktop: numeric range did not update waveform selection');
    }
    await page.fill('#decodeStartSec', String(duration));
    const invalid = await page.evaluate(() => ({
      disabled: document.getElementById('decodeUploadedBtn').disabled,
      errorVisible: !document.getElementById('rangeError').hidden,
      aria: document.getElementById('decodeStartSec').getAttribute('aria-invalid'),
    }));
    if (!invalid.disabled || !invalid.errorVisible || invalid.aria !== 'true') throw new Error('desktop: invalid range can start decode');
    await page.click('#resetSelectionBtn');
    const reset = await page.evaluate(() => ({
      start: Number(document.getElementById('decodeStartSec').value),
      end: Number(document.getElementById('decodeEndSec').value),
      duration: Number(document.getElementById('audioDuration').textContent.split(':')[0]) * 60 + Number(document.getElementById('audioDuration').textContent.split(':')[1]),
      left: document.getElementById('audioSelection').style.left,
      width: document.getElementById('audioSelection').style.width,
    }));
    if (reset.start !== 0 || reset.end <= 0 || reset.left !== '0%' || reset.width !== '100%') {
      throw new Error('desktop: reset did not restore full selection');
    }
    const timeline = await page.locator('.audio-timeline-container').boundingBox();
    const startHandle = await page.locator('.audio-selection-start').boundingBox();
    if (!timeline || !startHandle) throw new Error('desktop: selection controls have no layout');
    await page.mouse.move(startHandle.x + startHandle.width / 2, startHandle.y + startHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(timeline.x + timeline.width * 0.2, startHandle.y + startHandle.height / 2);
    await page.mouse.up();
    const draggedStart = Number(await page.inputValue('#decodeStartSec'));
    if (!(draggedStart > 0 && draggedStart < reset.end)) throw new Error('desktop: waveform drag did not update numeric range');

    await page.mouse.move(timeline.x + timeline.width * 0.5, timeline.y + timeline.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(timeline.x + timeline.width * 0.6, timeline.y + timeline.height * 0.5);
    await page.mouse.up();
    const playhead = parseFloat(await page.locator('#audioPlayhead').evaluate(element => element.style.left));
    const startAfterSeek = Number(await page.inputValue('#decodeStartSec'));
    if (!(playhead > 55 && playhead < 65) || startAfterSeek !== draggedStart) {
      throw new Error('desktop: timeline drag did not move playhead independently of selection');
    }

    await page.locator('#audioWaveform').evaluate(canvas => { canvas.width = 7; });
    await page.setInputFiles('#wavInput', join(ROOT, 'asset', 'ROBOT36_test.mp3'));
    await page.waitForFunction(() => {
      const selection = document.getElementById('audioSelection');
      const waveform = document.getElementById('audioWaveform');
      const playhead = document.getElementById('audioPlayhead');
      return selection.style.left === '0%' && selection.style.width === '100%' &&
        waveform.width > 7 && playhead.style.left === '0%';
    }, null, { timeout: 30000 });
    const reloaded = await page.evaluate(() => ({
      start: Number(document.getElementById('decodeStartSec').value),
      end: Number(document.getElementById('decodeEndSec').value),
      width: document.getElementById('audioWaveform').width,
      currentTime: document.getElementById('audioCurrentTime').textContent,
    }));
    if (reloaded.start !== 0 || reloaded.end <= 0 || reloaded.width <= 7 || reloaded.currentTime !== '0:00') {
      throw new Error('desktop: re-upload did not redraw waveform and reset timeline state');
    }
  }

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
