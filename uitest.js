// uitest.js — jsdom UI 冒烟测试:验证 app.js 装配无错、模式下拉填充
import { JSDOM } from 'jsdom';

const html = `
<!DOCTYPE html><html><body>
  <select id="modeSelect"></select>
  <button id="themeToggle" class="icon-btn">🌙</button>
  <div class="dropzone" id="dropzone"><canvas id="srcCanvas" width="320" height="256"></canvas>
    <input type="file" id="fileInput" hidden></div>
  <div class="mode-info" id="modeInfo"></div>
  <button id="useSampleBtn" class="btn ghost"></button>
  <button id="encodeBtn" class="btn primary" disabled></button>
  <button id="playBtn" class="btn" disabled>▶ 播放</button>
  <button id="downloadBtn" class="btn" disabled></button>
  <button id="selfTestBtn" class="btn accent" disabled></button>
  <div class="progress" id="encProgress" hidden><div class="bar"></div></div>
  <canvas id="waveform"></canvas>
  <div class="dropzone small" id="wavDropzone"><input type="file" id="wavInput" hidden></div>
  <input type="number" id="startOffset" value="0" min="0" step="0.1">
  <input type="checkbox" id="dspAfc">
  <input type="checkbox" id="dspLms">
  <input type="checkbox" id="dspBpf" checked>
  <span id="audioMeta"></span>
  <canvas id="spectrum"></canvas>
  <button id="decodeBtn" class="btn primary" disabled></button>
  <button id="decodeUploadedBtn" class="btn" disabled></button>
  <div class="progress" id="decProgress" hidden><div class="bar"></div></div>
  <span id="resultMeta" class="meta"></span>
  <canvas id="resultCanvas" width="320" height="256"></canvas>
  <section class="compare" id="compareSection" hidden>
    <canvas id="origCanvas" width="320" height="256"></canvas>
    <canvas id="decodedCanvas" width="320" height="256"></canvas>
    <div class="psnr" id="psnrOut"></div>
  </section>
  <div id="toast" class="toast" hidden></div>
  <audio id="audioPlayer"></audio>
</body></html>`;

const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;
global.URL = window.URL;
global.Blob = window.Blob;
global.HTMLCanvasElement = window.HTMLCanvasElement;
global.Image = window.Image;
global.FileReader = window.FileReader;
global.OffscreenCanvas = undefined; // 强制走 document.createElement('canvas')

// jsdom canvas 是 noop,patch getContext 返回桩
HTMLCanvasElement.prototype.getContext = function () {
  return {
    drawImage() {}, getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {}, createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    set fillStyle(v) {}, get fillStyle() { return ''; }, set strokeStyle(v) {}, set lineWidth(v) {},
    set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    createLinearGradient() { return { addColorStop() {} }; },
  };
};

const errors = [];
window.addEventListener('error', e => errors.push(e.message));

// 动态 import app.js(它调 init())
await import('./js/app.js');

// 等一拍让 async init 完成
await new Promise(r => setTimeout(r, 200));

const sel = document.getElementById('modeSelect');
console.log('模式数量:', sel.options.length, '(期望 38)');
console.log('模式列表:', Array.from(sel.options).map(o => o.textContent).join(' | '));
console.log('modeInfo 内容非空:', document.getElementById('modeInfo').textContent.length > 0);
console.log('编码按钮启用(有图后):', !document.getElementById('encodeBtn').disabled);
console.log('自测按钮启用:', !document.getElementById('selfTestBtn').disabled);
console.log('起始时间输入默认值:', document.getElementById('startOffset').value, '(期望 0)');
console.log('DSP 默认值 AFC/LMS/BPF:',
  document.getElementById('dspAfc').checked,
  document.getElementById('dspLms').checked,
  document.getElementById('dspBpf').checked,
  '(期望 false/false/true)');
console.log('捕获的错误:', errors.length === 0 ? '无' : errors.join('; '));

// 播放按钮应在播放、暂停状态之间切换。
const audio = document.getElementById('audioPlayer');
const playBtn = document.getElementById('playBtn');
let audioPaused = true;
let audioEnded = false;
Object.defineProperties(audio, {
  paused: { configurable: true, get: () => audioPaused },
  ended: { configurable: true, get: () => audioEnded },
});
audio.play = () => {
  audioPaused = false;
  audio.dispatchEvent(new window.Event('play'));
  return Promise.resolve();
};
audio.pause = () => {
  audioPaused = true;
  audio.currentTime = 1;
  audio.dispatchEvent(new window.Event('pause'));
};
playBtn.disabled = false;
playBtn.click();
await Promise.resolve();
const showsPause = playBtn.textContent === '⏸ 暂停';
playBtn.click();
const showsResume = playBtn.textContent === '▶ 继续播放';
audioEnded = true;
audio.dispatchEvent(new window.Event('ended'));
const resetsAfterEnd = playBtn.textContent === '▶ 播放';
console.log('播放/暂停按钮切换:', showsPause && showsResume && resetsAfterEnd);

// jsdom canvas 不支持 toDataURL,useSampleImage 的 Image.onload 不会触发,
// 所以图片相关按钮保持 disabled 是测试环境局限,非 app.js bug。核心验证:装配无错 + 模式填充。
const startOffsetOk = document.getElementById('startOffset').value === '0';
const dspDefaultsOk = !document.getElementById('dspAfc').checked &&
  !document.getElementById('dspLms').checked && document.getElementById('dspBpf').checked;
const ok = sel.options.length === 38 && errors.length === 0 && startOffsetOk &&
  dspDefaultsOk && showsPause && showsResume && resetsAfterEnd;
console.log(ok ? '\nUI 冒烟测试通过 ✓(模式装配正确,起始时间控件就绪,无运行时错误)' : '\nUI 冒烟测试失败 ⚠');
process.exit(ok ? 0 : 1);
