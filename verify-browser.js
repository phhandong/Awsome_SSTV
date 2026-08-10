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

async function clickVisibleScrim(page) {
  const box = await page.locator('#navScrim').boundingBox();
  if (!box) throw new Error('navigation scrim has no layout');
  // On narrow viewports the drawer covers the scrim center. Click its visible
  // right edge, matching where a user can actually dismiss the drawer.
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
}

async function verifyViewport(name, viewport) {
  const context = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#micStartBtn');

  const decoderShell = await page.evaluate(() => ({
    page: document.body.dataset.page,
    drawerHidden: document.getElementById('navDrawer').getAttribute('aria-hidden'),
    navExpanded: document.getElementById('navToggle').getAttribute('aria-expanded'),
    decodeButtons: [...document.querySelectorAll('.decode-actions button')].map(button => button.id),
    fastDecodeLabel: document.getElementById('decodeUploadedBtn')?.textContent,
    persistentControls: {
      progressVisible: !document.getElementById('offlineDecodeProgress')?.hidden,
      progressIdle: document.getElementById('offlineDecodeProgress')?.classList.contains('is-idle'),
      progressMerged: document.getElementById('offlineDecodeProgress')?.contains(document.getElementById('receiverMeter')) &&
        document.getElementById('offlineDecodeProgress')?.contains(document.getElementById('offlineDecodeProgressBar')),
      progressValue: document.getElementById('offlineDecodeProgressBar')?.getAttribute('aria-valuenow'),
      playerVisible: !document.getElementById('audioPlayerWrapper')?.hidden,
      playerIdle: document.getElementById('audioPlayerWrapper')?.classList.contains('is-idle'),
      playDisabled: document.getElementById('audioPlayPauseBtn')?.disabled,
    },
    hasEncoder: !!document.getElementById('encodeBtn'),
    meterCells: document.querySelectorAll('#receiverMeter .signal-cell').length,
    footer: {
      childCount: document.querySelector('.radio-footer')?.children.length,
      links: [...document.querySelectorAll('.radio-footer nav a')].map(link => link.textContent.trim()),
      icons: document.querySelectorAll('.radio-footer .footer-link-icon').length,
      navCenter: (() => {
        const footer = document.querySelector('.radio-footer').getBoundingClientRect();
        const nav = document.querySelector('.radio-footer nav').getBoundingClientRect();
        return Math.abs((nav.left + nav.right) / 2 - (footer.left + footer.right) / 2);
      })(),
    },
    frequencyReadouts: document.querySelectorAll('.frequency-readout').length,
    decodedMetadata: document.querySelectorAll('#resultMeta, .result-heading .meta').length,
    rowsTelemetry: document.querySelectorAll('#receiverRows').length,
    workspace: (() => {
      const controls = document.getElementById('decoderControls');
      const output = document.getElementById('decoderOutput');
      const canvas = document.getElementById('resultCanvas');
      const box = element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      return {
        sameParent: controls?.parentElement === output?.parentElement && controls?.parentElement?.classList.contains('decoder-workspace'),
        controls: box(controls),
        output: box(output),
        canvas: box(canvas),
      };
    })(),
    settings: {
      expanded: document.getElementById('rxSettingsToggle')?.getAttribute('aria-expanded'),
      hidden: document.getElementById('rxSettingsPanel')?.getAttribute('aria-hidden'),
      inert: document.getElementById('rxSettingsPanel')?.hasAttribute('inert'),
      ownsControls: ['modeSelect', 'autoReceive', 'dspAfc', 'dspLms', 'dspBpf', 'basebandFilterBtn']
        .every(id => document.getElementById('rxSettingsPanel')?.contains(document.getElementById(id))),
      topbarSettings: document.querySelectorAll('.topbar-actions #modeSelect, .topbar-actions #autoReceive').length,
      afc: document.getElementById('dspAfc')?.checked,
      lms: document.getElementById('dspLms')?.checked,
    },
    initialTheme: document.documentElement.getAttribute('data-theme'),
    fontSizes: {
      body: parseFloat(getComputedStyle(document.body).fontSize),
      intro: parseFloat(getComputedStyle(document.querySelector('.console-intro > div:first-child > p:last-child')).fontSize),
      command: parseFloat(getComputedStyle(document.querySelector('.command-btn')).fontSize),
      micro: parseFloat(getComputedStyle(document.querySelector('.module-label span')).fontSize),
      panelTitle: parseFloat(getComputedStyle(document.querySelector('.panel-heading h2')).fontSize),
    },
  }));
  if (decoderShell.page !== 'decoder' || decoderShell.drawerHidden !== 'true' || decoderShell.navExpanded !== 'false') {
    throw new Error(`${name}: decoder shell or hidden navigation is invalid`);
  }
  if (decoderShell.decodeButtons.join('|') !== 'realtimeDecodeBtn|decodeUploadedBtn' || decoderShell.hasEncoder) {
    throw new Error(`${name}: decoder does not expose exactly the two requested commands`);
  }
  if (decoderShell.fastDecodeLabel !== '⚡️极速解码' ||
      !decoderShell.persistentControls.progressVisible || !decoderShell.persistentControls.progressIdle ||
      !decoderShell.persistentControls.progressMerged || decoderShell.persistentControls.progressValue !== '0' ||
      !decoderShell.persistentControls.playerVisible || !decoderShell.persistentControls.playerIdle ||
      !decoderShell.persistentControls.playDisabled) {
    throw new Error(`${name}: permanent progress/player state or fast decode label is invalid ${JSON.stringify(decoderShell.persistentControls)}`);
  }
  if (decoderShell.meterCells !== 12 || decoderShell.footer.childCount !== 1 ||
      decoderShell.footer.links.join('|') !== 'SOURCE|LICENSE' || decoderShell.footer.icons !== 2 ||
      decoderShell.footer.navCenter > 1) {
    throw new Error(`${name}: signal meter or centered footer links are invalid`);
  }
  if (decoderShell.frequencyReadouts !== 0 || decoderShell.decodedMetadata !== 0 ||
      decoderShell.rowsTelemetry !== 0 || !decoderShell.workspace.sameParent) {
    throw new Error(`${name}: obsolete frequency readout remains or decoder workspace is malformed`);
  }
  const { controls, output, canvas: outputCanvas } = decoderShell.workspace;
  const wideWorkspace = viewport.width >= 1024;
  const workspaceLayoutOk = wideWorkspace
    ? Math.abs(controls.top - output.top) <= 2 && output.left >= controls.right - 1 && outputCanvas.bottom <= viewport.height + 1
    : output.top >= controls.bottom - 1 && Math.abs(controls.left - output.left) <= 2 && Math.abs(controls.right - output.right) <= 2;
  if (!workspaceLayoutOk) {
    throw new Error(`${name}: decoder workspace is not ${wideWorkspace ? 'side-by-side in the first viewport' : 'vertically stacked'} ${JSON.stringify(decoderShell.workspace)}`);
  }
  if (decoderShell.settings.expanded !== 'false' || decoderShell.settings.hidden !== 'true' ||
      !decoderShell.settings.inert || !decoderShell.settings.ownsControls || decoderShell.settings.topbarSettings !== 0 ||
      !decoderShell.settings.afc || !decoderShell.settings.lms || decoderShell.initialTheme !== 'dark') {
    throw new Error(`${name}: receiver settings do not start collapsed or do not own P2/P3 controls`);
  }
  if (decoderShell.fontSizes.body < 16 || decoderShell.fontSizes.intro < 15 ||
      decoderShell.fontSizes.command < 15 || decoderShell.fontSizes.micro < 11 ||
      decoderShell.fontSizes.panelTitle < 16) {
    throw new Error(`${name}: console type remains too small ${JSON.stringify(decoderShell.fontSizes)}`);
  }
  if (await page.getAttribute('html', 'data-theme') !== 'light') await page.click('#themeToggle');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
  const receiverContrast = await page.evaluate(() => {
    const style = (selector, pseudo = null) => getComputedStyle(document.querySelector(selector), pseudo);
    return {
      panel: style('.signal-meter-wrap').backgroundColor,
      signal: style('.signal-cell').backgroundColor,
      signalBorder: style('.signal-cell').borderColor,
      progress: style('.receiver-decode-track').backgroundColor,
      progressBorder: style('.receiver-decode-track').borderColor,
      playhead: style('.audio-playhead').backgroundColor,
      playheadMarker: style('.audio-playhead', '::before').backgroundColor,
      footerBackground: style('.radio-footer').backgroundColor,
      githubIconColor: style('.github-icon').color,
    };
  });
  if (receiverContrast.signal === receiverContrast.panel || receiverContrast.progress === receiverContrast.panel ||
      receiverContrast.signalBorder === receiverContrast.panel || receiverContrast.progressBorder === receiverContrast.panel ||
      receiverContrast.playhead !== 'rgb(59, 130, 246)' || receiverContrast.playheadMarker !== 'rgb(59, 130, 246)' ||
      receiverContrast.footerBackground !== 'rgba(0, 0, 0, 0)' ||
      receiverContrast.githubIconColor !== 'rgb(16, 32, 27)') {
    throw new Error(`${name}: receiver contrast or blue playhead styling is invalid ${JSON.stringify(receiverContrast)}`);
  }
  const telemetryLayout = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.receiver-telemetry > span')];
    const status = document.getElementById('receiverStatus');
    const original = status.textContent;
    status.textContent = '已锁定 · 同步 · PD120';
    const result = {
      widths: cells.map(cell => cell.getBoundingClientRect().width),
      statusFits: status.scrollWidth <= status.clientWidth + 1,
      statusWraps: getComputedStyle(status).whiteSpace !== 'nowrap',
    };
    status.textContent = original;
    return result;
  });
  if (viewport.width >= 681 && (!(telemetryLayout.widths[0] > telemetryLayout.widths[1]) ||
      !telemetryLayout.statusFits || !telemetryLayout.statusWraps)) {
    throw new Error(`${name}: STATUS telemetry is still clipped ${JSON.stringify(telemetryLayout)}`);
  }
  await page.click('#navToggle');
  if (await page.getAttribute('#navDrawer', 'aria-hidden') !== 'false') throw new Error(`${name}: navigation did not open`);
  await clickVisibleScrim(page);
  if (await page.getAttribute('#navDrawer', 'aria-hidden') !== 'true') throw new Error(`${name}: navigation did not close`);

  await page.click('#rxSettingsToggle');
  await page.waitForFunction(() => document.getElementById('rxSettingsPanel').getAttribute('aria-hidden') === 'false');
  await page.click('#rxSettingsPanel .custom-select-trigger');
  await page.click('#rxSettingsPanel .custom-select-option[data-value="12"]');
  await page.uncheck('#autoReceive');
  const receiveOptions = await page.evaluate(() => import('./js/app.js').then(app => app.readReceiveOptions()));
  if (receiveOptions.mode !== 12 || 'autoSync' in receiveOptions) {
    throw new Error(`${name}: visible receiver settings did not update manual receive mode`);
  }
  await page.check('#autoReceive');
  await page.click('#basebandFilterBtn');

  const settingsLayout = await page.evaluate(() => {
    const panel = document.getElementById('rxSettingsPanel').getBoundingClientRect();
    const fab = document.getElementById('rxSettingsToggle').getBoundingClientRect();
    const low = document.getElementById('basebandLow').closest('.filter-slider-row').getBoundingClientRect();
    const high = document.getElementById('basebandHigh').closest('.filter-slider-row').getBoundingClientRect();
    return {
      expanded: document.getElementById('rxSettingsToggle').getAttribute('aria-expanded'),
      hidden: document.getElementById('rxSettingsPanel').getAttribute('aria-hidden'),
      filterHidden: document.getElementById('basebandFilterPanel').hidden,
      slidersSameRow: Math.abs(low.top - high.top) <= 2 && low.right <= high.left + 1,
      panelInViewport: panel.left >= 0 && panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight,
      fabInViewport: fab.left >= 0 && fab.top >= 0 && fab.right <= innerWidth && fab.bottom <= innerHeight,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  if (settingsLayout.expanded !== 'true' || settingsLayout.hidden !== 'false' || settingsLayout.filterHidden ||
      !settingsLayout.slidersSameRow || !settingsLayout.panelInViewport || !settingsLayout.fabInViewport ||
      settingsLayout.overflow > 1) {
    throw new Error(`${name}: receiver settings/P1 layout is invalid ${JSON.stringify(settingsLayout)}`);
  }
  await page.screenshot({ path: `test-artifacts/${name}-settings.png`, fullPage: false });

  await page.keyboard.press('Escape');
  const firstEscape = await page.evaluate(() => ({
    filterHidden: document.getElementById('basebandFilterPanel').hidden,
    settingsExpanded: document.getElementById('rxSettingsToggle').getAttribute('aria-expanded'),
  }));
  if (!firstEscape.filterHidden || firstEscape.settingsExpanded !== 'true') {
    throw new Error(`${name}: first Escape did not close P1 only`);
  }
  await page.click('#rxSettingsClose');
  if (await page.getAttribute('#rxSettingsPanel', 'aria-hidden') !== 'true') throw new Error(`${name}: settings close button failed`);
  await page.click('#rxSettingsToggle');
  await page.mouse.click(2, viewport.height / 2);
  if (await page.getAttribute('#rxSettingsPanel', 'aria-hidden') !== 'true') throw new Error(`${name}: settings scrim failed`);

  const meterPaint = await page.evaluate(async () => {
    const app = await import('./js/app.js');
    app.updateSnrMeter(20);
    const meter = document.getElementById('receiverMeter');
    const active = meter.querySelectorAll('.signal-cell.is-active').length;
    const value = meter.getAttribute('aria-valuenow');
    const text = document.getElementById('receiverLevelText').textContent;
    app.updateSnrMeter();
    return {
      active,
      value,
      text,
      max: meter.getAttribute('aria-valuemax'),
      reset: meter.querySelectorAll('.signal-cell.is-active').length,
      resetValue: meter.getAttribute('aria-valuenow'),
    };
  });
  if (meterPaint.active !== 9 || meterPaint.value !== '20.0' || meterPaint.text !== '20.0 dB' ||
      meterPaint.max !== '30' ||
      meterPaint.reset !== 0 || meterPaint.resetValue !== null) {
    throw new Error(`${name}: segmented SNR meter did not respond`);
  }

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

  const batchDecoded = await page.evaluate(async () => {
    const [{ encode }, { getMode }, { WebSSTVDecoder }, app] = await Promise.all([
      import('./js/encoder.js'), import('./js/modes.js'), import('./js/web-receiver.js'), import('./js/app.js'),
    ]);
    const sampleRate = 11025;
    const mode = getMode(2);
    const makeImage = value => {
      const rgba = new Uint8ClampedArray(mode.width * mode.height * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = value;
        rgba[i + 3] = 255;
      }
      return { rgba };
    };
    const first = encode(makeImage(35), mode, { sampleRate });
    const second = encode(makeImage(215), mode, { sampleRate });
    const pcm = new Float32Array(first.length + second.length);
    pcm.set(first);
    pcm.set(second, first.length);
    const responsivenessDecoder = new WebSSTVDecoder();
    const longProbe = new Float32Array(48000 * 300);
    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => heartbeatTicks++, 10);
    const dispatchStarted = performance.now();
    const cancelledProbe = responsivenessDecoder.decodeAll(longProbe, 48000, {
      dsp: { engine: 'mmsstv', demodulator: 'phase' },
    }).then(() => false, () => true);
    const dispatchMs = performance.now() - dispatchStarted;
    await new Promise(resolve => setTimeout(resolve, 80));
    responsivenessDecoder.cancelBatch('responsiveness probe complete');
    const probeCancelled = await cancelledProbe;
    clearInterval(heartbeat);
    responsivenessDecoder.destroy();

    const decoder = new WebSSTVDecoder();
    const batchOptions = {
      dsp: { engine: 'mmsstv', demodulator: 'phase', afc: true, lms: true },
    };
    const staleJob = decoder.decodeAll(first, sampleRate, batchOptions).then(() => false, () => true);
    const outputPromise = decoder.decodeAll(pcm, sampleRate, batchOptions);
    const [staleRejected, output] = await Promise.all([staleJob, outputPromise]);
    const selectionOffset = 12.3;
    app.setDecodedFrames(output.frames.map(frame => ({
      ...frame,
      startSec: selectionOffset + frame.audioRange.startSample / sampleRate,
      endSec: selectionOffset + frame.audioRange.endSample / sampleRate,
    })));
    decoder.destroy();
    return {
      count: output.frames.length,
      staleRejected,
      dispatchMs,
      heartbeatTicks,
      probeCancelled,
      page: document.getElementById('decodedPageCount').textContent,
      range: document.getElementById('resultAudioRange').textContent,
      previousDisabled: document.getElementById('previousDecodedFrame').disabled,
      nextDisabled: document.getElementById('nextDecodedFrame').disabled,
      paginationHidden: document.getElementById('resultPagination').hidden,
    };
  });
  if (batchDecoded.count !== 2 || !batchDecoded.staleRejected || !batchDecoded.probeCancelled ||
      batchDecoded.dispatchMs > 50 || batchDecoded.heartbeatTicks < 2 ||
      batchDecoded.page !== '01 / 02' || batchDecoded.paginationHidden ||
      !batchDecoded.previousDisabled || batchDecoded.nextDisabled || !batchDecoded.range.startsWith('00:12.3')) {
    throw new Error(`${name}: Worker multi-frame gallery failed ${JSON.stringify(batchDecoded)}`);
  }
  await page.click('#nextDecodedFrame');
  const secondPage = await page.evaluate(() => ({
    page: document.getElementById('decodedPageCount').textContent,
    previousDisabled: document.getElementById('previousDecodedFrame').disabled,
    nextDisabled: document.getElementById('nextDecodedFrame').disabled,
    canvasLabel: document.getElementById('resultCanvas').getAttribute('aria-label'),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    controlsOverlapSettings: (() => {
      const pagination = document.getElementById('resultPagination').getBoundingClientRect();
      const settings = document.getElementById('rxSettingsToggle').getBoundingClientRect();
      return pagination.left < settings.right && pagination.right > settings.left &&
        pagination.top < settings.bottom && pagination.bottom > settings.top;
    })(),
  }));
  if (secondPage.page !== '02 / 02' || secondPage.previousDisabled || !secondPage.nextDisabled ||
      !secondPage.canvasLabel.includes('第 2 张') || secondPage.overflow > 1 || secondPage.controlsOverlapSettings) {
    throw new Error(`${name}: second decoded page failed ${JSON.stringify(secondPage)}`);
  }
  await page.screenshot({ path: `test-artifacts/${name}-pagination.png`, fullPage: false });

  for (const format of ['png', 'bmp']) {
    await page.selectOption('#imageFormat', format);
    const downloadPromise = page.waitForEvent('download');
    await page.click('#saveImageBtn');
    const download = await downloadPromise;
    const bytes = await readFile(await download.path());
    const signatureOk = format === 'png'
      ? bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length > 54 && bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.readUInt16LE(28) === 24;
    if (!signatureOk || !download.suggestedFilename().includes('_002_') ||
        !download.suggestedFilename().endsWith(`.${format}`)) {
      throw new Error(`${name}: invalid ${format.toUpperCase()} download`);
    }
  }

  if (name === 'desktop') {
    await page.setInputFiles('#wavInput', join(ROOT, 'asset', 'ROBOT36_test.mp3'));
    await page.waitForFunction(() => !document.getElementById('decodeEndSec').disabled, null, { timeout: 30000 });
    const uploadReset = await page.evaluate(() => ({
      empty: document.getElementById('decoderOutput').classList.contains('is-empty'),
      saveDisabled: document.getElementById('saveImageBtn').disabled,
      resetDisabled: document.getElementById('resetDecodedBtn').disabled,
      playerIdle: document.getElementById('audioPlayerWrapper').classList.contains('is-idle'),
      playDisabled: document.getElementById('audioPlayPauseBtn').disabled,
    }));
    if (!uploadReset.empty || !uploadReset.saveDisabled || !uploadReset.resetDisabled ||
        uploadReset.playerIdle || uploadReset.playDisabled) {
      throw new Error(`desktop: new upload did not reset the decoded image or activate the player ${JSON.stringify(uploadReset)}`);
    }
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

    // Exercise the actual offline UI path with a native-rate PD120 recording.
    // Offline decode must request only the final Worker frame; provisional
    // frames repeatedly decode an ever-growing 640x496 prefix and used to turn
    // this roughly three-second decode into a forty-second operation.
    await page.setInputFiles(
      '#wavInput',
      join(ROOT, 'asset', 'voicerecord', 'processed', 'PD120_10041145.mp3')
    );
    await page.waitForFunction(
      () => Number(document.getElementById('decodeEndSec').value) > 120,
      null,
      { timeout: 30000 }
    );
    const pdStartedAt = Date.now();
    await page.click('#decodeUploadedBtn');
    await page.waitForFunction(() => {
      const panel = document.getElementById('offlineDecodeProgress');
      const button = document.getElementById('decodeUploadedBtn');
      return !panel.hidden && button.getAttribute('aria-busy') === 'true';
    });
    const pdProgressStarted = await page.evaluate(() => {
      const panel = document.getElementById('offlineDecodeProgress');
      const track = document.getElementById('offlineDecodeProgressBar');
      return {
        visible: !panel.hidden,
        status: document.getElementById('offlineDecodeProgressText').textContent,
        value: document.getElementById('offlineDecodeProgressValue').textContent,
        ariaText: track.getAttribute('aria-valuetext'),
        snrMax: document.getElementById('receiverMeter').getAttribute('aria-valuemax'),
        snrValue: document.getElementById('receiverLevelText').textContent,
      };
    });
    if (!pdProgressStarted.visible || !pdProgressStarted.status || !pdProgressStarted.ariaText ||
        pdProgressStarted.snrMax !== '30' || !pdProgressStarted.snrValue.endsWith('dB')) {
      throw new Error(`desktop: offline progress did not start ${JSON.stringify(pdProgressStarted)}`);
    }
    await page.waitForFunction(() => {
      const button = document.getElementById('decodeUploadedBtn');
      return !button.classList.contains('loading') &&
        document.getElementById('receiverMode').textContent === 'PD120' &&
        document.getElementById('resultCanvas').width === 640 &&
        document.getElementById('resultCanvas').height === 496;
    }, null, { timeout: 30000 });
    const pdElapsedMs = Date.now() - pdStartedAt;
    const pdDecoded = await page.evaluate(() => {
      const canvas = document.getElementById('resultCanvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let sampleSum = 0;
      for (let offset = 0; offset < pixels.length; offset += 4096) sampleSum += pixels[offset];
      return {
        width: canvas.width,
        height: canvas.height,
        saveEnabled: !document.getElementById('saveImageBtn').disabled,
        sampleSum,
        progressComplete: document.getElementById('offlineDecodeProgress').classList.contains('is-complete'),
        progressValue: document.getElementById('offlineDecodeProgressBar').getAttribute('aria-valuenow'),
        buttonBusy: document.getElementById('decodeUploadedBtn').hasAttribute('aria-busy'),
      };
    });
    if (pdDecoded.width !== 640 || pdDecoded.height !== 496 ||
        !pdDecoded.saveEnabled || pdDecoded.sampleSum <= 0 || !pdDecoded.progressComplete ||
        pdDecoded.progressValue !== '100' || pdDecoded.buttonBusy) {
      throw new Error(`desktop: PD120 offline decode failed ${JSON.stringify(pdDecoded)}`);
    }
    await page.click('#resetDecodedBtn');
    const manualReset = await page.evaluate(() => ({
      width: document.getElementById('resultCanvas').width,
      height: document.getElementById('resultCanvas').height,
      saveDisabled: document.getElementById('saveImageBtn').disabled,
      resetDisabled: document.getElementById('resetDecodedBtn').disabled,
      empty: document.getElementById('decoderOutput').classList.contains('is-empty'),
    }));
    if (manualReset.width !== 320 || manualReset.height !== 256 ||
        !manualReset.saveDisabled || !manualReset.resetDisabled || !manualReset.empty) {
      throw new Error(`desktop: manual decoded-image reset failed ${JSON.stringify(manualReset)}`);
    }
    await page.waitForFunction(() => {
      const panel = document.getElementById('offlineDecodeProgress');
      return !panel.hidden && panel.classList.contains('is-idle') &&
        document.getElementById('offlineDecodeProgressBar').getAttribute('aria-valuenow') === '0';
    }, null, { timeout: 3000 });
    console.log(`desktop: real PD120 offline decode ${pdElapsedMs}ms`);
  }

  await page.click('#micStartBtn');
  await page.waitForFunction(() => ['搜索信号', '已锁定'].includes(document.getElementById('receiverStatus').textContent));
  await page.click('#micStopBtn');
  await page.waitForFunction(() => document.getElementById('receiverStatus').textContent === '已停止');
  if (await page.getAttribute('#receiverMeter', 'aria-valuenow') !== null) throw new Error(`${name}: SNR meter did not reset after stop`);

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

  await page.goto(`http://127.0.0.1:${port}/encode.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#encodeBtn');
  await page.waitForFunction(() => !document.getElementById('encodeBtn').disabled);
  const encoderShell = await page.evaluate(() => ({
    page: document.body.dataset.page,
    hasDecoder: !!document.getElementById('wavDropzone') || !!document.getElementById('realtimeDecodeBtn'),
    modeCount: document.getElementById('modeSelect').options.length,
    drawerHidden: document.getElementById('navDrawer').getAttribute('aria-hidden'),
    activeNav: document.querySelector('.nav-link.is-active')?.getAttribute('href'),
    frequencyReadouts: document.querySelectorAll('.frequency-readout').length,
    settings: {
      expanded: document.getElementById('txSettingsToggle')?.getAttribute('aria-expanded'),
      hidden: document.getElementById('txSettingsPanel')?.getAttribute('aria-hidden'),
      inert: document.getElementById('txSettingsPanel')?.hasAttribute('inert'),
      ownsMode: document.getElementById('txSettingsPanel')?.contains(document.getElementById('modeSelect')),
      topbarMode: document.querySelectorAll('.topbar-actions #modeSelect').length,
    },
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    clippedButtons: [...document.querySelectorAll('button')]
      .filter(button => button.scrollWidth > button.clientWidth + 1)
      .map(button => button.id || button.textContent.trim()),
    canvas: { width: document.getElementById('srcCanvas').clientWidth, height: document.getElementById('srcCanvas').clientHeight },
  }));
  if (encoderShell.page !== 'encoder' || encoderShell.hasDecoder || encoderShell.modeCount !== 43) {
    throw new Error(`${name}: encoder page did not initialize independently`);
  }
  if (encoderShell.drawerHidden !== 'true' || !encoderShell.activeNav?.endsWith('encode.html')) {
    throw new Error(`${name}: encoder navigation state is invalid`);
  }
  if (encoderShell.frequencyReadouts !== 0 || encoderShell.settings.expanded !== 'false' ||
      encoderShell.settings.hidden !== 'true' || !encoderShell.settings.inert ||
      !encoderShell.settings.ownsMode || encoderShell.settings.topbarMode !== 0) {
    throw new Error(`${name}: encoder settings do not start collapsed or still expose the old header mode`);
  }
  if (encoderShell.overflow > 1 || encoderShell.clippedButtons.length) {
    throw new Error(`${name}: encoder layout overflow/clipping ${encoderShell.overflow}px ${encoderShell.clippedButtons.join(',')}`);
  }
  if (encoderShell.canvas.width <= 0 || encoderShell.canvas.height <= 0) throw new Error(`${name}: encoder source canvas has no layout`);

  await page.click('#txSettingsToggle');
  await page.waitForFunction(() => document.getElementById('txSettingsPanel').getAttribute('aria-hidden') === 'false');
  await page.click('#txSettingsPanel .custom-select-trigger');
  const txMenuBox = await page.locator('#txSettingsPanel .custom-select-menu').boundingBox();
  if (!txMenuBox || txMenuBox.x < 0 || txMenuBox.y < 0 ||
      txMenuBox.x + txMenuBox.width > viewport.width || txMenuBox.y + txMenuBox.height > viewport.height) {
    throw new Error(`${name}: encoder mode menu is clipped ${JSON.stringify(txMenuBox)}`);
  }
  await page.click('#txSettingsPanel .custom-select-option[data-value="8"]');
  if (await page.inputValue('#modeSelect') !== '8') throw new Error(`${name}: encoder floating mode setting did not update TX mode`);
  await page.screenshot({ path: `test-artifacts/${name}-encode-settings.png`, fullPage: false });
  await page.click('#txSettingsClose');
  if (await page.getAttribute('#txSettingsPanel', 'aria-hidden') !== 'true') throw new Error(`${name}: encoder settings close button failed`);
  await page.click('#txSettingsToggle');
  await page.keyboard.press('Escape');
  if (await page.getAttribute('#txSettingsPanel', 'aria-hidden') !== 'true') throw new Error(`${name}: encoder settings Escape close failed`);

  await page.click('#navToggle');
  if (await page.getAttribute('#navDrawer', 'aria-hidden') !== 'false') throw new Error(`${name}: encoder navigation did not open`);
  await clickVisibleScrim(page);
  await page.screenshot({ path: `test-artifacts/${name}-encode.png`, fullPage: false });
  if (errors.length) throw new Error(`${name}: page errors after encoder load: ${errors.join('; ')}`);
  await context.close();
  console.log(`${name}: ${viewport.width}x${viewport.height}, RX/TX pages, ${decoded.mode} ${decoded.width}x${decoded.height}, no overflow`);
}

try {
  await verifyViewport('desktop', { width: 1440, height: 1000 });
  await verifyViewport('compact', { width: 1366, height: 768 });
  await verifyViewport('mobile', { width: 390, height: 844 });
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
