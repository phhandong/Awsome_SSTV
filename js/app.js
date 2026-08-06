// app.js — 入口,装配 UI 与模块编排

import { listModes, getMode, DEFAULT_SAMPLE_RATE } from './modes.js';
import { encode } from './encoder.js';
import { decode } from './decoder.js';
import { encodeWAV, decodeWAV } from './wav.js';
import { decodeAudioFile, sliceFromStart } from './audiodecode.js';
import { magnitudeSpectrum, drawSpectrumRow } from './fft.js';
import { AudioPlayer } from './audioPlayer.js';
import * as ui from './ui.js';

const state = {
  mode: null,
  sourceImage: null,     // HTMLImageElement / ImageBitmap,用于 encode
  lastPCM: null,         // Float32Array(生成的音频)
  lastWAV: null,         // ArrayBuffer
  uploadedAudio: null,   // { sampleRate, samples, format } 上传解码后的 PCM
  audioUrl: null,
  isProcessing: false,   // 防止重复处理
  audioPlayer: null,     // 交互式音频播放器
  audioSelection: { start: 0, end: 0 }, // 选中的音频区域
};

const FFT_SIZE = 512;

function init() {
  // 模式下拉
  const sel = document.getElementById('modeSelect');
  for (const m of listModes()) {
    const opt = document.createElement('option');
    opt.value = m.visCode;
    opt.textContent = `${m.name}  ·  ${m.width}×${m.height}`;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => selectMode(Number(sel.value)));

  // 主题切换
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  // 恢复保存的主题
  const savedTheme = localStorage.getItem('theme') || 'dark';
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

  // 初始化音频播放器
  state.audioPlayer = new AudioPlayer('audioPlayerWrapper', {
    onSelectionChange: (selection) => {
      state.audioSelection = selection;
      console.log('选区更新:', selection);
    }
  });

  // 初始化默认选区
  state.audioSelection = { start: 0, end: 0, duration: 0 };

  // 键盘快捷键
  setupKeyboardShortcuts();

  // 添加拖放区键盘支持
  setupDropzoneKeyboard();

  selectMode(Number(sel.value));
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
  const rows = 140;
  canvas.height = rows;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, rows);
  const sr = sampleRate;
  const maxStart = Math.max(0, pcm.length - FFT_SIZE);
  for (let r = 0; r < rows; r++) {
    const start = rows > 1 ? Math.floor(r * maxStart / (rows - 1)) : 0;
    const mag = magnitudeSpectrum(pcm, start, FFT_SIZE, sr);
    drawSpectrumRow(ctx, mag, r, sr, FFT_SIZE, 700, 2700, w);
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
function onDecode(pcm, sr) {
  if (!pcm || state.isProcessing) return;

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

  // 使用 setTimeout 让 UI 更新
  setTimeout(() => {
    try {
      let work = pcm;

      // 根据选区截取音频
      if (startSec > 0 || endSec < totalDuration) {
        const startSample = Math.floor(startSec * sr);
        const endSample = Math.min(Math.floor(endSec * sr), pcm.length);
        work = pcm.slice(startSample, endSample);
        ui.toast(`解码选中区域 ${startSec.toFixed(1)}s ~ ${endSec.toFixed(1)}s (${duration.toFixed(1)}s)…`);
      } else {
        ui.toast('解码完整音频…');
      }

      const result = decode(work, sr, {
        onProgress: p => ui.setProgress('decProgress', p),
        dsp: readDspOptions(),
      });

      ui.renderToCanvas(document.getElementById('resultCanvas'), result.pixels, result.width, result.height);
      document.getElementById('resultMeta').textContent = formatDecodeMeta(result);
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
  }, 50);
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
  try {
    ui.toast('解码音频文件中…');
    const { sampleRate, samples, format } = await decodeAudioFile(file);
    state.uploadedAudio = { sampleRate, samples, format };

    // 先渲染频谱到播放器背景
    renderSpectrum(samples, sampleRate);

    // 然后加载到交互式播放器（会在频谱上叠加波形）
    await state.audioPlayer.loadAudio(samples, sampleRate);

    document.getElementById('decodeUploadedBtn').disabled = false;
    const dur = (samples.length / sampleRate).toFixed(1);
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
