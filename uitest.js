// uitest.js - jsdom UI smoke checks against the real page.
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const encoderHtml = await readFile(new URL('./encode.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;
global.URL = window.URL;
global.Blob = window.Blob;
global.HTMLCanvasElement = window.HTMLCanvasElement;
global.Image = window.Image;
global.FileReader = window.FileReader;
global.localStorage = window.localStorage;
global.OffscreenCanvas = undefined;
global.Worker = undefined;
global.requestAnimationFrame = () => 0;

HTMLCanvasElement.prototype.getContext = function () {
  return {
    drawImage() {}, clearRect() {}, save() {}, restore() {},
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {}, createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    set fillStyle(v) {}, get fillStyle() { return ''; }, set strokeStyle(v) {}, set lineWidth(v) {},
    set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    createLinearGradient() { return { addColorStop() {} }; },
  };
};
HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';

localStorage.setItem('sstv.imageFormat', 'bmp');
const errors = [];
window.addEventListener('error', event => errors.push(event.message));
const app = await import('./js/app.js');
await new Promise(resolve => setTimeout(resolve, 50));

const selects = document.querySelectorAll('#modeSelect');
const modeNames = [...selects[0].options].map(option => option.textContent.split('  ')[0]);
const oneModeSelector = selects.length === 1 && !document.getElementById('rxModeSelect');
const priorityOrder = modeNames.slice(0, 3).join('|') === 'PD120|Robot 36|Robot 72';
const autoDefault = document.getElementById('autoReceive').checked;
const rangeDisabled = document.getElementById('decodeStartSec').disabled &&
  document.getElementById('decodeEndSec').disabled;
const formatRestored = document.getElementById('imageFormat').value === 'bmp';
document.getElementById('imageFormat').value = 'png';
document.getElementById('imageFormat').dispatchEvent(new window.Event('change'));
const formatSaved = localStorage.getItem('sstv.imageFormat') === 'png';
const bpfDefaultsOff = !document.getElementById('dspBpf').checked;
const filterButton = document.getElementById('basebandFilterBtn');
const filterPanel = document.getElementById('basebandFilterPanel');
filterButton.click();
const filterPanelOpens = !filterPanel.hidden && filterButton.getAttribute('aria-expanded') === 'true';
const lowFilter = document.getElementById('basebandLow');
const highFilter = document.getElementById('basebandHigh');
lowFilter.value = '2900';
lowFilter.dispatchEvent(new window.Event('input'));
const gapConstrained = Number(highFilter.value) - Number(lowFilter.value) >= 200;
lowFilter.value = '1200';
lowFilter.dispatchEvent(new window.Event('input'));
highFilter.value = '2600';
highFilter.dispatchEvent(new window.Event('input'));
const filterSaved = localStorage.getItem('sstv.basebandLowHz') === '1200' &&
  localStorage.getItem('sstv.basebandHighHz') === '2600';
document.getElementById('basebandResetBtn').click();
const dspDefaults = app.readDspOptions();
const filterReset = dspDefaults.demodulator === 'phase' && dspDefaults.bpf === false &&
  dspDefaults.baseband.lowHz === 1000 && dspDefaults.baseband.highHz === 2800;
const decodeButtons = [...document.querySelectorAll('.decode-actions button')].map(button => button.id);
const decoderOnly = !document.getElementById('encodeBtn') &&
  decodeButtons.join('|') === 'realtimeDecodeBtn|decodeUploadedBtn';
const navButton = document.getElementById('navToggle');
const navDrawer = document.getElementById('navDrawer');
const navDefaultHidden = navButton.getAttribute('aria-expanded') === 'false' &&
  navDrawer.getAttribute('aria-hidden') === 'true' && !navDrawer.classList.contains('is-open');
navButton.click();
const navOpens = navButton.getAttribute('aria-expanded') === 'true' &&
  navDrawer.getAttribute('aria-hidden') === 'false' && navDrawer.classList.contains('is-open');
document.getElementById('navScrim').click();
const navCloses = navButton.getAttribute('aria-expanded') === 'false' &&
  navDrawer.getAttribute('aria-hidden') === 'true';
app.updateSignalMeter(67);
const meter = document.getElementById('receiverMeter');
const meterResponds = meter.querySelectorAll('.signal-cell').length === 12 &&
  meter.querySelectorAll('.signal-cell.is-active').length === 9 && meter.getAttribute('aria-valuenow') === '67';
app.updateSignalMeter(0);
const meterResets = meter.querySelectorAll('.signal-cell.is-active').length === 0 &&
  document.getElementById('receiverLevelText').textContent === '0%';
const offlineProgressPanel = document.getElementById('offlineDecodeProgress');
const offlineProgressBar = document.getElementById('offlineDecodeProgressBar');
const offlineProgressStartsHidden = offlineProgressPanel.hidden;
app.setOfflineDecodeProgress(null, '正在分析 VIS / 同步');
const offlineProgressScans = !offlineProgressPanel.hidden &&
  offlineProgressBar.classList.contains('is-indeterminate') &&
  !offlineProgressBar.hasAttribute('aria-valuenow');
app.setOfflineDecodeProgress(0.42, '正在读取图像行 180 / 496');
const offlineProgressAdvances = !offlineProgressBar.classList.contains('is-indeterminate') &&
  offlineProgressBar.getAttribute('aria-valuenow') === '42' &&
  offlineProgressBar.querySelector('.bar').style.width === '42%' &&
  document.getElementById('offlineDecodeProgressValue').textContent === '42%';
app.setOfflineDecodeProgress(1, 'PD120 · 解码完成', 'complete');
const offlineProgressCompletes = offlineProgressPanel.classList.contains('is-complete') &&
  offlineProgressBar.getAttribute('aria-valuenow') === '100';
app.hideOfflineDecodeProgress();
const offlineProgressHides = offlineProgressPanel.hidden;
const encoderDom = new JSDOM(encoderHtml).window.document;
const encoderIsSeparate = encoderDom.body.dataset.page === 'encoder' &&
  !!encoderDom.getElementById('encodeBtn') && !!encoderDom.getElementById('modeSelect') &&
  !encoderDom.getElementById('wavDropzone') && !encoderDom.getElementById('realtimeDecodeBtn');
const deerflowCredit = [document, encoderDom].every(doc =>
  doc.querySelector('.deerflow-mark')?.getAttribute('href') === 'https://deerflow.tech');
const checks = {
  'single 43-mode selector': oneModeSelector && selects[0].options.length === 43,
  'priority mode order': priorityOrder,
  'automatic receive defaults on': autoDefault,
  'range inputs disabled before audio load': rangeDisabled,
  'image format preference restores and saves': formatRestored && formatSaved,
  'legacy BPF defaults off': bpfDefaultsOff,
  'baseband filter panel opens': filterPanelOpens,
  'baseband sliders constrain and persist': gapConstrained && filterSaved,
  'baseband reset feeds phase DSP options': filterReset,
  'decoder page exposes exactly two decode commands': decoderOnly,
  'navigation starts hidden and toggles safely': navDefaultHidden && navOpens && navCloses,
  '12-cell signal meter responds and resets': meterResponds && meterResets,
  'offline decoder progress animates and reports ARIA state': offlineProgressStartsHidden &&
    offlineProgressScans && offlineProgressAdvances && offlineProgressCompletes && offlineProgressHides,
  'encoder has a separate page shell': encoderIsSeparate,
  'design credit is present on both pages': deerflowCredit,
  'application initializes without errors': errors.length === 0,
};

for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (Object.values(checks).some(passed => !passed)) process.exit(1);
