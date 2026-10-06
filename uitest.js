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
global.ImageData = window.ImageData || class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};
global.Image = window.Image;
global.FileReader = window.FileReader;
global.localStorage = window.localStorage;
global.OffscreenCanvas = undefined;
global.Worker = undefined;
// No live orbital service calls in the DOM smoke test.
global.fetch = async () => { throw new Error('offline test'); };
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
localStorage.setItem('sstv.basebandLowHz', '1610');
localStorage.setItem('sstv.basebandHighHz', '2100');
const errors = [];
window.addEventListener('error', event => errors.push(event.message));
const app = await import('./js/app.js');
await new Promise(resolve => setTimeout(resolve, 50));

const selects = document.querySelectorAll('#modeSelect');
const modeNames = [...selects[0].options].map(option => option.textContent.split('  ')[0]);
const oneModeSelector = selects.length === 1 && !document.getElementById('rxModeSelect');
const priorityOrder = modeNames.slice(0, 3).join('|') === 'PD120|Robot 36|Robot 72';
const autoDefault = document.getElementById('autoReceive').checked;
const modeSelect = document.getElementById('modeSelect');
const modeTrigger = modeSelect.previousElementSibling;
const autoLocksManualMode = modeSelect.disabled && modeSelect.tabIndex === -1 && modeTrigger.disabled;
document.getElementById('autoReceive').checked = false;
document.getElementById('autoReceive').dispatchEvent(new window.Event('change', { bubbles: true }));
const manualModeUnlocks = !modeSelect.disabled && !modeTrigger.disabled;
modeTrigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
const modeMenu = document.getElementById('modeSelectMenu');
const selectedModeOption = modeMenu.querySelector('.is-selected');
const customSelectOpensFromKeyboard = !modeMenu.hidden && modeTrigger.getAttribute('aria-expanded') === 'true' &&
  document.activeElement === selectedModeOption;
selectedModeOption.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
const nextModeOption = document.activeElement;
nextModeOption.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const customSelectChoosesAndRestoresFocus = modeMenu.hidden && document.activeElement === modeTrigger &&
  modeSelect.value === nextModeOption.dataset.value;
document.getElementById('autoReceive').checked = true;
document.getElementById('autoReceive').dispatchEvent(new window.Event('change', { bubbles: true }));
const rangeDisabled = document.getElementById('decodeStartSec').disabled &&
  document.getElementById('decodeEndSec').disabled;
const formatRestored = document.getElementById('imageFormat').value === 'bmp';
document.getElementById('imageFormat').value = 'png';
document.getElementById('imageFormat').dispatchEvent(new window.Event('change'));
const formatSaved = localStorage.getItem('sstv.imageFormat') === 'png';
const bpfDefaultsOff = !document.getElementById('dspBpf').checked;
const receiverEnhancementsDefaultOn = document.getElementById('dspAfc').checked &&
  document.getElementById('dspLms').checked;
const nightThemeDefault = document.documentElement.getAttribute('data-theme') === 'dark' &&
  document.getElementById('themeToggle').textContent === '🌙';
const settingsToggle = document.getElementById('rxSettingsToggle');
const settingsPanel = document.getElementById('rxSettingsPanel');
const settingsControls = ['modeSelect', 'autoReceive', 'dspAfc', 'dspLms', 'dspBpf', 'basebandFilterBtn', 'basebandFilterPanel'];
const settingsDefaultHidden = settingsToggle.getAttribute('aria-expanded') === 'false' &&
  settingsPanel.getAttribute('aria-hidden') === 'true' && settingsPanel.hasAttribute('inert') &&
  !settingsPanel.classList.contains('is-open');
const settingsOwnsControls = settingsControls.every(id => settingsPanel.contains(document.getElementById(id))) &&
  !document.querySelector('.topbar-actions').contains(document.getElementById('modeSelect')) &&
  !document.querySelector('.topbar-actions').contains(document.getElementById('autoReceive'));
settingsToggle.click();
const settingsOpens = settingsToggle.getAttribute('aria-expanded') === 'true' &&
  settingsPanel.getAttribute('aria-hidden') === 'false' && !settingsPanel.hasAttribute('inert') &&
  settingsPanel.classList.contains('is-open') && !document.getElementById('rxSettingsScrim').hidden &&
  settingsPanel.contains(document.activeElement);
const filterButton = document.getElementById('basebandFilterBtn');
const filterPanel = document.getElementById('basebandFilterPanel');
filterButton.click();
const filterPanelOpens = !filterPanel.hidden && filterButton.getAttribute('aria-expanded') === 'true';
const lowFilter = document.getElementById('basebandLow');
const highFilter = document.getElementById('basebandHigh');
const filtersShareOneRowGroup = lowFilter.closest('.filter-slider-row')?.parentElement?.classList.contains('filter-slider-grid') &&
  lowFilter.closest('.filter-slider-row')?.parentElement === highFilter.closest('.filter-slider-row')?.parentElement;
const unsafeFilterMigrated = lowFilter.value === '1000' && highFilter.value === '2800' &&
  localStorage.getItem('sstv.basebandLowHz') === '1000' &&
  localStorage.getItem('sstv.basebandHighHz') === '2800';
lowFilter.value = '2900';
lowFilter.dispatchEvent(new window.Event('input'));
highFilter.value = '2100';
highFilter.dispatchEvent(new window.Event('input'));
const protocolRangeConstrained = Number(lowFilter.value) <= 1000 && Number(highFilter.value) >= 2400 &&
  lowFilter.max === '1000' && highFilter.min === '2400';
lowFilter.value = '900';
lowFilter.dispatchEvent(new window.Event('input'));
highFilter.value = '2600';
highFilter.dispatchEvent(new window.Event('input'));
const filterSaved = localStorage.getItem('sstv.basebandLowHz') === '900' &&
  localStorage.getItem('sstv.basebandHighHz') === '2600';
lowFilter.max = '3000';
highFilter.min = '700';
lowFilter.value = '1610';
highFilter.value = '2100';
const defendedOptions = app.readDspOptions();
const unsafeDomRangeRejected = defendedOptions.baseband.lowHz === 1000 &&
  defendedOptions.baseband.highHz === 2800;
lowFilter.max = '1000';
highFilter.min = '2400';
document.getElementById('basebandResetBtn').click();
const dspDefaults = app.readDspOptions();
const filterReset = dspDefaults.demodulator === 'phase' && dspDefaults.bpf === false &&
  dspDefaults.baseband.lowHz === 1000 && dspDefaults.baseband.highHz === 2800;
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const nestedEscapeClosesFilterOnly = filterPanel.hidden && filterButton.getAttribute('aria-expanded') === 'false' &&
  settingsToggle.getAttribute('aria-expanded') === 'true';
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const secondEscapeClosesSettings = settingsToggle.getAttribute('aria-expanded') === 'false' &&
  settingsPanel.getAttribute('aria-hidden') === 'true' && settingsPanel.hasAttribute('inert') &&
  document.activeElement === settingsToggle;
settingsToggle.click();
document.getElementById('rxSettingsScrim').click();
const settingsScrimCloses = settingsToggle.getAttribute('aria-expanded') === 'false' &&
  settingsPanel.getAttribute('aria-hidden') === 'true';
const decodeButtons = [...document.querySelectorAll('.decode-actions button')].map(button => button.id);
const decoderOnly = !document.getElementById('encodeBtn') &&
  decodeButtons.join('|') === 'micReceiveBtn|offlineDecodeBtn' &&
  !!document.getElementById('fastDecodeMode') &&
  !document.getElementById('realtimeDecodeBtn') && !document.getElementById('decodeUploadedBtn') &&
  !document.getElementById('micStartBtn') && !document.getElementById('micStopBtn');
const receiveButton = document.getElementById('micReceiveBtn');
const receiveButtonStartsReady = receiveButton.textContent.trim() === '开始接收' &&
  receiveButton.getAttribute('aria-pressed') === 'false' && receiveButton.disabled;
const offlineDecodeButton = document.getElementById('offlineDecodeBtn');
const fastDecodeMode = document.getElementById('fastDecodeMode');
const offlineDecodeStartsStandard = document.getElementById('offlineDecodeLabel').textContent === '播放并实时解码' &&
  offlineDecodeButton.classList.contains('accent') && !offlineDecodeButton.classList.contains('primary') &&
  offlineDecodeButton.title.includes('扬声器发声');
fastDecodeMode.checked = true;
fastDecodeMode.dispatchEvent(new window.Event('change', { bubbles: true }));
const fastDecodeToggleWorks = document.getElementById('offlineDecodeLabel').textContent === '极速解码' &&
  offlineDecodeButton.classList.contains('primary') && !offlineDecodeButton.classList.contains('accent');
fastDecodeMode.checked = false;
fastDecodeMode.dispatchEvent(new window.Event('change', { bubbles: true }));
const audioPlayerWrapper = document.getElementById('audioPlayerWrapper');
const permanentPlayerStartsIdle = !audioPlayerWrapper.hidden &&
  audioPlayerWrapper.classList.contains('is-idle') &&
  document.getElementById('audioPlayPauseBtn').disabled;
const resultFooterStartsPersistent = !document.getElementById('resultFrameInfo').hidden &&
  !document.getElementById('resultPagination').hidden &&
  document.getElementById('decodedPageCount').textContent === '00 / 00' &&
  document.getElementById('previousDecodedFrame').disabled &&
  document.getElementById('nextDecodedFrame').disabled;
const receiverLiveRegionsAreScoped = !document.getElementById('receiverPanelState').hasAttribute('aria-live') &&
  document.querySelector('.receiver-telemetry')?.getAttribute('role') === 'status' &&
  document.querySelector('.receiver-telemetry')?.getAttribute('aria-live') === 'polite';
const navButton = document.getElementById('navToggle');
const navDrawer = document.getElementById('navDrawer');
const navDefaultHidden = navButton.getAttribute('aria-expanded') === 'false' &&
  navDrawer.getAttribute('aria-hidden') === 'true' && navDrawer.hasAttribute('inert') && !navDrawer.classList.contains('is-open');
navButton.click();
const navOpens = navButton.getAttribute('aria-expanded') === 'true' &&
  navDrawer.getAttribute('aria-hidden') === 'false' && !navDrawer.hasAttribute('inert') && navDrawer.classList.contains('is-open') &&
  navDrawer.contains(document.activeElement) && document.querySelector('main').hasAttribute('inert');
document.getElementById('navScrim').click();
const navCloses = navButton.getAttribute('aria-expanded') === 'false' &&
  navDrawer.getAttribute('aria-hidden') === 'true' && document.activeElement === navButton &&
  !document.querySelector('main').hasAttribute('inert');
app.updateSnrMeter(20);
const meter = document.getElementById('receiverMeter');
const meterResponds = meter.querySelectorAll('.signal-cell').length === 12 &&
  meter.querySelectorAll('.signal-cell.is-active').length === 9 &&
  meter.getAttribute('aria-valuemax') === '30' &&
  meter.getAttribute('aria-valuenow') === '20.0' &&
  document.getElementById('receiverLevelText').textContent === '20.0 dB';
app.updateSnrMeter();
const meterResets = meter.querySelectorAll('.signal-cell.is-active').length === 0 &&
  !meter.hasAttribute('aria-valuenow') &&
  document.getElementById('receiverLevelText').textContent === '-- dB';
const offlineProgressPanel = document.getElementById('offlineDecodeProgress');
const offlineProgressBar = document.getElementById('offlineDecodeProgressBar');
const offlineProgressStartsIdle = !offlineProgressPanel.hidden &&
  offlineProgressPanel.classList.contains('is-idle') &&
  offlineProgressPanel.contains(offlineProgressBar) &&
  offlineProgressBar.getAttribute('aria-valuenow') === '0' &&
  document.getElementById('offlineDecodeProgressText').textContent === '等待解码';
app.updateSnrMeter(20);
app.setOfflineDecodeProgress(null, '正在分析 VIS / 同步');
const offlineProgressScans = !offlineProgressPanel.hidden &&
  offlineProgressBar.classList.contains('is-indeterminate') &&
  !offlineProgressBar.hasAttribute('aria-valuenow') &&
  meter.querySelectorAll('.signal-cell.is-active').length === 9 &&
  document.getElementById('receiverLevelText').textContent === '20.0 dB';
app.setOfflineDecodeProgress(0.42, '正在读取图像行 180 / 496');
const offlineProgressAdvances = !offlineProgressBar.classList.contains('is-indeterminate') &&
  offlineProgressBar.getAttribute('aria-valuenow') === '42' &&
  offlineProgressBar.querySelector('.bar').style.width === '42%' &&
  document.getElementById('offlineDecodeProgressValue').textContent === '42%' &&
  meter.querySelectorAll('.signal-cell.is-active').length === 9;
app.setOfflineDecodeProgress(1, 'PD120 · 解码完成', 'complete');
const offlineProgressCompletes = offlineProgressPanel.classList.contains('is-complete') &&
  offlineProgressBar.getAttribute('aria-valuenow') === '100';
app.hideOfflineDecodeProgress();
const offlineProgressReturnsIdle = !offlineProgressPanel.hidden &&
  offlineProgressPanel.classList.contains('is-idle') &&
  offlineProgressBar.getAttribute('aria-valuenow') === '0' &&
  document.getElementById('offlineDecodeProgressValue').textContent === '0%' &&
  document.getElementById('receiverLevelText').textContent === '20.0 dB';
app.updateSnrMeter();
const receiverPanelLabel = document.querySelector('#receiverPanelState span');
let receiverPanelMutations = 0;
const receiverPanelObserver = new window.MutationObserver(records => { receiverPanelMutations += records.length; });
receiverPanelObserver.observe(receiverPanelLabel, { childList: true, characterData: true, subtree: true });
for (let rows = 1; rows <= 100; rows++) app.updateReceiverRowPresentation({ rows, totalRows: 100 });
await Promise.resolve();
receiverPanelObserver.disconnect();
const receiverPanelProgressThrottles = receiverPanelLabel.textContent === 'RECEIVING · 100%' &&
  receiverPanelMutations === 11;
app.updateReceiverSearchingPresentation(2, false);
const receiverSearchesNextConsistently = receiverPanelLabel.textContent === 'SEARCHING NEXT' &&
  offlineProgressBar.classList.contains('is-indeterminate') &&
  !offlineProgressBar.hasAttribute('aria-valuenow') &&
  document.getElementById('offlineDecodeProgressText').textContent === '等待下一帧 · 已完成 2 张';
const completeTransmission = {
  frameId: 71,
  mode: { name: 'Robot 36' },
  rows: 240,
  complete: true,
  completionRatio: 1,
  reason: 'nominal-tail',
};
const eligiblePromptContext = {
  micActive: true,
  micStarting: false,
  micStopPending: false,
  realtimeActive: false,
  dialogOpen: false,
};
const receiveCompletionEligibility =
  app.shouldPromptReceiveCompletion(completeTransmission, eligiblePromptContext) &&
  !app.shouldPromptReceiveCompletion({ ...completeTransmission, complete: false }, eligiblePromptContext) &&
  !app.shouldPromptReceiveCompletion({ ...completeTransmission, reason: 'explicit-end' }, eligiblePromptContext) &&
  !app.shouldPromptReceiveCompletion(completeTransmission, { ...eligiblePromptContext, micActive: false }) &&
  !app.shouldPromptReceiveCompletion(completeTransmission, { ...eligiblePromptContext, micStopPending: true }) &&
  !app.shouldPromptReceiveCompletion(completeTransmission, { ...eligiblePromptContext, realtimeActive: true }) &&
  !app.shouldPromptReceiveCompletion(completeTransmission, { ...eligiblePromptContext, dialogOpen: true });
const preexistingInertBodyChildren = new Set(
  [...document.body.children].filter(element => element.hasAttribute('inert'))
);
const completionReturnFocus = document.getElementById('themeToggle');
completionReturnFocus.focus();
app.openReceiveCompletionDialog(completeTransmission);
const completionDialog = document.getElementById('receiveCompleteDialog');
const receiveCompletionDialogAccessible = !completionDialog.hidden &&
  completionDialog.getAttribute('role') === 'dialog' &&
  completionDialog.getAttribute('aria-modal') === 'true' &&
  completionDialog.getAttribute('aria-hidden') === 'false' &&
  document.activeElement === document.getElementById('receiveCompleteContinue') &&
  document.getElementById('receiveCompleteMode').textContent.includes('Robot 36') &&
  [...document.body.children]
    .filter(element => element !== completionDialog)
    .every(element => element.hasAttribute('inert')) &&
  document.getElementById('recordingSaveDialog').hidden;
completionDialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const receiveCompletionEscapeContinues = completionDialog.hidden &&
  completionDialog.getAttribute('aria-hidden') === 'true' &&
  document.activeElement === completionReturnFocus &&
  [...document.body.children]
    .filter(element => element !== completionDialog)
    .every(element => element.hasAttribute('inert') === preexistingInertBodyChildren.has(element));
app.openReceiveCompletionDialog({ ...completeTransmission, frameId: 72 });
app.cancelReceiveCompletionPrompt();
const receiveCompletionCancellationCloses = completionDialog.hidden &&
  completionDialog.getAttribute('aria-hidden') === 'true' &&
  document.activeElement === completionReturnFocus;
app.renderReceiverFrame({
  mode: { name: 'TEST' },
  width: 2,
  height: 1,
  pixels: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
  dsp: {},
});
app.renderReceiverFrame({
  mode: { name: 'TEST 2' },
  width: 2,
  height: 1,
  pixels: new Uint8ClampedArray([0, 0, 255, 255, 255, 255, 255, 255]),
  dsp: {},
}, { append: true });
const liveFramesAppend = document.getElementById('decodedPageCount').textContent === '02 / 02' &&
  document.getElementById('receiverMode').textContent === 'TEST 2' &&
  !document.getElementById('previousDecodedFrame').disabled;
const livePartialResult = {
  mode: { name: 'LIVE PARTIAL' }, width: 2, height: 1,
  pixels: new Uint8ClampedArray([40, 40, 40, 255, 50, 50, 50, 255]),
  completionRatio: 0.25, dsp: {},
};
app.renderReceiverFrame(livePartialResult, { append: true, partial: true, completionRatio: 0.25 });
let pageCountMutations = 0;
const pageCountObserver = new window.MutationObserver(records => { pageCountMutations += records.length; });
pageCountObserver.observe(document.getElementById('decodedPageCount'), { childList: true, characterData: true, subtree: true });
app.renderReceiverFrame(livePartialResult, { append: true, partial: true, completionRatio: 0.75 });
await Promise.resolve();
pageCountObserver.disconnect();
const livePartialReplacesInPlace = document.getElementById('decodedPageCount').textContent === '03 / 03' &&
  document.getElementById('resultIncomplete').textContent === 'LIVE · 接收中 75%' &&
  document.getElementById('resultIncomplete').classList.contains('is-live') &&
  document.getElementById('saveImageBtn').disabled &&
  document.getElementById('decoderOutput').classList.contains('is-live-preview') &&
  document.getElementById('decoderOutput').style.getPropertyValue('--receive-scanline-top') === '75%' &&
  pageCountMutations === 0;
app.renderReceiverFrame({ ...livePartialResult, mode: { name: 'LIVE FINAL' } }, { append: true });
const liveFinalReplacesPartial = document.getElementById('decodedPageCount').textContent === '03 / 03' &&
  document.getElementById('receiverMode').textContent === 'LIVE FINAL' &&
  document.getElementById('resultIncomplete').hidden &&
  !document.getElementById('saveImageBtn').disabled &&
  !document.getElementById('decoderOutput').classList.contains('is-live-preview');
app.renderReceiverFrame(
  { ...livePartialResult, mode: { name: 'TRUNCATED FINAL' } },
  { append: true, complete: false, completionRatio: 0.6 }
);
const incompleteFinalKeepsSemanticState = document.getElementById('resultIncomplete').textContent === '不完整 60%' &&
  !document.getElementById('resultIncomplete').classList.contains('is-live') &&
  !document.getElementById('saveImageBtn').disabled &&
  !document.getElementById('decoderOutput').classList.contains('is-live-preview');
app.beginReceiverFrame({
  frameId: 99,
  width: 2,
  height: 1,
  mode: { name: 'FAILED LIVE' },
  dsp: {},
});
app.applyReceiverFramePatch({
  frameId: 99,
  y: 0,
  rowCount: 1,
  rows: 1,
  totalRows: 2,
  pixels: new Uint8ClampedArray([90, 90, 90, 255, 100, 100, 100, 255]),
});
app.finalizeReceiverFrameError({ frameId: 99 });
const failedFinalFreezesPreview = document.getElementById('resultIncomplete').textContent === '不完整 50%' &&
  !document.getElementById('resultIncomplete').classList.contains('is-live') &&
  !document.getElementById('saveImageBtn').disabled &&
  !document.getElementById('decoderOutput').classList.contains('is-live-preview');
const decodedResultEnablesReset = !document.getElementById('resetDecodedBtn').disabled &&
  !document.getElementById('saveImageBtn').disabled &&
  !document.getElementById('decoderOutput').classList.contains('is-empty');
const firstBatchResult = {
  result: {
    mode: { name: 'TEST' }, width: 2, height: 1,
    pixels: new Uint8ClampedArray([20, 20, 20, 255, 30, 30, 30, 255]), dsp: {},
  },
  startSec: 12.3, endSec: 31.8, complete: true, completionRatio: 1,
};
const secondBatchResult = {
  result: {
    mode: { name: 'TEST' }, width: 3, height: 1,
    pixels: new Uint8ClampedArray(12), dsp: {},
  },
  startSec: 45.2, endSec: 52.1, complete: false, completionRatio: 0.62,
};
app.setDecodedFrames([firstBatchResult, secondBatchResult]);
const paginationStartsAtFirst = !document.getElementById('resultFrameInfo').hidden &&
  !document.getElementById('resultPagination').hidden &&
  document.getElementById('resultAudioRange').textContent === '00:12.3 - 00:31.8' &&
  document.getElementById('decodedPageCount').textContent === '01 / 02' &&
  document.getElementById('previousDecodedFrame').disabled &&
  !document.getElementById('nextDecodedFrame').disabled;
document.getElementById('nextDecodedFrame').click();
const paginationShowsPartialSecond = document.getElementById('decodedPageCount').textContent === '02 / 02' &&
  document.getElementById('resultAudioRange').textContent === '00:45.2 - 00:52.1' &&
  document.getElementById('resultIncomplete').textContent === '不完整 62%' &&
  !document.getElementById('resultIncomplete').hidden &&
  document.getElementById('nextDecodedFrame').disabled &&
  document.getElementById('resultCanvas').getAttribute('aria-label').includes('第 2 张');
app.setDecodedFrames([{ ...firstBatchResult, startSec: 3661.2, endSec: 3723.4 }]);
const hourRangeFormatting = document.getElementById('resultAudioRange').textContent === '1:01:01.2 - 1:02:03.4';
app.setDecodedFrames([firstBatchResult]);
const singleFrameKeepsPagination = !document.getElementById('resultPagination').hidden &&
  !document.getElementById('resultFrameInfo').hidden &&
  document.getElementById('decodedPageCount').textContent === '01 / 01' &&
  document.getElementById('previousDecodedFrame').disabled &&
  document.getElementById('nextDecodedFrame').disabled &&
  document.getElementById('resultAudioRange').textContent === '00:12.3 - 00:31.8';
const filenameTimesUsePlainSeconds = app.audioTimeFilenameToken(61.2) === '61.2' &&
  app.audioTimeFilenameToken(3723.4) === '3723.4' &&
  !/[hms]/.test(`${app.audioTimeFilenameToken(61.2)}${app.audioTimeFilenameToken(3723.4)}`);
document.getElementById('receiverPanelState').className = 'panel-state is-complete';
receiverPanelLabel.textContent = 'FRAME 1 COMPLETE';
app.resetDecodedResult();
const decodedResultResets = document.getElementById('resultCanvas').width === 320 &&
  document.getElementById('resultCanvas').height === 256 &&
  document.getElementById('receiverMode').textContent === '--' &&
  document.getElementById('receiverAfc').textContent === '--' &&
  document.getElementById('resetDecodedBtn').disabled &&
  document.getElementById('saveImageBtn').disabled &&
  document.getElementById('decodedPageCount').textContent === '00 / 00' &&
  document.getElementById('resultAudioRange').textContent === '--:--.- - --:--.-' &&
  document.getElementById('decoderOutput').classList.contains('is-empty') &&
  document.getElementById('receiverPanelState').classList.contains('is-standby') &&
  receiverPanelLabel.textContent === 'STANDBY';
const encoderDom = new JSDOM(encoderHtml).window.document;
const encoderIsSeparate = encoderDom.body.dataset.page === 'encoder' &&
  !!encoderDom.getElementById('encodeBtn') && !!encoderDom.getElementById('modeSelect') &&
  !encoderDom.getElementById('wavDropzone') && !encoderDom.getElementById('offlineDecodeBtn');
const encoderSettingsPanel = encoderDom.getElementById('txSettingsPanel');
const encoderSettingsCollapsed = encoderDom.getElementById('txSettingsToggle')?.getAttribute('aria-expanded') === 'false' &&
  encoderSettingsPanel?.getAttribute('aria-hidden') === 'true' && encoderSettingsPanel?.hasAttribute('inert') &&
  encoderSettingsPanel?.contains(encoderDom.getElementById('modeSelect')) &&
  !encoderDom.querySelector('.topbar-actions #modeSelect');
const encoderModeSummary = encoderDom.getElementById('txCurrentMode') &&
  encoderDom.getElementById('txChangeModeBtn')?.getAttribute('aria-controls') === 'txSettingsPanel';
const encoderProgressAccessible = encoderDom.getElementById('encProgress')?.getAttribute('role') === 'progressbar' &&
  encoderDom.getElementById('encProgress')?.getAttribute('aria-valuenow') === '0';
const timelineAccessible = document.querySelector('.audio-timeline-container')?.getAttribute('role') === 'slider' &&
  [...document.querySelectorAll('.audio-selection-handle')].every(handle =>
    handle.getAttribute('role') === 'slider' && handle.tabIndex === 0
  );
const fontPrivacy = !/fonts\.(?:googleapis|gstatic)\.com/.test(`${html}${encoderHtml}`) &&
  [document, encoderDom].every(doc => doc.querySelector('.console-intro p:last-child')?.textContent.includes('媒体仅在本机处理，不会上传'));
const decoderWorkspaceStructured = document.getElementById('decoderControls')?.parentElement === document.querySelector('.decoder-workspace') &&
  document.getElementById('decoderOutput')?.parentElement === document.querySelector('.decoder-workspace');
const frequencyReadoutsRemoved = [document, encoderDom].every(doc => !doc.querySelector('.frequency-readout'));
const decodedMetadataRemoved = !document.getElementById('resultMeta') && !document.querySelector('.result-heading .meta');
const rowsTelemetryRemoved = !document.getElementById('receiverRows') &&
  ![...document.querySelectorAll('.receiver-telemetry small')].some(label => label.textContent === 'ROWS');
const centeredProjectLinks = [document, encoderDom].every(doc => {
  const footer = doc.querySelector('.radio-footer');
  const links = [...footer.querySelectorAll('nav a')];
  return !footer.querySelector('.deerflow-mark') && footer.children.length === 1 &&
    links.length === 2 && links[0].textContent.trim() === 'SOURCE' &&
    links[1].textContent.trim() === 'LICENSE' &&
    links[0].querySelector('.github-icon') && links[1].querySelector('.license-icon');
});
const checks = {
  'single 43-mode selector': oneModeSelector && selects[0].options.length === 43,
  'priority mode order': priorityOrder,
  'automatic receive defaults on': autoDefault,
  'AUTO disables manual RX mode without a duplicate tab stop': autoLocksManualMode && manualModeUnlocks,
  'custom select supports keyboard selection and restores focus': customSelectOpensFromKeyboard && customSelectChoosesAndRestoresFocus,
  'range inputs disabled before audio load': rangeDisabled,
  'image format preference restores and saves': formatRestored && formatSaved,
  'legacy BPF defaults off': bpfDefaultsOff,
  'AFC and LMS default on': receiverEnhancementsDefaultOn,
  'night theme is the default': nightThemeDefault,
  'receiver settings own P2 and P3 and start hidden': settingsDefaultHidden && settingsOwnsControls,
  'receiver settings open, trap focus, and close from scrim': settingsOpens && settingsScrimCloses,
  'baseband filter panel opens with both sliders in one group': filterPanelOpens && filtersShareOneRowGroup,
  'Escape closes baseband before receiver settings': nestedEscapeClosesFilterOnly && secondEscapeClosesSettings,
  'unsafe saved baseband migrates to defaults': unsafeFilterMigrated,
  'baseband sliders preserve protocol frequencies': protocolRangeConstrained && filterSaved && unsafeDomRangeRejected,
  'baseband reset feeds phase DSP options': filterReset,
  'decoder page exposes two commands and one mode toggle': decoderOnly,
  'receiver uses one start-stop command': receiveButtonStartsReady,
  'offline decode toggles into fast mode': offlineDecodeStartsStandard && fastDecodeToggleWorks,
  'audio player remains visible in its idle state': permanentPlayerStartsIdle,
  'result footer and pagination remain visible when empty': resultFooterStartsPersistent,
  'receiver live regions avoid duplicate announcements': receiverLiveRegionsAreScoped,
  'navigation starts hidden and toggles safely': navDefaultHidden && navOpens && navCloses,
  '12-cell SNR meter reports dB and resets': meterResponds && meterResets,
  'offline decoder progress remains visible and reports ARIA state': offlineProgressStartsIdle &&
    offlineProgressScans && offlineProgressAdvances && offlineProgressCompletes && offlineProgressReturnsIdle,
  'live receiver status throttles rows and transitions to next-frame search': receiverPanelProgressThrottles &&
    receiverSearchesNextConsistently,
  'complete microphone transmission prompt is eligible only in the safe live state': receiveCompletionEligibility,
  'receive completion dialog traps focus and Escape safely continues reception':
    receiveCompletionDialogAccessible && receiveCompletionEscapeContinues && receiveCompletionCancellationCloses,
  'decoded image can be manually reset': decodedResultEnablesReset && decodedResultResets,
  'live receiver frames append without paginating partial redraws': liveFramesAppend &&
    livePartialReplacesInPlace && liveFinalReplacesPartial && incompleteFinalKeepsSemanticState &&
    failedFinalFreezesPreview,
  'multi-frame results paginate with absolute time and partial state': paginationStartsAtFirst && paginationShowsPartialSecond,
  'decoded audio ranges switch to hour formatting': hourRangeFormatting,
  'single decoded frame keeps persistent pagination': singleFrameKeepsPagination,
  'decoded image filenames use plain seconds': filenameTimesUsePlainSeconds,
  'decoded image metadata is removed from P2': decodedMetadataRemoved,
  'ROWS telemetry is removed from P1': rowsTelemetryRemoved,
  'encoder has a separate page shell': encoderIsSeparate,
  'encoder TX mode lives in collapsed floating settings': encoderSettingsCollapsed,
  'encoder exposes current mode change entry and progress semantics': encoderModeSummary && encoderProgressAccessible,
  'timeline and selection handles expose keyboard slider semantics': timelineAccessible,
  'pages use local fonts and accurately disclose local media handling': fontPrivacy,
  'decoder workspace separates controls and output': decoderWorkspaceStructured,
  'frequency readout annotations are removed from both pages': frequencyReadoutsRemoved,
  'project links are the only footer content': centeredProjectLinks,
  'application initializes without errors': errors.length === 0,
};

for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
app.destroyFieldApp();
window.close();
if (Object.values(checks).some(passed => !passed)) process.exit(1);
