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
  realtimeDecode: null,
  offlineDecodeActive: false,
  offlineProgressHideTimer: null,
  decodedResult: null,
  decodeGeneration: 0,
};

const FFT_SIZE = 512;
const BASEBAND_DEFAULT = { lowHz: 1000, highHz: 2800 };
const BASEBAND_MIN_HZ = 700;
const BASEBAND_MAX_HZ = 3000;
// VIS、行同步和图像电平会用到 1100–2300 Hz；保留至少 100 Hz 保护带。
const BASEBAND_LOW_MAX_HZ = 1000;
const BASEBAND_HIGH_MIN_HZ = 2400;
const SNR_METER_MIN_DB = -10;
const SNR_METER_MAX_DB = 30;

function init() {
  setupNavigation();

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
  enhanceSelect(sel);
  document.getElementById('autoReceive')?.addEventListener('change', updateReceiveModeLabel);

  // 主题切换
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  // 恢复保存的主题
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('theme') || 'dark'; } catch (_) {}
  document.documentElement.setAttribute('data-theme', savedTheme);
  document.getElementById('themeToggle').textContent = savedTheme === 'light' ? '☀' : '🌙';

  // 拖放区
  const imageDropzone = document.getElementById('dropzone');
  const audioDropzone = document.getElementById('wavDropzone');
  if (imageDropzone) ui.bindDropZone(imageDropzone, document.getElementById('fileInput'), onImageFile);
  if (audioDropzone) ui.bindDropZone(audioDropzone, document.getElementById('wavInput'), onAudioFile);

  // 按钮
  document.getElementById('useSampleBtn')?.addEventListener('click', useSampleImage);
  document.getElementById('encodeBtn')?.addEventListener('click', onEncode);
  document.getElementById('playBtn')?.addEventListener('click', onPlay);
  const audioPlayer = document.getElementById('audioPlayer');
  audioPlayer.addEventListener('play', updatePlayButton);
  audioPlayer.addEventListener('pause', updatePlayButton);
  audioPlayer.addEventListener('ended', updatePlayButton);
  audioPlayer.addEventListener('emptied', updatePlayButton);
  document.getElementById('downloadBtn')?.addEventListener('click', onDownload);
  document.getElementById('selfTestBtn')?.addEventListener('click', onSelfTest);
  document.getElementById('decodeUploadedBtn')?.addEventListener('click', () => {
    if (!state.uploadedAudio) return;
    onDecode(state.uploadedAudio.samples, state.uploadedAudio.sampleRate);
  });
  document.getElementById('realtimeDecodeBtn')?.addEventListener('click', toggleRealtimeDecode);
  document.getElementById('saveImageBtn')?.addEventListener('click', saveDecodedImage);
  document.getElementById('resetDecodedBtn')?.addEventListener('click', () => resetDecodedResult({ announce: true }));
  const imageFormat = document.getElementById('imageFormat');
  if (imageFormat) {
    try { imageFormat.value = localStorage.getItem('sstv.imageFormat') || 'png'; } catch (_) {}
    imageFormat.addEventListener('change', () => {
      try { localStorage.setItem('sstv.imageFormat', imageFormat.value); } catch (_) {}
    });
    enhanceSelect(imageFormat);
  }
  for (const id of ['decodeStartSec', 'decodeEndSec']) {
    document.getElementById(id)?.addEventListener('input', onRangeInput);
  }
  document.getElementById('micStartBtn')?.addEventListener('click', startMicrophoneReceiver);
  document.getElementById('micStopBtn')?.addEventListener('click', stopMicrophoneReceiver);
  const basebandController = document.getElementById('basebandFilterBtn')
    ? setupBasebandFilter()
    : null;
  setupPageSettings(basebandController);

  if (audioDropzone && typeof Worker !== 'undefined') {
    state.webDecoder = new WebSSTVDecoder();
    bindReceiverEvents(state.webDecoder);
  } else if (audioDropzone) {
    document.getElementById('micStartBtn').disabled = true;
    setReceiverStatus('当前浏览器不支持 Worker');
  }

  // 初始化音频播放器
  if (document.getElementById('audioPlayerWrapper')) {
    state.audioPlayer = new AudioPlayer('audioPlayerWrapper', {
      onSelectionChange: (selection) => {
        state.audioSelection = selection;
        syncRangeInputs(selection);
      },
      onPlaybackChange: handlePlaybackChange,
    });
  }

  // 初始化默认选区
  state.audioSelection = { start: 0, end: 0, duration: 0 };

  // 键盘快捷键
  setupKeyboardShortcuts();

  // 添加拖放区键盘支持
  setupDropzoneKeyboard();

  selectMode(Number(sel.value));
  if (document.getElementById('autoReceive')) updateReceiveModeLabel();
  if (imageDropzone) useSampleImage();  // 编码页默认加载示例图
}

function setupNavigation() {
  const button = document.getElementById('navToggle');
  const drawer = document.getElementById('navDrawer');
  const scrim = document.getElementById('navScrim');
  if (!button || !drawer || !scrim) return;
  const setOpen = open => {
    drawer.classList.toggle('is-open', open);
    scrim.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    drawer.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('nav-open', open);
  };
  button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true'));
  scrim.addEventListener('click', () => setOpen(false));
  drawer.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      button.focus();
    }
  });
  setOpen(false);
}

// 键盘快捷键
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Enter: 生成音频
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const encodeBtn = document.getElementById('encodeBtn');
      if (encodeBtn && !encodeBtn.disabled) {
        e.preventDefault();
        encodeBtn.click();
      }
    }
    // Space: 播放/暂停
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      const playBtn = document.getElementById('playBtn');
      if (playBtn && !playBtn.disabled) {
        e.preventDefault();
        playBtn.click();
      }
    }
    // Ctrl/Cmd + D: 解码上传的音频
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
      const decodeBtn = document.getElementById('decodeUploadedBtn');
      if (decodeBtn && !decodeBtn.disabled) {
        e.preventDefault();
        decodeBtn.click();
      }
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
    if (!zone) return;
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
  const modeInfo = document.getElementById('modeInfo');
  if (modeInfo) {
    modeInfo.innerHTML =
      `<span>尺寸 <b>${m.width}×${m.height}</b></span>` +
      `<span>色彩 <b>${m.colorSpace.toUpperCase()}</b></span>` +
      `<span>族 <b>${m.family}</b></span>` +
      `<span>VIS <b>${m.visCode}</b></span>` +
      `<span>行周期 <b>${m.lineDurationMs.toFixed(1)}ms</b></span>`;
  }
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

// 原生 select 的弹出面板由操作系统绘制，无法稳定应用圆角；保留原生控件作为值源，
// 用轻量自定义菜单提供一致的视觉样式和点击交互。
function enhanceSelect(select) {
  if (!select || select.dataset.enhanced) return;
  const host = select.closest('.mode-select, .format-select-wrap');
  if (!host) return;
  select.dataset.enhanced = 'true';
  host.classList.add('custom-select-host');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  const sync = () => {
    const option = select.options[select.selectedIndex];
    trigger.textContent = option?.textContent || '';
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || '选择');
    menu.querySelectorAll('[role="option"]').forEach(item => {
      const selected = item.dataset.value === select.value;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', String(selected));
    });
  };

  const close = () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    host.classList.remove('is-open');
  };
  const open = () => {
    sync();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    host.classList.add('is-open');
  };

  [...select.options].forEach(option => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'custom-select-option';
    item.dataset.value = option.value;
    item.setAttribute('role', 'option');
    item.textContent = option.textContent;
    item.addEventListener('click', () => {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
      close();
    });
    menu.appendChild(item);
  });

  trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
      menu.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
    }
  });
  select.addEventListener('change', sync);
  document.addEventListener('click', event => {
    if (!host.contains(event.target)) close();
  });

  host.insertBefore(trigger, select);
  host.appendChild(menu);
  sync();
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
  if (!btn) return;

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
export function setOfflineDecodeProgress(progress = null, status = '正在分析 VIS / 同步', phase = 'active') {
  const panel = document.getElementById('offlineDecodeProgress');
  const track = document.getElementById('offlineDecodeProgressBar');
  const bar = track?.querySelector('.bar');
  if (!panel || !track || !bar) return;

  clearTimeout(state.offlineProgressHideTimer);
  state.offlineProgressHideTimer = null;
  panel.hidden = false;
  panel.classList.toggle('is-idle', phase === 'idle');
  panel.classList.toggle('is-complete', phase === 'complete');
  panel.classList.toggle('is-error', phase === 'error');

  const text = document.getElementById('offlineDecodeProgressText');
  const value = document.getElementById('offlineDecodeProgressValue');
  if (text) text.textContent = status;

  const determinate = Number.isFinite(progress);
  track.classList.toggle('is-indeterminate', !determinate);
  if (!determinate) {
    track.removeAttribute('aria-valuenow');
    track.setAttribute('aria-valuetext', status);
    bar.style.width = '';
    if (value) value.textContent = phase === 'error' ? 'ERROR' : '扫描中';
    return;
  }

  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  track.setAttribute('aria-valuenow', String(percent));
  track.setAttribute('aria-valuetext', `${status}，${percent}%`);
  bar.style.width = `${percent}%`;
  if (value) value.textContent = `${percent}%`;
}

export function hideOfflineDecodeProgress(delay = 0) {
  const panel = document.getElementById('offlineDecodeProgress');
  if (!panel) return;
  clearTimeout(state.offlineProgressHideTimer);
  const settle = () => {
    state.offlineProgressHideTimer = null;
    setOfflineDecodeProgress(0, '等待解码', 'idle');
  };
  if (delay > 0) state.offlineProgressHideTimer = setTimeout(settle, delay);
  else settle();
}

function waitForBrowserPaint() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

// pcm/sr 为待解码音频;起始和结束时间从音频播放器选区读取
async function onDecode(pcm, sr) {
  if (!pcm || state.isProcessing) return;
  if (state.realtimeDecode) stopRealtimeDecode(true);
  if (pcm === state.uploadedAudio?.samples && !validateRangeInputs()) return;

  state.isProcessing = true;
  state.offlineDecodeActive = true;
  const decodeGeneration = state.decodeGeneration;
  const decodeUploadedBtn = document.getElementById('decodeUploadedBtn');
  decodeUploadedBtn.classList.add('loading');
  decodeUploadedBtn.setAttribute('aria-busy', 'true');
  setOfflineDecodeProgress(null, '正在分析 VIS / 同步');
  await waitForBrowserPaint();

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
      // Offline files need one final frame. Re-decoding and transferring every
      // eight provisional rows makes a 640x496 PD120 recording run dozens of
      // full prefix decodes before the real result is returned.
      ? await state.webDecoder.decode(work, sr, { ...receive, dsp, emitFrames: false })
      : decode(work, sr, {
          ...receive,
          dsp,
          onProgress: progress => setOfflineDecodeProgress(
            0.5 + Math.max(0, Math.min(1, progress)) * 0.49,
            `正在重建图像 ${Math.round(progress * 100)}%`
          ),
        });
    if (decodeGeneration !== state.decodeGeneration) return;
    renderReceiverFrame(result);
    setOfflineDecodeProgress(1, `${result.mode.name} · 解码完成`, 'complete');
    ui.toast(`解码完成 · ${result.mode.name}`, 'success');
  } catch (e) {
    console.error(e);
    if (decodeGeneration === state.decodeGeneration) {
      setOfflineDecodeProgress(null, '解码失败 · 请检查信号或模式', 'error');
      ui.toast('解码失败: ' + e.message, 'error');
    }
  } finally {
    state.isProcessing = false;
    state.offlineDecodeActive = false;
    decodeUploadedBtn.classList.remove('loading');
    decodeUploadedBtn.removeAttribute('aria-busy');
    if (decodeGeneration === state.decodeGeneration) {
      hideOfflineDecodeProgress(document.getElementById('offlineDecodeProgress')?.classList.contains('is-error') ? 1400 : 900);
    }
  }
}

function setRealtimeButton(active) {
  const button = document.getElementById('realtimeDecodeBtn');
  button.textContent = active ? '■ 停止实时解码' : '◉ 实时解码';
  button.setAttribute('aria-label', active ? '停止实时解码' : '边播放边实时解码上传的音频');
  button.classList.toggle('realtime-active', active);
}

async function toggleRealtimeDecode() {
  if (state.realtimeDecode) {
    stopRealtimeDecode(true);
    return;
  }
  if (!state.uploadedAudio || !state.audioPlayer?.duration || state.isProcessing) return;
  if (!validateRangeInputs()) return;

  const { samples, sampleRate } = state.uploadedAudio;
  const startSec = state.audioSelection.start;
  const endSec = state.audioSelection.end;
  const startSample = Math.floor(startSec * sampleRate);
  const endSample = Math.min(samples.length, Math.ceil(endSec * sampleRate));
  state.realtimeDecode = { samples, sampleRate, startSec, endSec, startSample, endSample, cursor: startSample, ended: false };
  updateSnrMeter();
  state.webDecoder?.reset({
    ...readReceiveOptions(),
    dsp: { ...readDspOptions(), engine: 'mmsstv' },
    emitFrames: true,
    emitSnr: true,
    renderEveryRows: 8,
  });
  setRealtimeButton(true);
  setReceiverStatus('实时搜索信号', 'active');
  setOfflineDecodeProgress(0, '实时解码 · 等待同步');
  ui.toast('实时解码已开始，正在同步播放音频', 'success');
  try {
    state.audioPlayer.seek(startSec);
    await state.audioPlayer.play();
  } catch (error) {
    stopRealtimeDecode(false);
    ui.toast('实时播放失败: ' + error.message, 'error');
  }
}

function stopRealtimeDecode(finalize = true) {
  const realtime = state.realtimeDecode;
  if (!realtime) return;
  state.realtimeDecode = null;
  if (finalize && !realtime.ended) {
    realtime.ended = true;
    try { state.webDecoder?.end(); } catch (error) { console.warn('Realtime decoder:', error); }
  }
  if (state.audioPlayer?.isPlaying) state.audioPlayer.pause();
  setRealtimeButton(false);
  updateSnrMeter();
  hideOfflineDecodeProgress();
}

function handlePlaybackChange({ time, isPlaying }) {
  const realtime = state.realtimeDecode;
  if (!realtime) return;
  if (!isPlaying) updateSnrMeter();
  const elapsed = Math.max(0, Math.min(realtime.endSec - realtime.startSec, time - realtime.startSec));
  const target = Math.min(realtime.endSample, realtime.startSample + Math.floor(elapsed * realtime.sampleRate));
  if (target > realtime.cursor) {
    state.webDecoder?.push(realtime.samples.subarray(realtime.cursor, target), realtime.sampleRate);
    realtime.cursor = target;
  }
  if (time >= realtime.endSec - 0.02) stopRealtimeDecode(true);
}

function bindReceiverEvents(receiver) {
  receiver.addEventListener('searching', () => {
    if (state.micActive) setReceiverStatus('搜索信号');
  });
  receiver.addEventListener('snr', ({ detail }) => {
    if (!state.micActive && !state.realtimeDecode) return;
    updateSnrMeter(detail.snrDb);
  });
  receiver.addEventListener('locked', ({ detail }) => {
    const labels = { vis: 'VIS', fsk: 'FSK', sync: '同步', manual: '手动' };
    setReceiverStatus(`已锁定 · ${labels[detail.source] || '自动'}`, 'locked');
    document.getElementById('receiverMode').textContent = detail.mode.name;
    if (state.offlineDecodeActive) {
      setOfflineDecodeProgress(0.05, `已锁定 ${detail.mode.name} · 正在读取图像行`);
    }
  });
  receiver.addEventListener('row', ({ detail }) => {
    if (state.offlineDecodeActive) {
      const ratio = Math.max(0, Math.min(1, detail.rows / detail.totalRows));
      setOfflineDecodeProgress(0.05 + ratio * 0.45, `正在读取图像行 ${detail.rows} / ${detail.totalRows}`);
    } else {
      setOfflineDecodeProgress(detail.rows / detail.totalRows, `实时解码 ${detail.rows} / ${detail.totalRows}`);
    }
  });
  receiver.addEventListener('decode-progress', ({ detail }) => {
    if (!state.offlineDecodeActive) return;
    const progress = Math.max(0, Math.min(1, Number(detail.progress) || 0));
    setOfflineDecodeProgress(
      0.5 + progress * 0.49,
      `正在重建图像 ${Math.round(progress * 100)}%`
    );
  });
  receiver.addEventListener('frame', ({ detail }) => renderReceiverFrame(detail.result));
  receiver.addEventListener('error', ({ detail }) => {
    if (state.micActive) setReceiverStatus('等待有效信号', 'active');
    if (state.realtimeDecode) {
      stopRealtimeDecode(false);
      ui.toast('实时解码失败: ' + detail.message, 'error');
    }
    console.warn('Receiver:', detail.message);
  });
}

export function updateSnrMeter(snrDb = null) {
  const meter = document.getElementById('receiverMeter');
  if (!meter) return;
  const bars = [...meter.querySelectorAll('.signal-cell')];

  if (typeof snrDb !== 'number' || !Number.isFinite(snrDb)) {
    bars.forEach(bar => bar.classList.remove('is-active'));
    meter.style.setProperty('--signal-level', '0%');
    meter.removeAttribute('aria-valuenow');
    meter.setAttribute('aria-valuetext', '等待信号');
    const output = document.getElementById('receiverLevelText');
    if (output) output.textContent = '-- dB';
    return;
  }

  const measured = snrDb;
  const meterValue = Math.max(SNR_METER_MIN_DB, Math.min(SNR_METER_MAX_DB, measured));
  const percent = (meterValue - SNR_METER_MIN_DB) / (SNR_METER_MAX_DB - SNR_METER_MIN_DB) * 100;
  const activeCount = percent > 0 ? Math.ceil(percent / 100 * bars.length) : 0;
  bars.forEach((bar, index) => bar.classList.toggle('is-active', index < activeCount));
  meter.style.setProperty('--signal-level', `${percent}%`);
  meter.setAttribute('aria-valuenow', meterValue.toFixed(1));
  meter.setAttribute('aria-valuetext', `${measured.toFixed(1)} dB`);
  const output = document.getElementById('receiverLevelText');
  if (output) output.textContent = `${measured.toFixed(1)} dB`;
}

export function renderReceiverFrame(result) {
  state.decodedResult = result;
  ui.renderToCanvas(document.getElementById('resultCanvas'), result.pixels, result.width, result.height);
  document.getElementById('saveImageBtn').disabled = false;
  document.getElementById('resetDecodedBtn').disabled = false;
  document.getElementById('decoderOutput').classList.remove('is-empty');
  document.getElementById('receiverMode').textContent = result.mode.name;
  document.getElementById('receiverAfc').textContent = result.dsp?.afcLocked
    ? `${result.dsp.afcOffsetHz >= 0 ? '+' : ''}${result.dsp.afcOffsetHz.toFixed(1)} Hz`
    : (result.dsp?.afc ? '未锁定' : '关闭');
}

export function resetDecodedResult({ announce = false, resetProgress = true } = {}) {
  state.decodeGeneration++;
  state.offlineDecodeActive = false;
  state.decodedResult = null;

  const canvas = document.getElementById('resultCanvas');
  if (canvas) {
    canvas.width = 320;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  document.getElementById('decoderOutput')?.classList.add('is-empty');
  const saveButton = document.getElementById('saveImageBtn');
  const resetButton = document.getElementById('resetDecodedBtn');
  if (saveButton) saveButton.disabled = true;
  if (resetButton) resetButton.disabled = true;
  const mode = document.getElementById('receiverMode');
  const afc = document.getElementById('receiverAfc');
  if (mode) mode.textContent = '--';
  if (afc) afc.textContent = '--';
  if (resetProgress) hideOfflineDecodeProgress();
  if (announce) ui.toast('解码画面已重置', 'success');
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
  updateSnrMeter();
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
  updateSnrMeter();
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

export function readDspOptions() {
  const low = document.getElementById('basebandLow');
  const high = document.getElementById('basebandHigh');
  const requestedLow = Number(low?.value ?? BASEBAND_DEFAULT.lowHz);
  const requestedHigh = Number(high?.value ?? BASEBAND_DEFAULT.highHz);
  const basebandSafe = Number.isFinite(requestedLow) && Number.isFinite(requestedHigh) &&
    requestedLow >= BASEBAND_MIN_HZ && requestedLow <= BASEBAND_LOW_MAX_HZ &&
    requestedHigh >= BASEBAND_HIGH_MIN_HZ && requestedHigh <= BASEBAND_MAX_HZ;
  return {
    afc: document.getElementById('dspAfc')?.checked === true,
    lms: document.getElementById('dspLms')?.checked === true,
    bpf: document.getElementById('dspBpf')?.checked === true,
    demodulator: 'phase',
    baseband: basebandSafe
      ? { lowHz: requestedLow, highHz: requestedHigh }
      : { ...BASEBAND_DEFAULT },
  };
}

function setupBasebandFilter() {
  const button = document.getElementById('basebandFilterBtn');
  const panel = document.getElementById('basebandFilterPanel');
  const low = document.getElementById('basebandLow');
  const high = document.getElementById('basebandHigh');
  let savedLow = BASEBAND_DEFAULT.lowHz;
  let savedHigh = BASEBAND_DEFAULT.highHz;
  let resetUnsafeSavedRange = false;
  try {
    const storedLow = localStorage.getItem('sstv.basebandLowHz');
    const storedHigh = localStorage.getItem('sstv.basebandHighHz');
    if (storedLow !== null || storedHigh !== null) {
      const parsedLow = Number(storedLow);
      const parsedHigh = Number(storedHigh);
      if (Number.isFinite(parsedLow) && Number.isFinite(parsedHigh)) {
        savedLow = parsedLow;
        savedHigh = parsedHigh;
      } else {
        resetUnsafeSavedRange = true;
      }
    }
  } catch (_) {}
  resetUnsafeSavedRange ||= savedLow < BASEBAND_MIN_HZ || savedLow > BASEBAND_LOW_MAX_HZ ||
    savedHigh < BASEBAND_HIGH_MIN_HZ || savedHigh > BASEBAND_MAX_HZ;
  if (resetUnsafeSavedRange) {
    savedLow = BASEBAND_DEFAULT.lowHz;
    savedHigh = BASEBAND_DEFAULT.highHz;
  }
  low.value = String(savedLow);
  high.value = String(savedHigh);

  const render = (persist = true) => {
    let lowHz = Number(low.value);
    let highHz = Number(high.value);
    if (!Number.isFinite(lowHz)) lowHz = BASEBAND_DEFAULT.lowHz;
    if (!Number.isFinite(highHz)) highHz = BASEBAND_DEFAULT.highHz;
    lowHz = Math.max(BASEBAND_MIN_HZ, Math.min(BASEBAND_LOW_MAX_HZ, lowHz));
    highHz = Math.max(BASEBAND_HIGH_MIN_HZ, Math.min(BASEBAND_MAX_HZ, highHz));
    low.value = String(lowHz);
    high.value = String(highHz);
    document.getElementById('basebandLowValue').textContent = `${lowHz} Hz`;
    document.getElementById('basebandHighValue').textContent = `${highHz} Hz`;
    document.getElementById('basebandCenterValue').textContent = `中心 ${Math.round((lowHz + highHz) / 2)} Hz`;
    document.getElementById('basebandFilterLabel').textContent = `${lowHz}–${highHz} Hz`;
    if (persist) {
      try {
        localStorage.setItem('sstv.basebandLowHz', String(lowHz));
        localStorage.setItem('sstv.basebandHighHz', String(highHz));
      } catch (_) {}
    }
  };

  const setOpen = open => {
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  };
  button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true'));
  low.addEventListener('input', () => render());
  high.addEventListener('input', () => render());
  document.getElementById('basebandResetBtn').addEventListener('click', () => {
    low.value = String(BASEBAND_DEFAULT.lowHz);
    high.value = String(BASEBAND_DEFAULT.highHz);
    render();
  });
  render(resetUnsafeSavedRange);
  if (resetUnsafeSavedRange) {
    ui.toast('原复基带范围会滤除 SSTV 同步/图像频率，已恢复 1000–2800 Hz');
  }
  return {
    isOpen: () => !panel.hidden,
    close: ({ restoreFocus = true } = {}) => {
      const wasOpen = !panel.hidden;
      setOpen(false);
      if (restoreFocus && wasOpen) button.focus();
    },
  };
}

function setupPageSettings(basebandController) {
  const toggle = document.querySelector('.rx-settings-fab');
  const panel = toggle ? document.getElementById(toggle.getAttribute('aria-controls')) : null;
  const scrim = document.querySelector('.rx-settings-scrim');
  const closeButton = panel?.querySelector('.rx-settings-close');
  if (!toggle || !panel || !scrim || !closeButton) return;
  const settingsLabel = panel.dataset.settingsLabel || '页面设置';

  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const getFocusable = () => [...panel.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(element =>
    !element.matches('select[data-enhanced]') &&
    !element.closest('[hidden]') &&
    element.getAttribute('aria-hidden') !== 'true'
  );

  const setOpen = (open, { restoreFocus = true } = {}) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', `${open ? '关闭' : '打开'}${settingsLabel}`);
    panel.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    panel.toggleAttribute('inert', !open);
    scrim.hidden = !open;
    document.body.classList.toggle('rx-settings-open', open);

    if (open) {
      const firstControl = panel.querySelector('.custom-select-trigger') || getFocusable()[0] || panel;
      firstControl.focus();
    } else {
      basebandController?.close({ restoreFocus: false });
      if (restoreFocus) toggle.focus();
    }
  };

  toggle.addEventListener('click', () => setOpen(!isOpen()));
  closeButton.addEventListener('click', () => setOpen(false));
  scrim.addEventListener('click', () => setOpen(false));

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;

    const openSelect = panel.querySelector('.custom-select-trigger[aria-expanded="true"]');
    if (openSelect) {
      event.preventDefault();
      openSelect.click();
      openSelect.focus();
      return;
    }
    if (basebandController?.isOpen()) {
      event.preventDefault();
      basebandController.close();
      return;
    }

    event.preventDefault();
    setOpen(false);
  });

  panel.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !isOpen()) return;
    const focusable = getFocusable();
    if (!focusable.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  setOpen(false, { restoreFocus: false });
}

export function readReceiveOptions() {
  const autoReceive = document.getElementById('autoReceive');
  return !autoReceive || autoReceive.checked
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
  let end = Number(document.getElementById('decodeEndSec').value);
  const duration = state.audioPlayer.duration;
  // 输入框显示一位小数，允许四舍五入后最多产生 0.05s 的误差。
  if (Number.isFinite(end) && end > duration && end - duration <= 0.051) {
    end = duration;
    document.getElementById('decodeEndSec').value = end.toFixed(1);
  }
  const valid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= duration && start < end;
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

// ---- 音频上传(WAV / MP3 等)----
async function onAudioFile(file) {
  const loadId = ++state.audioLoadId;
  if (state.realtimeDecode) stopRealtimeDecode(false);
  resetDecodedResult();
  state.audioPlayer?.clear();
  state.uploadedAudio = null;
  document.getElementById('decodeUploadedBtn').disabled = true;
  document.getElementById('realtimeDecodeBtn').disabled = true;
  for (const id of ['decodeStartSec', 'decodeEndSec']) document.getElementById(id).disabled = true;
  document.getElementById('audioMeta').textContent = 'LOADING AUDIO...';
  const spectrum = document.getElementById('spectrum');
  if (spectrum) spectrum.getContext('2d').clearRect(0, 0, spectrum.width, spectrum.height);
  try {
    ui.toast('解码音频文件中…');
    const { sampleRate, samples, format } = await decodeAudioFile(file);
    if (loadId !== state.audioLoadId) return;
    state.uploadedAudio = { sampleRate, samples, format };

    // 加载播放器会先显示时间轴，使两个 canvas 都能取得正确尺寸。
    await state.audioPlayer.loadAudio(samples, sampleRate);
    renderSpectrum(samples, sampleRate);

    document.getElementById('decodeUploadedBtn').disabled = false;
    document.getElementById('realtimeDecodeBtn').disabled = !state.webDecoder;
    const dur = (samples.length / sampleRate).toFixed(1);
    document.getElementById('decodeStartSec').disabled = false;
    document.getElementById('decodeEndSec').disabled = false;
    const durationSeconds = samples.length / sampleRate;
    document.getElementById('decodeStartSec').max = String(durationSeconds);
    document.getElementById('decodeEndSec').max = String(durationSeconds);
    // 显式同步新音频的完整选区，避免旧文件输入值在异步解码后残留。
    syncRangeInputs(state.audioPlayer.getSelectionTime());
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
  const states = {
    encodeBtn: !hasImg,
    playBtn: !hasPcm,
    downloadBtn: !hasPcm,
    selfTestBtn: !hasImg,
  };
  for (const [id, disabled] of Object.entries(states)) {
    const button = document.getElementById(id);
    if (button) button.disabled = disabled;
  }
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
