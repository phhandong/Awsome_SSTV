import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { chromium } from 'playwright-core';

const root = process.cwd();
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.woff2':'font/woff2', '.svg':'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, path.slice(1) || 'index.html');
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('invalid path');
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless:true,
  args:['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, permissions:['microphone'], serviceWorkers:'block' });
  await context.route('https://**', route => route.abort());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#micReceiveBtn:not([disabled])');
  // Keep real microphone startup/shutdown, but use a deterministic SSTV capture
  // at the recording boundary so both re-decode modes can be verified quickly.
  await page.evaluate(async () => {
    const { encode } = await import('./js/encoder.js');
    const { getMode } = await import('./js/modes.js');
    const { WebSSTVDecoder } = await import('./js/web-receiver.js');
    const { AudioPlayer } = await import('./js/audioPlayer.js');
    const mode = getMode(8), rgba = new Uint8ClampedArray(mode.width * mode.height * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([40, 180, 80, 255], i);
    window.captureSamples = encode({ rgba }, mode, { sampleRate:11025 });
    const stop = WebSSTVDecoder.prototype.stopMicrophone;
    WebSSTVDecoder.prototype.stopMicrophone = async function (...args) {
      await stop.apply(this, args);
      return { samples:window.captureSamples, sampleRate:11025 };
    };
    const load = AudioPlayer.prototype.loadAudio;
    window.audioLoads = 0;
    AudioPlayer.prototype.loadAudio = function (...args) {
      window.audioLoads++; window.loadedPlayer = this;
      return load.apply(this, args);
    };
  });
  async function record() {
    await page.click('#trackTab');
    await page.click('#trackingReceiveBtn');
    await page.waitForFunction(() => document.getElementById('micReceiveBtn').getAttribute('aria-pressed') === 'true');
    await page.click('#trackingReceiveBtn');
    await page.waitForFunction(() => !document.getElementById('recordingSaveDialog').hidden);
  }
  await record();
  await page.click('#recordingSaveNo');
  await page.click('#receiveTab');
  assert.match(await page.textContent('#audioMeta'), /本机录音.*11025Hz/);
  assert.equal(await page.isEnabled('#offlineDecodeBtn'), true);
  assert.equal(await page.isEnabled('#audioPlayPauseBtn'), true);
  assert.equal(await page.evaluate(() => window.loadedPlayer.samples === window.captureSamples), true);
  assert.equal(await page.evaluate(() => window.loadedPlayer.isPlaying), false, 'loading never starts playback');
  assert.equal(await page.evaluate(() => document.getElementById('wavInput').files.length), 0, 'no upload required');
  await page.fill('#decodeStartSec', '0.5');
  await page.fill('#decodeEndSec', '10');
  await page.click('#trackTab'); await page.click('#receiveTab');
  assert.equal(await page.inputValue('#decodeStartSec'), '0.5');
  assert.equal(await page.inputValue('#decodeEndSec'), '10.0');
  assert.equal(await page.evaluate(() => window.audioLoads), 1, 'view switch does not reload or reset selection');
  await page.click('#resetSelectionBtn');
  await page.check('#fastDecodeMode');
  for (let i = 0; i < 2; i++) {
    await page.click('#offlineDecodeBtn');
    await page.waitForFunction(() => document.getElementById('offlineDecodeBtn').getAttribute('aria-busy') !== 'true');
    assert.equal(await page.isEnabled('#saveImageBtn'), true, 'retained PCM decodes into a savable image');
    assert.match(await page.textContent('#decodedPageCount'), /01\s*\/\s*01/);
    assert.equal(await page.evaluate(() => window.loadedPlayer.samples.length === window.captureSamples.length && window.captureSamples.length > 0), true);
  }
  await page.uncheck('#fastDecodeMode');
  await page.click('#offlineDecodeBtn');
  await page.waitForFunction(async () => (await import('./js/app.js')).getFieldReceiverState().fileActive);
  await page.click('#trackTab');
  assert.equal(await page.isDisabled('#trackingClearRecording'), true, 'cannot clear audio while re-decoding');
  await page.click('#trackingFileStop');
  await page.waitForFunction(async () => !(await import('./js/app.js')).getFieldReceiverState().fileActive);
  await page.click('#trackingClearRecording');
  await page.click('#receiveTab');
  assert.equal(await page.isDisabled('#offlineDecodeBtn'), true);
  assert.equal(await page.isDisabled('#audioPlayPauseBtn'), true);
  assert.equal(await page.evaluate(() => window.loadedPlayer.samples), null);
  assert.equal(await page.isEnabled('#saveImageBtn'), true, 'clearing recording keeps decoded images');

  await record();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#recordingSaveYes')]);
  assert.match(download.suggestedFilename(), /\.wav$/);
  await page.click('#receiveTab');
  assert.equal(await page.isEnabled('#offlineDecodeBtn'), true, 'saving WAV retains editable audio');
  assert.equal(await page.evaluate(() => window.loadedPlayer.samples === window.captureSamples), true);
  await page.click('#resetDecodedBtn');
  assert.equal(await page.isDisabled('#audioPlayPauseBtn'), true, 'explicit reset clears saved recording source');

  await record(); await page.click('#recordingSaveNo'); await page.click('#receiveTab');
  const wavBytes = await page.evaluate(async () => {
    const { encodeWAV } = await import('./js/wav.js');
    return Array.from(new Uint8Array(encodeWAV(new Float32Array(22050), 11025)));
  });
  await page.setInputFiles('#wavInput', { name:'replacement.wav', mimeType:'audio/wav', buffer:Buffer.from(wavBytes) });
  await page.waitForFunction(() => document.getElementById('audioMeta').textContent.includes('2.0s'));
  await page.click('#trackTab'); await page.click('#trackingClearRecording'); await page.click('#receiveTab');
  assert.equal(await page.isEnabled('#offlineDecodeBtn'), true, 'clearing old recording preserves replacement file');
  assert.match(await page.textContent('#audioMeta'), /2.0s/);
  assert.deepEqual(errors, []);
  console.log('PASS recording re-decode: original PCM, no upload/autoplay, selection continuity, repeated fast decode, realtime decode, save/clear and replacement file');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
