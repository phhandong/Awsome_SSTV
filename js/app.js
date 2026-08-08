// app.js — 入口,装配 UI 与模块编排

import { listModes, getMode, DEFAULT_SAMPLE_RATE } from './modes.js';
import { encode } from './encoder.js';
import { decode } from './decoder.js';
import { encodeWAV, decodeWAV } from './wav.js';
import { decodeAudioFile, sliceFromStart } from './audiodecode.js';
import { magnitudeSpectrum, drawSpectrumColumn } from './fft.js';
import { AudioPlayer } from './audioPlayer.js';
import { WebSSTVDecoder } from './web-receiver.js';
import * as ui from './ui.js';
import { canvasBlob } from './image-export.js';

const state = {
  mode: null,
  sourceImage: null,     // HTMLImageElement / ImageBitmap,用于 encode
  lastPCM: null,         // Float32Array(生成的音频)
  lastWAV: null,         // ArrayBuffer
  uploadedAudio: null,   // { sampleRate, samples, format } 上传解码后的 PCM
  audioUrl: null,
  isProcessing: false,   // 防止重复处理
  audioPlayer: null,     // 交互式音频播放器
  audioLoadId: 0,
  audioSelection: { start: 0, end: 0 }, // 选中的音频区域
  webDecoder: null,
  micActive: false,
  decodedResult: null,
};

const FFT_SIZE = 512;

function init() {
  // 模式下拉
  const sel = document.getElementById('modeSelect');
  const modes = listModes().slice().sort((a, b) => {
    const priority = { 95: 0, 8: 1, 12: 2 };
    return (priority[a.visCode] ?? 99) - (priority[b.visCode] ?? 99);
  });
  for (const m of modes) {
    const opt = document.createElement('option');
    opt.value = m.visCode;
    opt.textContent = `${m.name}  ·  ${m.width}×${m.height}`;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => selectMode(Number(sel.value)));
  document.getElementById('autoReceive').addEventListener('change', updateReceiveModeLabel);

  // 主题切换
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  // 恢复保存的主题
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('theme') || 'dark'; } catch (_) {}
  document.documentElement.setAttribute('data-theme', savedTheme);
  document.getElementById('themeToggle').textContent = savedTheme === 'light' ? '☀' : '🌙';

  // 拖放区
  ui.bindDropZone(document.getElementById('dropzone'),
    document.getElementById('fileInput'), onImageFile);
  ui.bindDropZone(document.getElementById('wavDropzone'),
    document.getElementById('wavInput'), onAudioFile);

  // 按钮
  document.getElementById('useSampleBtn').addEventListener('click', useSampleImage);
  document.getElementById('encodeBtn').addEventListener('click', onEncode);
  document.getElementById('playBtn').addEventListener('click', onPlay);
  const audioPlayer = document.getElementById('audioPlayer');
  audioPlayer.addEventListener('play', updatePlayButton);
  audioPlayer.addEventListener('pause', updatePlayButton);
  audioPlayer.addEventListener('ended', updatePlayButton);
  audioPlayer.addEventListener('emptied', updatePlayButton);
  document.getElementById('downloadBtn').addEventListener('click', onDownload);
  document.getElementById('selfTestBtn').addEventListener('click', onSelfTest);
  document.getElementById('decodeBtn').addEventListener('click', () => onDecode(state.lastPCM, DEFAULT_SAMPLE_RATE));
  document.getElementById('decodeUploadedBtn').addEventListener('click', () => {
    if (!state.uploadedAudio) return;
    onDecode(state.uploadedAudio.samples, state.uploadedAudio.sampleRate);
  });
  document.getElementById('saveImageBtn').addEventListener('click', saveDecodedImage);
  const imageFormat = document.getElementById('imageFormat');
  try { imageFormat.value = localStorage.getItem('sstv.imageFormat') || 'png'; } catch (_) {}
  imageFormat.addEventListener('change', () => {
    try { localStorage.setItem('sstv.imageFormat', imageFormat.value); } catch (_) {}
  });
  for (const id of ['decodeStartSec', 'decodeEndSec']) {
    document.getElementById(id).addEventListener('input', onRangeInput);
  }
  document.getElementById('micStartBtn').addEventListener('click', startMicrophoneReceiver);
  document.getElementById('micStopBtn').addEventListener('click', stopMicrophoneReceiver);

  if (typeof Worker !== 'undefined') {
    state.webDecoder = new WebSSTVDecoder();
    bindReceiverEvents(state.webDecoder);
  } else {
    document.getElementById('micStartBtn').disabled = true;
    setReceiverStatus('当前浏览器不支持 Worker');
  }

  // 初始化音频播放器
  state.audioPlayer = new AudioPlayer('audioPlayerWrapper', {
    onSelectionChange: (selection) => {
      state.audioSelection = selection;
      syncRangeInputs(selection);
    }
  });

  // 初始化默认选区
  state.audioSelection = { start: 0, end: 0, duration: 0 };

  // 键盘快捷键
  setupKeyboardShortcuts();

  // 添加拖放区键盘支持
  setupDropzoneKeyboard();

  selectMode(Number(sel.value));
  updateReceiveModeLabel();
  useSampleImage();  // 默认加载示例图
}

// 键盘快捷键
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Enter: 生成音频
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      const encodeBtn = document.getElementById('encodeBtn');
      if (!encodeBtn.disabled) encodeBtn.click();
    }
    // Space: 播放/暂停
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      const playBtn = document.getElementById('playBtn');
      if (!playBtn.disabled) playBtn.click();
    }
    // Ctrl/Cmd + D: 解码
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
      e.preventDefault();
      const decodeBtn = document.getElementById('decodeBtn');
      if (!decodeBtn.disabled) decodeBtn.click();
    }
    // Ctrl/Cmd + T: 切换主题
    if ((e.ctrlKey || e.metaKey) && e.key === 't') {
      e.preventDefault();
      toggleTheme();
    }
  });
}

// 拖放区键盘支持
function setupDropzoneKeyboard() {
  ['dropzone', 'wavDropzone'].forEach(id => {
    const zone = document.getElementById(id);
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        zone.click();
      }
    });
  });
}

function selectMode(visCode) {
  state.mode = getMode(visCode);
  const m = state.mode;
  document.getElementById('modeInfo').innerHTML =
    `<span>尺寸 <b>${m.width}×${m.height}</b></span>` +
    `<span>色彩 <b>${m.colorSpace.toUpperCase()}</b></span>` +
    `<span>族 <b>${m.family}</b></span>` +
    `<span>VIS <b>${m.visCode}</b></span>` +
    `<span>行周期 <b>${m.lineDurationMs.toFixed(1)}ms</b></span>`;
  // 更新源画布尺寸预览
  if (state.sourceImage) drawSourcePreview();
  updateButtons();
}

function drawSourcePreview() {
  const m = state.mode;
  ui.drawImageToCanvas(document.getElementById('srcCanvas'), state.sourceImage, m.width, m.height);
}

// ---- 图片加载 ----
function onImageFile(file) {
  const img = new Image();
  const objectUrl = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(objectUrl);
    state.sourceImage = img;
    drawSourcePreview();
    updateButtons();
    ui.toast('图片已加载', 'success');
  };
  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    ui.toast('图片加载失败', 'error');
  };
  img.src = objectUrl;
}

// 程序生成示例测试图(零资源依赖,部署友好)
function useSampleImage() {
  const m = state.mode || { width: 320, height: 256 };
  const c = document.createElement('canvas');
  c.width = 320; c.height = 256;
  const ctx = c.getContext('2d');
  // 彩色渐变 + 色块 + 文字
  const grad = ctx.createLinearGradient(0, 0, 320, 256);
  grad.addColorStop(0, '#1a5490'); grad.addColorStop(0.5, '#4fd1c5'); grad.addColorStop(1, '#f6ad55');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 320, 256);
  // 色阶条
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = `hsl(${i * 45}, 80%, 55%)`;
    ctx.fillRect(i * 40, 20, 38, 30);
  }
  // 灰阶
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = `rgb(${i * 17},${i * 17},${i * 17})`;
    ctx.fillRect(i * 20, 210, 18, 30);
  }
  // 文字
  ctx.fillStyle = '#fff'; ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('AWESOME SSTV', 160, 120);
  ctx.font = '14px sans-serif';
  ctx.fillText(m.name || '', 160, 145);

  const img = new Image();
  img.onload = () => {
    state.sourceImage = img;
    drawSourcePreview();
    updateButtons();
  };
  img.src = c.toDataURL();
}

// ---- 生成 ----
async function onEncode() {
  if (!state.sourceImage || !state.mode || state.isProcessing) return;

  state.isProcessing = true;
  const encodeBtn = document.getElementById('encodeBtn');
  encodeBtn.classList.add('loading');

  try {
    ui.toast('生成中…');

    // 使用 requestIdleCallback 优化性能
    await new Promise(resolve => {
      const callback = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
      callback(resolve);
    });

    const pcm = encode(state.sourceImage, state.mode, {
      sampleRate: DEFAULT_SAMPLE_RATE,
      onProgress: p => ui.setProgress('encProgress', p),
    });
    state.lastPCM = pcm;
    state.lastWAV = encodeWAV(pcm, DEFAULT_SAMPLE_RATE);

    // 波形 + 频谱预览
    ui.drawWaveform(document.getElementById('waveform'), pcm);
    renderSpectrumToCanvas('encoderSpectrum', pcm, DEFAULT_SAMPLE_RATE);

    // 音频 URL
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    const blob = new Blob([state.lastWAV], { type: 'audio/wav' });
    state.audioUrl = URL.createObjectURL(blob);
    document.getElementById('audioPlayer').src = state.audioUrl;

    ui.setProgress('encProgress', 1);
    const duration = (pcm.length / DEFAULT_SAMPLE_RATE).toFixed(1);
    ui.toast(`生成完成 ${duration}s · ${(state.lastWAV.byteLength / 1024).toFixed(0)}KB`, 'success');
    updateButtons();
  } catch (e) {
    console.error(e);
    ui.toast('生成失败: ' + e.message, 'error');
  } finally {
    state.isProcessing = false;
    encodeBtn.classList.remove('loading');
  }
}

function renderSpectrum(pcm, sampleRate = DEFAULT_SAMPLE_RATE) {
  renderSpectrumToCanvas('spectrum', pcm, sampleRate);
}

function renderSpectrumToCanvas(canvasId, pcm, sampleRate = DEFAULT_SAMPLE_RATE) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) {
    console.warn(`Canvas ${canvasId} not found`);
    return;
  }
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth || 600;
  const height = 140;
  canvas.height = height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, height);
  const sr = sampleRate;
  const maxStart = Math.max(0, pcm.length - FFT_SIZE);
  for (let x = 0; x < w; x++) {
    const start = w > 1 ? Math.floor(x * maxStart / (w - 1)) : 0;
    const mag = magnitudeSpectrum(pcm, start, FFT_SIZE, sr);
    drawSpectrumColumn(ctx, mag, x, sr, FFT_SIZE, 700, 2700, height);
  }
}

async function onPlay() {
  const a = document.getElementById('audioPlayer');
  if (!a.paused && !a.ended) {
    a.pause();
    return;
  }

  try {
    await a.play();
  } catch (e) {
    console.error(e);
    ui.toast('音频播放失败: ' + e.message, 'error');
  }
}

function updatePlayButton() {
  const a = document.getElementById('audioPlayer');
  const btn = document.getElementById('playBtn');

  if (!a.paused && !a.ended) {
    btn.textContent = '⏸ 暂停';
    btn.setAttribute('aria-label', '暂停音频');
  } else if (a.currentTime > 0 && !a.ended) {
    btn.textContent = '▶ 继续播放';
    btn.setAttribute('aria-label', '继续播放音频');
  } else {
    btn.textContent = '▶ 播放';
    btn.setAttribute('aria-label', '播放音频');
  }
}

function onDownload() {
  if (!state.lastWAV) return;
  const blob = new Blob([state.lastWAV], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sstv_${state.mode.name.replace(/\s+/g, '_')}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- 解码 ----
// pcm/sr 为待解码音频;起始和结束时间从音频播放器选区读取
async function onDecode(pcm, sr) {
  if (!pcm || state.isProcessing) return;
  if (pcm === state.uploadedAudio?.samples && !validateRangeInputs()) return;

  state.isProcessing = true;
  const decodeBtn = document.getElementById('decodeBtn');
  const decodeUploadedBtn = document.getElementById('decodeUploadedBtn');
  decodeBtn.classList.add('loading');
  decodeUploadedBtn.classList.add('loading');

  // 从音频播放器获取选区，如果没有则使用完整音频
  const totalDuration = pcm.length / sr;
  const startSec = state.audioSelection.start || 0;
  const endSec = state.audioSelection.end > 0 ? state.audioSelection.end : totalDuration;
  const duration = endSec - startSec;

  try {
    let work = pcm;
    if (startSec > 0 || endSec < totalDuration) {
      const startSample = Math.floor(startSec * sr);
      const endSample = Math.min(Math.floor(endSec * sr), pcm.length);
      work = pcm.slice(startSample, endSample);
      ui.toast(`解码选中区域 ${startSec.toFixed(1)}s ~ ${endSec.toFixed(1)}s (${duration.toFixed(1)}s)…`);
    } else {
      ui.toast('在后台解码完整音频…');
    }

    const dsp = { ...readDspOptions(), engine: 'mmsstv' };
    const receive = readReceiveOptions();
    const result = state.webDecoder
      ? await state.webDecoder.decode(work, sr, { ...receive, dsp, emitFrames: true })
      : decode(work, sr, { ...receive, dsp });
    renderReceiverFrame(result);
    ui.setProgress('decProgress', 1);
    ui.toast(`解码完成 · ${result.mode.name}`, 'success');
  } catch (e) {
    console.error(e);
    ui.toast('解码失败: ' + e.message, 'error');
  } finally {
    state.isProcessing = false;
    decodeBtn.classList.remove('loading');
    decodeUploadedBtn.classList.remove('loading');
  }
}

function bindReceiverEvents(receiver) {
  receiver.addEventListener('searching', () => {
    if (state.micActive) setReceiverStatus('搜索信号');
  });
  receiver.addEventListener('level', ({ detail }) => {
    const percent = Math.min(100, Math.sqrt(Math.max(0, detail.rms)) * 140);
    document.getElementById('receiverLevel').style.width = `${percent}%`;
  });
  receiver.addEventListener('locked', ({ detail }) => {
    const labels = { vis: 'VIS', fsk: 'FSK', sync: '同步', manual: '手动' };
    setReceiverStatus(`已锁定 · ${labels[detail.source] || '自动'}`, 'locked');
    document.getElementById('receiverMode').textContent = detail.mode.name;
    document.getElementById('receiverRows').textContent = `0 / ${detail.mode.height}`;
  });
  receiver.addEventListener('row', ({ detail }) => {
    document.getElementById('receiverRows').textContent = `${detail.rows} / ${detail.totalRows}`;
    ui.setProgress('decProgress', detail.rows / detail.totalRows);
  });
  receiver.addEventListener('frame', ({ detail }) => renderReceiverFrame(detail.result));
  receiver.addEventListener('error', ({ detail }) => {
    if (state.micActive) setReceiverStatus('等待有效信号', 'active');
    console.warn('Receiver:', detail.message);
  });
}

export function renderReceiverFrame(result) {
  state.decodedResult = result;
  ui.renderToCanvas(document.getElementById('resultCanvas'), result.pixels, result.width, result.height);
  document.getElementById('saveImageBtn').disabled = false;
  document.getElementById('resultMeta').textContent = formatDecodeMeta(result);
  document.getElementById('receiverMode').textContent = result.mode.name;
  document.getElementById('receiverRows').textContent = `${result.height} / ${result.height}`;
  document.getElementById('receiverAfc').textContent = result.dsp?.afcLocked
    ? `${result.dsp.afcOffsetHz >= 0 ? '+' : ''}${result.dsp.afcOffsetHz.toFixed(1)} Hz`
    : (result.dsp?.afc ? '未锁定' : '关闭');
}

function setReceiverStatus(text, stateClass = '') {
  document.getElementById('receiverStatus').textContent = text;
  document.getElementById('liveIndicator').className = `live-indicator ${stateClass}`.trim();
}

async function startMicrophoneReceiver() {
  if (!state.webDecoder || state.micActive) return;
  const start = document.getElementById('micStartBtn');
  const stop = document.getElementById('micStopBtn');
  start.disabled = true;
  setReceiverStatus('请求权限', 'active');
  try {
    await state.webDecoder.startMicrophone({
      ...readReceiveOptions(),
      dsp: { ...readDspOptions(), engine: 'mmsstv' },
    });
    state.micActive = true;
    stop.disabled = false;
    setReceiverStatus('搜索信号', 'active');
    ui.toast('麦克风接收已开始', 'success');
  } catch (error) {
    start.disabled = false;
    setReceiverStatus('无法启动');
    ui.toast('麦克风启动失败: ' + error.message, 'error');
  }
}

async function stopMicrophoneReceiver() {
  if (!state.webDecoder || !state.micActive) return;
  state.micActive = false;
  await state.webDecoder.stopMicrophone(true);
  document.getElementById('micStartBtn').disabled = false;
  document.getElementById('micStopBtn').disabled = true;
  document.getElementById('receiverLevel').style.width = '0';
  setReceiverStatus('已停止');
}

// ---- 自测闭环 ----
async function onSelfTest() {
  if (!state.sourceImage || !state.mode || state.isProcessing) return;

  state.isProcessing = true;
  const selfTestBtn = document.getElementById('selfTestBtn');
  selfTestBtn.classList.add('loading');

  try {
    ui.toast('自测闭环中…');
    const m = state.mode;

    // 1. 生成
    const pcm = encode(state.sourceImage, m, { sampleRate: DEFAULT_SAMPLE_RATE });
    state.lastPCM = pcm;
    state.lastWAV = encodeWAV(pcm, DEFAULT_SAMPLE_RATE);
    ui.drawWaveform(document.getElementById('waveform'), pcm);
    renderSpectrumToCanvas('encoderSpectrum', pcm, DEFAULT_SAMPLE_RATE);

    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    const blob = new Blob([state.lastWAV], { type: 'audio/wav' });
    state.audioUrl = URL.createObjectURL(blob);
    document.getElementById('audioPlayer').src = state.audioUrl;

    // 2. 解码(WAV 往返)
    const { sampleRate, samples } = decodeWAV(state.lastWAV);
    const result = decode(samples, sampleRate, { dsp: readDspOptions() });

    // 3. 对照显示
    const origCanvas = document.getElementById('origCanvas');
    ui.drawImageToCanvas(origCanvas, state.sourceImage, m.width, m.height);
    // 取原图像素(按 mode 尺寸)
    const octx = origCanvas.getContext('2d');
    const origPixels = octx.getImageData(0, 0, m.width, m.height).data;

    const decodedCanvas = document.getElementById('decodedCanvas');
    ui.renderToCanvas(decodedCanvas, result.pixels, result.width, result.height);

    // 4. PSNR
    const psnr = ui.computePSNR(origPixels, result.pixels);
    const out = document.getElementById('psnrOut');
    const ok = psnr >= 25;
    out.innerHTML = `PSNR = <span class="${ok ? 'ok' : 'bad'}">${psnr.toFixed(2)} dB</span> · 模式 ${result.mode.name} · ${ok ? '✓ 闭环验证通过' : '⚠ 偏差较大'}`;

    const compareSection = document.getElementById('compareSection');
    compareSection.hidden = false;
    // 平滑滚动到对比区域
    compareSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    ui.toast(`自测完成 · PSNR ${psnr.toFixed(1)}dB`, ok ? 'success' : 'error');
    updateButtons();
  } catch (e) {
    console.error(e);
    ui.toast('自测失败: ' + e.message, 'error');
  } finally {
    state.isProcessing = false;
    selfTestBtn.classList.remove('loading');
  }
}

function readDspOptions() {
  return {
    afc: document.getElementById('dspAfc').checked,
    lms: document.getElementById('dspLms').checked,
    bpf: document.getElementById('dspBpf').checked,
  };
}

export function readReceiveOptions() {
  return document.getElementById('autoReceive').checked
    ? { autoSync: true }
    : { mode: Number(document.getElementById('modeSelect').value) };
}

function updateReceiveModeLabel() {
  const auto = document.getElementById('autoReceive').checked;
  document.getElementById('modeSelect').title = auto
    ? '编码模式；接收将自动识别 VIS、FSK 或同步脉冲'
    : '编码与手动接收模式';
}

function syncRangeInputs(selection) {
  const start = document.getElementById('decodeStartSec');
  const end = document.getElementById('decodeEndSec');
  if (!start || !end) return;
  start.value = Number(selection.start || 0).toFixed(1);
  end.value = Number(selection.end || 0).toFixed(1);
  setRangeValidity(true);
}

function onRangeInput() {
  if (!state.audioPlayer?.duration) return;
  if (validateRangeInputs()) {
    const start = Number(document.getElementById('decodeStartSec').value);
    const end = Number(document.getElementById('decodeEndSec').value);
    state.audioPlayer.setSelectionTime(start, end);
  }
}

function validateRangeInputs() {
  const start = Number(document.getElementById('decodeStartSec').value);
  const end = Number(document.getElementById('decodeEndSec').value);
  const valid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= state.audioPlayer.duration && start < end;
  setRangeValidity(valid);
  return valid;
}

function setRangeValidity(valid) {
  for (const id of ['decodeStartSec', 'decodeEndSec']) {
    document.getElementById(id).setAttribute('aria-invalid', valid ? 'false' : 'true');
  }
  document.getElementById('rangeError').hidden = valid;
  document.getElementById('decodeUploadedBtn').disabled = !valid || !state.uploadedAudio;
}

async function saveDecodedImage() {
  if (!state.decodedResult) return;
  const format = document.getElementById('imageFormat').value;
  try {
    const blob = await canvasBlob(document.getElementById('resultCanvas'), format);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sstv_${state.decodedResult.mode.name.replace(/\s+/g, '_')}_${Date.now()}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.toast(`图片已保存为 ${format.toUpperCase()}`, 'success');
  } catch (error) {
    ui.toast(`图片保存失败: ${error.message}`, 'error');
  }
}

function formatDecodeMeta(result) {
  const enabled = ['AFC', 'LMS', 'BPF'].filter(name => result.dsp?.[name.toLowerCase()]);
  let dspText = enabled.length ? enabled.join('+') : 'DSP 关闭';
  if (result.dsp?.afc) {
    dspText += result.dsp.afcLocked
      ? ` ${result.dsp.afcOffsetHz >= 0 ? '+' : ''}${result.dsp.afcOffsetHz.toFixed(1)}Hz`
      : ' 未锁定';
  }
  return `${result.mode.name} · ${result.width}×${result.height} · ${dspText}`;
}

// ---- 音频上传(WAV / MP3 等)----
async function onAudioFile(file) {
  const loadId = ++state.audioLoadId;
  try {
    ui.toast('解码音频文件中…');
    const { sampleRate, samples, format } = await decodeAudioFile(file);
    if (loadId !== state.audioLoadId) return;
    state.uploadedAudio = { sampleRate, samples, format };

    // 加载播放器会先显示时间轴，使两个 canvas 都能取得正确尺寸。
    await state.audioPlayer.loadAudio(samples, sampleRate);
    renderSpectrum(samples, sampleRate);

    document.getElementById('decodeUploadedBtn').disabled = false;
    const dur = (samples.length / sampleRate).toFixed(1);
    document.getElementById('decodeStartSec').disabled = false;
    document.getElementById('decodeEndSec').disabled = false;
    document.getElementById('decodeStartSec').max = String(samples.length / sampleRate);
    document.getElementById('decodeEndSec').max = String(samples.length / sampleRate);
    document.getElementById('audioMeta').textContent =
      `${format} · ${sampleRate}Hz · ${dur}s`;
    ui.toast(`${file.name || '音频'} 已加载(${format}, ${sampleRate}Hz, ${dur}s)`, 'success');
  } catch (e) {
    console.error(e);
    ui.toast('音频加载失败: ' + e.message, 'error');
  }
}

// ---- 辅助 ----
function updateButtons() {
  const hasImg = !!state.sourceImage;
  const hasPcm = !!state.lastPCM;
  document.getElementById('encodeBtn').disabled = !hasImg;
  document.getElementById('playBtn').disabled = !hasPcm;
  document.getElementById('downloadBtn').disabled = !hasPcm;
  document.getElementById('selfTestBtn').disabled = !hasImg;
  document.getElementById('decodeBtn').disabled = !hasPcm;
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  document.getElementById('themeToggle').textContent = next === 'light' ? '☀' : '🌙';

  // 保存主题偏好
  try {
    localStorage.setItem('theme', next);
  } catch (e) {
    console.warn('无法保存主题偏好:', e);
  }

  // 主题切换动画
  document.body.style.transition = 'background 0.3s, color 0.3s';
  setTimeout(() => {
    document.body.style.transition = '';
  }, 300);
}

init();
