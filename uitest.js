// uitest.js - jsdom UI smoke checks against the real page.
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
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
await import('./js/app.js');
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
const checks = {
  'single 43-mode selector': oneModeSelector && selects[0].options.length === 43,
  'priority mode order': priorityOrder,
  'automatic receive defaults on': autoDefault,
  'range inputs disabled before audio load': rangeDisabled,
  'image format preference restores and saves': formatRestored && formatSaved,
  'application initializes without errors': errors.length === 0,
};

for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (Object.values(checks).some(passed => !passed)) process.exit(1);
