// app.js — 入口,装配 UI 与模块编排

import { listModes, getMode, DEFAULT_SAMPLE_RATE } from './modes.js';
import { encode } from './encoder.js';
import { decode, decodeAll } from './decoder.js';
import { encodeWAV, decodeWAV } from './wav.js';
import { decodeAudioFile, sliceFromStart } from './audiodecode.js';
import { magnitudeSpectrum, drawSpectrumColumn } from './fft.js';
import { AudioPlayer } from './audioPlayer.js';
import { WebSSTVDecoder } from './web-receiver.js';
import * as ui from './ui.js';
import { canvasBlob } from './image-export.js';
import { initTracking } from './tracking.js';
import { initPwa } from './pwa.js';

let fieldPwa;
let backgroundDuringMicStart = false;
let deferredRecordingDialog = false;

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
  micStarting: false,
  micStopPromise: null,
  microphoneRecording: null,
  recordingDialogReturnFocus: null,
  recordingDialogInertElements: [],
  receiveCompleteTimer: null,
  receiveCompleteCandidateKey: null,
  receiveCompleteLastPromptedKey: null,
  receiveCompleteDialogReturnFocus: null,
  receiveCompleteDialogInertElements: [],
  receiveCompleteDecisionInFlight: false,
  resultResizeObserver: null,
  realtimeDecode: null,
  offlineDecodeActive: false,
  offlineProgressHideTimer: null,
  decodedFrames: [],
  activeDecodedFrameIndex: -1,
  receiverFrameCount: 0,
  receiverPanelProgressBucket: -1,
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
const RECEIVE_COMPLETE_PROMPT_DELAY_MS = 1200;

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
  document.getElementById('offlineDecodeBtn')?.addEventListener('click', runOfflineDecode);
  document.getElementById('fastDecodeMode')?.addEventListener('change', updateOfflineDecodeMode);
  document.getElementById('saveImageBtn')?.addEventListener('click', saveDecodedImage);
  document.getElementById('resetDecodedBtn')?.addEventListener('click', () => resetDecodedResult({ announce: true, clearRecording: true }));
  document.getElementById('downloadRecordingBtn')?.addEventListener('click', () => {
    if (!state.microphoneRecording) return;
    downloadMicrophoneRecording(state.microphoneRecording);
    ui.toast('接收录音已保存', 'success');
  });
  setupReceiveCompletionDialog();
  setupRecordingSaveDialog();
  document.getElementById('previousDecodedFrame')?.addEventListener('click', () => {
    showDecodedFrame(state.activeDecodedFrameIndex - 1);
  });
  document.getElementById('nextDecodedFrame')?.addEventListener('click', () => {
    showDecodedFrame(state.activeDecodedFrameIndex + 1);
  });
  setupLiveScanlineResize();
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
  document.getElementById('micReceiveBtn')?.addEventListener('click', toggleMicrophoneReceiver);
  const basebandController = document.getElementById('basebandFilterBtn')
    ? setupBasebandFilter()
    : null;
  setupPageSettings(basebandController);
  document.getElementById('txChangeModeBtn')?.addEventListener('click', () => {
    const toggle = document.getElementById('txSettingsToggle');
    if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
  });

  if (audioDropzone && typeof Worker !== 'undefined') {
    state.webDecoder = new WebSSTVDecoder();
    bindReceiverEvents(state.webDecoder);
  } else if (audioDropzone) {
    document.getElementById('micReceiveBtn').disabled = true;
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
  const getFocusable = () => [...drawer.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
  const background = [...document.body.children].filter(element =>
    element !== button && element !== drawer && element !== scrim
  );
  let temporarilyInert = [];
  const setOpen = open => {
    drawer.classList.toggle('is-open', open);
    scrim.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
    drawer.setAttribute('aria-hidden', String(!open));
    drawer.toggleAttribute('inert', !open);
    if (open) {
      temporarilyInert = background.filter(element => !element.hasAttribute('inert'));
      temporarilyInert.forEach(element => element.setAttribute('inert', ''));
    } else {
      temporarilyInert.forEach(element => element.removeAttribute('inert'));
      temporarilyInert = [];
    }
    document.body.classList.toggle('nav-open', open);
    if (open) (drawer.querySelector('[aria-current="page"]') || getFocusable()[0] || drawer).focus();
    else if (drawer.contains(document.activeElement)) button.focus();
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
  drawer.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || button.getAttribute('aria-expanded') !== 'true') return;
    const focusable = getFocusable();
    if (!focusable.length) {
      event.preventDefault();
      drawer.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
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
      const decodeBtn = document.getElementById('offlineDecodeBtn');
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
  const previousMode = state.mode?.visCode;
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
  const currentMode = document.getElementById('txCurrentMode');
  if (currentMode) currentMode.textContent = `${m.name} · ${m.width}×${m.height}`;
  // 更新源画布尺寸预览
  if (state.sourceImage) drawSourcePreview();
  if (previousMode != null && previousMode !== state.mode?.visCode) invalidateEncodedOutput();
  updateButtons();
}

function invalidateEncodedOutput() {
  state.lastPCM = null;
  state.lastWAV = null;
  const audio = document.getElementById('audioPlayer');
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load?.();
  }
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = null;
  updatePlayButton();
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
    invalidateEncodedOutput();
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
    invalidateEncodedOutput();
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
  const menuId = `${select.id || 'select'}Menu`;
  trigger.setAttribute('aria-controls', menuId);
  select.tabIndex = -1;

  const menu = document.createElement('div');
  menu.id = menuId;
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', select.getAttribute('aria-label') || '选择');
  menu.hidden = true;

  const items = () => [...menu.querySelectorAll('[role="option"]')];
  const focusItem = index => {
    const options = items();
    if (!options.length) return;
    options[(index + options.length) % options.length].focus();
  };

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
    if (select.disabled) return;
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
    item.tabIndex = -1;
    item.textContent = option.textContent;
    item.addEventListener('click', () => {
      select.value = option.value;
      const ChangeEvent = select.ownerDocument.defaultView.Event;
      select.dispatchEvent(new ChangeEvent('change', { bubbles: true }));
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
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
      const selected = menu.querySelector('.is-selected');
      (selected || items()[event.key === 'ArrowUp' ? items().length - 1 : 0])?.focus();
      selected?.scrollIntoView?.({ block: 'nearest' });
    }
  });
  menu.addEventListener('keydown', event => {
    const options = items();
    const current = options.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(current + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusItem(event.key === 'Home' ? 0 : options.length - 1);
    } else if ((event.key === 'Enter' || event.key === ' ') && current >= 0) {
      event.preventDefault();
      options[current].click();
      trigger.focus();
    } else if (event.key === 'Tab') {
      close();
    }
  });
  select.addEventListener('change', sync);
  document.addEventListener('click', event => {
    if (!host.contains(event.target)) close();
  });

  host.insertBefore(trigger, select);
  host.appendChild(menu);
  select._enhancedControl = {
    trigger,
    menu,
    setDisabled(disabled) {
      select.disabled = !!disabled;
      trigger.disabled = !!disabled;
      trigger.setAttribute('aria-disabled', String(!!disabled));
      if (disabled) close();
    },
  };
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
  if (state.micActive || state.micStarting || state.micStopPromise) {
    ui.toast('请先停止麦克风接收，再开始文件解码', 'error');
    return;
  }
  if (state.realtimeDecode) stopRealtimeDecode(true);
  if (pcm === state.uploadedAudio?.samples && !validateRangeInputs()) return;

  state.isProcessing = true;
  state.offlineDecodeActive = true;
  const decodeGeneration = state.decodeGeneration;
  const offlineDecodeBtn = document.getElementById('offlineDecodeBtn');
  offlineDecodeBtn.classList.add('loading');
  offlineDecodeBtn.setAttribute('aria-busy', 'true');
  document.getElementById('fastDecodeMode').disabled = true;
  setReceiverStatus('搜索信号', 'active');
  setReceiverPanelState('SEARCHING', 'searching');
  setOfflineDecodeProgress(null, '正在分析 VIS / 同步');
  await waitForBrowserPaint();

  // 从音频播放器获取选区，如果没有则使用完整音频
  const totalDuration = pcm.length / sr;
  const startSec = state.audioSelection.start || 0;
  const endSec = state.audioSelection.end > 0 ? state.audioSelection.end : totalDuration;
  const duration = endSec - startSec;
  const selectionStartSample = Math.floor(startSec * sr);

  try {
    let work = pcm;
    if (startSec > 0 || endSec < totalDuration) {
      const endSample = Math.min(Math.floor(endSec * sr), pcm.length);
      work = pcm.subarray(selectionStartSample, endSample);
      ui.toast(`解码选中区域 ${startSec.toFixed(1)}s ~ ${endSec.toFixed(1)}s (${duration.toFixed(1)}s)…`);
    } else {
      ui.toast('在后台解码完整音频…');
    }

    const dsp = { ...readDspOptions(), engine: 'mmsstv' };
    const receive = readReceiveOptions();
    const output = state.webDecoder
      ? await state.webDecoder.decodeAll(work, sr, {
          ...receive,
          dsp,
          onProgress: progress => setOfflineDecodeProgress(
            progress,
            `正在扫描并重建图像 ${Math.round(progress * 100)}%`
          ),
        })
      : decodeAll(work, sr, {
          ...receive,
          dsp,
          onProgress: progress => setOfflineDecodeProgress(
            progress,
            `正在扫描并重建图像 ${Math.round(progress * 100)}%`
          ),
        });
    if (decodeGeneration !== state.decodeGeneration) return;
    const frames = output.frames.map(frame => ({
      ...frame,
      startSec: (selectionStartSample + frame.audioRange.startSample) / sr,
      endSec: (selectionStartSample + frame.audioRange.endSample) / sr,
    }));
    setDecodedFrames(frames);
    const result = frames[0].result;
    const incompleteCount = frames.filter(frame => !frame.complete).length;
    setOfflineDecodeProgress(1, `${result.mode.name} · ${frames.length} 张解码完成`, 'complete');
    const notices = [];
    if (incompleteCount) notices.push(`${incompleteCount} 张不完整`);
    if (output.skippedCount) notices.push(`跳过 ${output.skippedCount} 个无效帧`);
    ui.toast(
      `解码完成 · ${result.mode.name} · ${frames.length} 张${notices.length ? ` · ${notices.join('，')}` : ''}`,
      'success'
    );
  } catch (e) {
    console.error(e);
    if (decodeGeneration === state.decodeGeneration) {
      setOfflineDecodeProgress(null, '解码失败 · 请检查信号或模式', 'error');
      ui.toast('解码失败: ' + e.message, 'error');
    }
  } finally {
    state.isProcessing = false;
    state.offlineDecodeActive = false;
    offlineDecodeBtn.classList.remove('loading');
    offlineDecodeBtn.removeAttribute('aria-busy');
    document.getElementById('fastDecodeMode').disabled = false;
    updateOfflineDecodeMode();
    if (decodeGeneration === state.decodeGeneration) {
      hideOfflineDecodeProgress(document.getElementById('offlineDecodeProgress')?.classList.contains('is-error') ? 1400 : 900);
    }
  }
}

function setRealtimeButton(active) {
  const button = document.getElementById('offlineDecodeBtn');
  document.getElementById('offlineDecodeIcon').textContent = active ? '■' : '◉';
  document.getElementById('offlineDecodeLabel').textContent = active ? '停止实时解码' : '播放并实时解码';
  button.setAttribute('aria-label', active ? '停止播放和实时解码' : '播放音频并实时解码');
  button.classList.toggle('realtime-active', active);
  document.getElementById('fastDecodeMode').disabled = active;
}

function runOfflineDecode() {
  if (state.micActive || state.micStarting || state.micStopPromise) {
    ui.toast('请先停止麦克风接收，再开始文件解码', 'error');
    return;
  }
  if (document.getElementById('fastDecodeMode').checked) {
    if (!state.uploadedAudio) return;
    return onDecode(state.uploadedAudio.samples, state.uploadedAudio.sampleRate);
  }
  return toggleRealtimeDecode();
}

function updateOfflineDecodeMode() {
  if (state.realtimeDecode || state.isProcessing) return;
  const fast = document.getElementById('fastDecodeMode').checked;
  const button = document.getElementById('offlineDecodeBtn');
  const rangeInvalid = ['decodeStartSec', 'decodeEndSec']
    .some(id => document.getElementById(id).getAttribute('aria-invalid') === 'true');
  document.getElementById('offlineDecodeIcon').textContent = fast ? '⚡' : '◉';
  document.getElementById('offlineDecodeLabel').textContent = fast ? '极速解码' : '播放并实时解码';
  button.setAttribute('aria-label', fast ? '极速解码上传的音频' : '播放音频并实时解码，会通过扬声器发声');
  button.title = fast ? '后台快速处理，不播放音频' : '按实际速度播放音频并实时解码，会通过扬声器发声';
  button.classList.toggle('primary', fast);
  button.classList.toggle('accent', !fast);
  button.disabled = state.micActive || state.micStarting || !!state.micStopPromise
    || !state.uploadedAudio || rangeInvalid || (!fast && !state.webDecoder);
}

async function toggleRealtimeDecode() {
  if (state.realtimeDecode) {
    stopRealtimeDecode(true);
    return;
  }
  if (state.micActive || state.micStarting || state.micStopPromise) {
    ui.toast('请先停止麦克风接收，再开始实时解码', 'error');
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
  setReceiverPanelState('SEARCHING', 'searching');
  setOfflineDecodeProgress(0, '实时解码 · 等待同步');
  ui.toast('正在播放音频并实时解码，扬声器会发声', 'success');
  try {
    state.audioPlayer.seek(startSec);
    await state.audioPlayer.play();
  } catch (error) {
    stopRealtimeDecode(false);
    ui.toast('实时播放失败: ' + error.message, 'error');
  }
}

function stopRealtimeDecode(finalize = true) {
  cancelReceiveCompletionPrompt();
  const realtime = state.realtimeDecode;
  if (!realtime) return;
  state.realtimeDecode = null;
  if (finalize && !realtime.ended) {
    realtime.ended = true;
    try {
      const finalizePromise = state.webDecoder?.end();
      if (finalizePromise?.catch) void finalizePromise.catch(error => console.warn('Realtime decoder:', error));
    } catch (error) {
      console.warn('Realtime decoder:', error);
    }
  } else if (!finalize) {
    try { state.webDecoder?.cancelReceiver?.(); } catch (error) { console.warn('Realtime decoder cancel:', error); }
  }
  if (state.audioPlayer?.isPlaying) state.audioPlayer.pause();
  setRealtimeButton(false);
  updateSnrMeter();
  hideOfflineDecodeProgress();
}

function handlePlaybackChange({ time, isPlaying }) {
  const realtime = state.realtimeDecode;
  if (!realtime) return;
  const elapsed = Math.max(0, Math.min(realtime.endSec - realtime.startSec, time - realtime.startSec));
  const target = Math.min(realtime.endSample, realtime.startSample + Math.floor(elapsed * realtime.sampleRate));
  if (target < realtime.cursor) {
    realtime.cursor = realtime.startSample;
    state.webDecoder?.reset({
      ...readReceiveOptions(),
      dsp: { ...readDspOptions(), engine: 'mmsstv' },
      emitFrames: true,
      emitSnr: true,
      renderEveryRows: 8,
    });
    setReceiverStatus('实时搜索信号', 'active');
    setOfflineDecodeProgress(0, '实时解码 · 已从新位置重新同步');
  }
  if (target > realtime.cursor) {
    state.webDecoder?.push(realtime.samples.subarray(realtime.cursor, target), realtime.sampleRate);
    realtime.cursor = target;
  }
  if (!isPlaying) {
    if (time >= realtime.endSec - 0.02) stopRealtimeDecode(true);
    else updateSnrMeter();
    return;
  }
  if (time >= realtime.endSec - 0.02) stopRealtimeDecode(true);
}

function bindReceiverEvents(receiver) {
  receiver.addEventListener('input-interrupted', () => {
    if (state.micStarting) backgroundDuringMicStart = true;
    if (state.micActive) void stopMicrophoneReceiver({ interrupted: true });
  });
  receiver.addEventListener('searching', () => {
    if (state.micActive || state.micStarting || state.realtimeDecode) {
      updateReceiverSearchingPresentation();
    }
  });
  receiver.addEventListener('snr', ({ detail }) => {
    if (!state.micActive && !state.realtimeDecode) return;
    updateSnrMeter(detail.snrDb);
  });
  receiver.addEventListener('locked', ({ detail }) => {
    cancelReceiveCompletionPrompt();
    const labels = { vis: 'VIS', fsk: 'FSK', sync: '同步', manual: '手动' };
    setReceiverStatus(
      `已锁定 · ${labels[detail.source] || '自动'}${state.micActive ? ' · 录音中' : ''}`,
      'locked'
    );
    document.getElementById('receiverMode').textContent = detail.mode.name;
    state.receiverPanelProgressBucket = -1;
    setReceiverPanelState(`LOCKED · ${detail.mode.name}`, 'receiving');
    if (state.offlineDecodeActive) {
      setOfflineDecodeProgress(0.05, `已锁定 ${detail.mode.name} · 正在读取图像行`);
    }
  });
  receiver.addEventListener('row', ({ detail }) => {
    updateReceiverRowPresentation(detail);
  });
  receiver.addEventListener('frame-start', ({ detail }) => {
    cancelReceiveCompletionPrompt();
    beginReceiverFrame(detail);
  });
  receiver.addEventListener('frame-patch', ({ detail }) => applyReceiverFramePatch(detail));
  receiver.addEventListener('frame-error', ({ detail }) => finalizeReceiverFrameError(detail));
  receiver.addEventListener('decode-progress', ({ detail }) => {
    if (!state.offlineDecodeActive) return;
    const progress = Math.max(0, Math.min(1, Number(detail.progress) || 0));
    setOfflineDecodeProgress(
      0.5 + progress * 0.49,
      `正在重建图像 ${Math.round(progress * 100)}%`
    );
  });
  receiver.addEventListener('frame', ({ detail }) => {
    const complete = detail.complete !== false && detail.partial !== true;
    const completionRatio = complete
      ? 1
      : Math.max(0, Math.min(1,
          Number(detail.completionRatio) || Number(detail.rows) / Math.max(1, Number(detail.result?.height) || 1)
        ));
    renderReceiverFrame(detail.result, {
      append: true,
      partial: detail.partial === true,
      complete,
      completionRatio,
    });
    if (complete) {
      state.receiverFrameCount++;
      setReceiverPanelState(`FRAME ${state.receiverFrameCount} COMPLETE`, 'complete');
      setOfflineDecodeProgress(1, `${detail.result.mode.name} · 图像接收完成`, 'complete');
    } else if (detail.partial !== true) {
      setReceiverPanelState(`FRAME INCOMPLETE · ${Math.round(completionRatio * 100)}%`, 'error');
      setOfflineDecodeProgress(completionRatio, `${detail.result.mode.name} · 图像接收不完整`, 'error');
    }
  });
  receiver.addEventListener('transmission-ended', ({ detail }) => {
    scheduleReceiveCompletionPrompt(detail);
  });
  receiver.addEventListener('recording-limit', ({ detail }) => {
    if (!state.micActive || state.micStopPromise) return;
    cancelReceiveCompletionPrompt();
    const minutes = Math.max(1, Math.round((Number(detail.durationSeconds) || 600) / 60));
    setReceiverStatus(`已达录音上限 · 正在停止`, 'active');
    ui.toast(`录音已达 ${minutes} 分钟上限，正在自动停止并保留已录内容`, 'error');
    void stopMicrophoneReceiver({ limitReached: true, durationSeconds: detail.durationSeconds });
  });
  receiver.addEventListener('error', ({ detail }) => {
    cancelReceiveCompletionPrompt();
    setReceiverPanelState('RECEIVER ERROR', 'error');
    if (state.micActive) setReceiverStatus('等待有效信号 · 本机录音中', 'active');
    if (state.realtimeDecode) {
      stopRealtimeDecode(false);
      ui.toast('实时解码失败: ' + detail.message, 'error');
    }
    console.warn('Receiver:', detail.message);
  });
}

export function updateReceiverSearchingPresentation(
  completedFrames = state.receiverFrameCount,
  recording = state.micActive
) {
  setReceiverPanelState(completedFrames ? 'SEARCHING NEXT' : 'SEARCHING', 'searching');
  setReceiverStatus(recording ? '搜索信号 · 本机录音中' : '搜索信号', 'active');
  if (completedFrames) {
    setOfflineDecodeProgress(null, `等待下一帧 · 已完成 ${completedFrames} 张`);
  }
}

export function updateReceiverRowPresentation(detail) {
  const rows = Math.max(0, Number(detail?.rows) || 0);
  const totalRows = Math.max(1, Number(detail?.totalRows) || 1);
  const ratio = Math.max(0, Math.min(1, rows / totalRows));
  const percent = Math.round(ratio * 100);
  const bucket = Math.min(10, Math.floor(percent / 10));
  if (bucket !== state.receiverPanelProgressBucket) {
    state.receiverPanelProgressBucket = bucket;
    setReceiverPanelState(`RECEIVING · ${bucket * 10}%`, 'receiving');
  }
  if (state.offlineDecodeActive) {
    setOfflineDecodeProgress(0.05 + ratio * 0.45, `正在读取图像行 ${rows} / ${totalRows}`);
  } else {
    setOfflineDecodeProgress(ratio, `实时解码 ${rows} / ${totalRows}`);
  }
}

function opaqueBlackPixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
  return pixels;
}

function shouldFollowLiveFrame() {
  return state.activeDecodedFrameIndex < 0 ||
    state.activeDecodedFrameIndex === state.decodedFrames.length - 1;
}

export function beginReceiverFrame({ frameId, width, height, mode, dsp = {} }) {
  if (!Number.isSafeInteger(frameId) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || !mode) return;
  const follow = shouldFollowLiveFrame();
  const frame = {
    receiverFrameId: frameId,
    result: { width, height, mode, dsp, pixels: opaqueBlackPixels(width, height) },
    complete: false,
    completionRatio: 0,
    livePartial: true,
  };
  const lastIndex = state.decodedFrames.length - 1;
  if (lastIndex >= 0 && state.decodedFrames[lastIndex].livePartial) {
    state.decodedFrames[lastIndex] = frame;
  } else {
    state.decodedFrames.push(frame);
  }
  showDecodedFrame(follow ? state.decodedFrames.length - 1 : state.activeDecodedFrameIndex);
}

export function applyReceiverFramePatch({ frameId, y, rowCount, pixels, rows, totalRows }) {
  const lastIndex = state.decodedFrames.length - 1;
  const frame = state.decodedFrames[lastIndex];
  if (!frame?.livePartial || frame.receiverFrameId !== frameId || !(pixels instanceof Uint8ClampedArray)) return;
  const { result } = frame;
  const top = Math.max(0, Math.min(result.height, Math.floor(Number(y) || 0)));
  const count = Math.max(0, Math.min(result.height - top, Math.floor(Number(rowCount) || 0)));
  if (!count || pixels.length !== result.width * count * 4) return;
  result.pixels.set(pixels, top * result.width * 4);
  frame.completionRatio = Math.max(
    frame.completionRatio,
    Math.max(0, Math.min(1, Number(rows) / Math.max(1, Number(totalRows) || result.height)))
  );
  if (state.activeDecodedFrameIndex === lastIndex) {
    ui.renderCanvasPatch(
      document.getElementById('resultCanvas'), pixels, result.width, result.height, top, count
    );
    updateDecodedFramePresentation(frame, lastIndex);
  }
}

export function finalizeReceiverFrameError({ frameId } = {}) {
  const lastIndex = state.decodedFrames.length - 1;
  const frame = state.decodedFrames[lastIndex];
  if (!frame?.livePartial || frame.receiverFrameId !== frameId) return;
  // The authoritative full-frame correction failed, but the already committed
  // strips remain useful. Freeze them as an explicitly incomplete, savable
  // result so the page cannot remain stuck in LIVE state forever.
  frame.livePartial = false;
  frame.complete = false;
  if (state.activeDecodedFrameIndex === lastIndex) {
    updateDecodedFramePresentation(frame, lastIndex);
  } else {
    updateResultActionButtons();
  }
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

function formatAudioTime(seconds) {
  const tenths = Math.max(0, Math.round((Number(seconds) || 0) * 10));
  const wholeSeconds = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${fraction}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${fraction}`;
}

function activeDecodedFrame() {
  return state.decodedFrames[state.activeDecodedFrameIndex] || null;
}

export function setDecodedFrames(frames) {
  state.decodedFrames = Array.isArray(frames) ? frames.slice() : [];
  state.activeDecodedFrameIndex = state.decodedFrames.length ? 0 : -1;
  if (state.activeDecodedFrameIndex >= 0) showDecodedFrame(0);
}

export function showDecodedFrame(index) {
  if (!state.decodedFrames.length) return;
  const nextIndex = Math.max(0, Math.min(state.decodedFrames.length - 1, Number(index) || 0));
  state.activeDecodedFrameIndex = nextIndex;
  const frame = state.decodedFrames[nextIndex];
  const { result } = frame;
  const canvas = document.getElementById('resultCanvas');
  ui.renderToCanvas(canvas, result.pixels, result.width, result.height);
  updateDecodedFramePresentation(frame, nextIndex);
}

function updateDecodedFramePresentation(frame, nextIndex) {
  const { result } = frame;
  const canvas = document.getElementById('resultCanvas');
  updateResultActionButtons();
  const output = document.getElementById('decoderOutput');
  output.classList.remove('is-empty');
  output.classList.toggle('is-live-preview', frame.livePartial === true);
  output.style.setProperty('--receive-progress', `${Math.round((frame.completionRatio || 0) * 100)}%`);
  updateLiveScanlineGeometry(canvas, output, frame.completionRatio || 0);
  document.getElementById('receiverMode').textContent = result.mode.name;
  document.getElementById('receiverAfc').textContent = result.dsp?.afcLocked
    ? `${result.dsp.afcOffsetHz >= 0 ? '+' : ''}${result.dsp.afcOffsetHz.toFixed(1)} Hz`
    : (result.dsp?.afc ? '未锁定' : '关闭');

  const hasAudioRange = Number.isFinite(frame.startSec) && Number.isFinite(frame.endSec);
  const incomplete = document.getElementById('resultIncomplete');
  incomplete.hidden = frame.complete !== false;
  incomplete.classList.toggle('is-live', frame.livePartial === true);
  incomplete.textContent = frame.livePartial
    ? `LIVE · 接收中 ${Math.round((frame.completionRatio || 0) * 100)}%`
    : `不完整 ${Math.round((frame.completionRatio || 0) * 100)}%`;
  if (hasAudioRange) {
    const rangeText = `${formatAudioTime(frame.startSec)} - ${formatAudioTime(frame.endSec)}`;
    document.getElementById('resultAudioRange').textContent = rangeText;
    canvas.setAttribute(
      'aria-label',
      `第 ${nextIndex + 1} 张解码图像，音频 ${formatAudioTime(frame.startSec)} 至 ${formatAudioTime(frame.endSec)}`
    );
  } else {
    document.getElementById('resultAudioRange').textContent = '--:--.- - --:--.-';
    canvas.setAttribute(
      'aria-label',
      frame.complete === false
        ? `第 ${nextIndex + 1} 张实时解码图像，完成 ${Math.round((frame.completionRatio || 0) * 100)}%`
        : '解码结果图像'
    );
  }

  const pageCount = document.getElementById('decodedPageCount');
  const pageCountText = `${String(nextIndex + 1).padStart(2, '0')} / ${String(state.decodedFrames.length).padStart(2, '0')}`;
  if (pageCount.textContent !== pageCountText) pageCount.textContent = pageCountText;
  document.getElementById('previousDecodedFrame').disabled = nextIndex === 0;
  document.getElementById('nextDecodedFrame').disabled = nextIndex === state.decodedFrames.length - 1;
}

function updateLiveScanlineGeometry(canvas, output, completionRatio = 0) {
  const stage = canvas?.parentElement;
  if (!stage || !output) return;
  const stageRect = stage.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const canvasBoxWidth = canvasRect.width || stage.clientWidth;
  const canvasBoxHeight = canvasRect.height || stage.clientHeight;
  if (!canvasBoxWidth || !canvasBoxHeight || !canvas.width || !canvas.height) {
    output.style.setProperty('--receive-image-left', '0px');
    output.style.setProperty('--receive-image-top', '0px');
    output.style.setProperty('--receive-image-width', '100%');
    output.style.setProperty('--receive-image-height', '100%');
    output.style.setProperty('--receive-scanline-top', `${Math.max(0, Math.min(1, completionRatio)) * 100}%`);
    return;
  }
  const scale = Math.min(canvasBoxWidth / canvas.width, canvasBoxHeight / canvas.height);
  const imageWidth = canvas.width * scale;
  const imageHeight = canvas.height * scale;
  const canvasLeft = canvasRect.width ? canvasRect.left - stageRect.left - stage.clientLeft : 0;
  const canvasTop = canvasRect.height ? canvasRect.top - stageRect.top - stage.clientTop : 0;
  const imageLeft = canvasLeft + (canvasBoxWidth - imageWidth) / 2;
  const imageTop = canvasTop + (canvasBoxHeight - imageHeight) / 2;
  const scanlineTop = imageTop + imageHeight * Math.max(0, Math.min(1, completionRatio));
  output.style.setProperty('--receive-image-left', `${imageLeft}px`);
  output.style.setProperty('--receive-image-top', `${imageTop}px`);
  output.style.setProperty('--receive-image-width', `${imageWidth}px`);
  output.style.setProperty('--receive-image-height', `${imageHeight}px`);
  output.style.setProperty('--receive-scanline-top', `${scanlineTop}px`);
}

function setupLiveScanlineResize() {
  const canvas = document.getElementById('resultCanvas');
  const output = document.getElementById('decoderOutput');
  const stage = canvas?.parentElement;
  if (!canvas || !output || !stage) return;
  const refresh = () => {
    const frame = activeDecodedFrame();
    if (frame?.livePartial) updateLiveScanlineGeometry(canvas, output, frame.completionRatio || 0);
  };
  if (typeof ResizeObserver === 'function') {
    state.resultResizeObserver = new ResizeObserver(refresh);
    state.resultResizeObserver.observe(stage);
  } else {
    window.addEventListener('resize', refresh, { passive: true });
  }
}

export function renderReceiverFrame(result, {
  append = false,
  partial = false,
  complete = !partial,
  completionRatio = result?.completionRatio,
} = {}) {
  const normalizedCompletion = Math.max(0, Math.min(1, Number(completionRatio) || 0));
  const frame = {
    result,
    complete,
    completionRatio: complete ? 1 : normalizedCompletion,
    livePartial: partial,
  };
  if (!append) {
    setDecodedFrames([frame]);
    return;
  }
  const follow = shouldFollowLiveFrame();
  const lastIndex = state.decodedFrames.length - 1;
  if (lastIndex >= 0 && state.decodedFrames[lastIndex].livePartial) {
    state.decodedFrames[lastIndex] = frame;
  } else {
    state.decodedFrames.push(frame);
  }
  showDecodedFrame(follow ? state.decodedFrames.length - 1 : state.activeDecodedFrameIndex);
}

export function resetDecodedResult({ announce = false, resetProgress = true, clearRecording = false } = {}) {
  cancelReceiveCompletionPrompt();
  const receiverIdle = !state.micActive && !state.micStarting && !state.micStopPromise && !state.realtimeDecode;
  if (receiverIdle) {
    try { state.webDecoder?.cancelReceiver?.(); } catch (error) { console.warn('Receiver reset cancel:', error); }
  }
  state.decodeGeneration++;
  state.offlineDecodeActive = false;
  state.webDecoder?.cancelBatch('Decoded images reset');
  state.decodedFrames = [];
  state.activeDecodedFrameIndex = -1;
  state.receiverFrameCount = 0;
  state.receiverPanelProgressBucket = -1;

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
  document.getElementById('decoderOutput')?.classList.remove('is-live-preview');
  const audioRange = document.getElementById('resultAudioRange');
  const incomplete = document.getElementById('resultIncomplete');
  const pageCount = document.getElementById('decodedPageCount');
  const previous = document.getElementById('previousDecodedFrame');
  const next = document.getElementById('nextDecodedFrame');
  if (audioRange) audioRange.textContent = '--:--.- - --:--.-';
  if (incomplete) incomplete.hidden = true;
  if (pageCount) pageCount.textContent = '00 / 00';
  if (previous) previous.disabled = true;
  if (next) next.disabled = true;
  const canvasLabel = document.getElementById('resultCanvas');
  canvasLabel?.setAttribute('aria-label', '解码结果图像');
  if (clearRecording) {
    state.microphoneRecording = null;
    closeRecordingSaveDialog(false);
  }
  updateResultActionButtons();
  const mode = document.getElementById('receiverMode');
  const afc = document.getElementById('receiverAfc');
  if (mode) mode.textContent = '--';
  if (afc) afc.textContent = '--';
  if (resetProgress) hideOfflineDecodeProgress();
  if (receiverIdle) {
    setReceiverPanelState('STANDBY', 'standby');
  }
  if (announce) ui.toast(clearRecording ? '接收结果和录音已清空' : '全部解码画面已重置', 'success');
}

function updateResultActionButtons() {
  const hasFrame = state.decodedFrames.length > 0;
  const hasSavableFrame = hasFrame && activeDecodedFrame()?.livePartial !== true;
  const hasRecording = !!state.microphoneRecording;
  const saveImage = document.getElementById('saveImageBtn');
  const reset = document.getElementById('resetDecodedBtn');
  const downloadRecording = document.getElementById('downloadRecordingBtn');
  if (saveImage) {
    saveImage.disabled = !hasSavableFrame;
    saveImage.title = hasFrame && !hasSavableFrame ? '接收完成后可保存' : '保存解码图片';
    saveImage.setAttribute('aria-label', saveImage.title);
  }
  if (reset) {
    reset.disabled = !hasFrame && !hasRecording;
    reset.title = hasRecording ? '清空解码画面和接收录音' : '重置解码画面';
    reset.setAttribute('aria-label', reset.title);
  }
  if (downloadRecording) {
    downloadRecording.hidden = !hasRecording;
    downloadRecording.disabled = !hasRecording;
  }
}

function setReceiverStatus(text, stateClass = '') {
  document.getElementById('receiverStatus').textContent = text;
  const indicator = document.getElementById('liveIndicator');
  if (indicator) indicator.className = `live-indicator ${stateClass}`.trim();
}

function setReceiverPanelState(text, phase = 'standby') {
  const panelState = document.getElementById('receiverPanelState');
  if (!panelState) return;
  panelState.className = `panel-state is-${phase}`;
  const label = panelState.querySelector('span');
  if (label) label.textContent = text;
}

function setMicrophoneButton(active, disabled = false) {
  const button = document.getElementById('micReceiveBtn');
  const label = document.getElementById('micReceiveLabel');
  if (!button || !label) return;
  button.disabled = disabled;
  button.classList.toggle('is-receiving', active);
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.setAttribute(
    'aria-label',
    active ? '停止接收并结束本机录音' : '开始接收，本机暂存录音最长 10 分钟'
  );
  button.title = active ? '停止接收并保留本机录音' : '接收期间仅在本机暂存录音，最长 10 分钟';
  label.textContent = active ? '停止接收' : '开始接收';
}

function toggleMicrophoneReceiver() {
  return state.micActive ? stopMicrophoneReceiver() : startMicrophoneReceiver();
}

async function startMicrophoneReceiver() {
  if (!state.webDecoder || state.micActive || state.micStarting || state.micStopPromise) return;
  if (state.isProcessing || state.realtimeDecode) {
    ui.toast('请先停止文件解码，再开始麦克风接收', 'error');
    return;
  }
  if (state.microphoneRecording) {
    ui.toast('请先下载并清空已暂存的录音，再开始新的接收', 'error');
    document.getElementById('downloadRecordingBtn')?.focus();
    return;
  }
  cancelReceiveCompletionPrompt({ closeDialog: true, restoreFocus: false });
  state.receiveCompleteLastPromptedKey = null;
  state.micStarting = true;
  backgroundDuringMicStart = false;
  state.receiverFrameCount = 0;
  setMicrophoneButton(false, true);
  document.getElementById('offlineDecodeBtn').disabled = true;
  updateSnrMeter();
  setReceiverStatus('请求权限', 'active');
  setReceiverPanelState('CONNECTING', 'searching');
  try {
    await state.webDecoder.startMicrophone({
      ...readReceiveOptions(),
      dsp: { ...readDspOptions(), engine: 'mmsstv' },
    });
    state.micActive = true;
    if (document.hidden || backgroundDuringMicStart) {
      await stopMicrophoneReceiver({ background: true });
      return;
    }
    setMicrophoneButton(true);
    setReceiverStatus('搜索信号 · 本机录音中', 'active');
    setReceiverPanelState('SEARCHING', 'searching');
    ui.toast('麦克风接收已开始；录音仅在本机暂存，最长 10 分钟', 'success');
  } catch (error) {
    setMicrophoneButton(false);
    setReceiverStatus('无法启动');
    setReceiverPanelState('START FAILED', 'error');
    ui.toast('麦克风启动失败: ' + error.message, 'error');
  } finally {
    state.micStarting = false;
    updateOfflineDecodeMode();
    fieldPwa?.refresh();
  }
}

async function stopMicrophoneReceiver({ limitReached = false, durationSeconds = null, background = false, interrupted = false } = {}) {
  cancelReceiveCompletionPrompt({ closeDialog: true, restoreFocus: false });
  if (!state.webDecoder || (!state.micActive && !state.micStopPromise)) return;
  if (state.micStopPromise) return state.micStopPromise;
  state.micStopPromise = (async () => {
    setMicrophoneButton(true, true);
    state.micActive = false;
    let failed = false;
    try {
      const recording = await state.webDecoder.stopMicrophone(true);
      if (recording) {
        state.microphoneRecording = {
          ...recording,
          limitReached: recording.limitReached || limitReached,
          limitDurationSeconds: durationSeconds,
          capturedAt: new Date(),
        };
        updateResultActionButtons();
        if (background || document.hidden) {
          deferredRecordingDialog = true;
          if (!document.hidden) { deferredRecordingDialog = false; openRecordingSaveDialog(state.microphoneRecording); }
        } else openRecordingSaveDialog(state.microphoneRecording);
      } else {
        ui.toast('接收期间没有采集到录音', 'error');
      }
    } catch (error) {
      failed = true;
      console.error(error);
      setReceiverStatus('停止失败');
      ui.toast('停止麦克风失败: ' + error.message, 'error');
    } finally {
      setMicrophoneButton(false);
      updateSnrMeter();
      if (!failed) {
        setReceiverStatus(interrupted ? '音频输入中断 · 已停止并保留录音' : background ? '离开前台 · 已停止并保留录音' : limitReached ? '已达上限 · 已停止' : '已停止');
        setReceiverPanelState('STANDBY', 'standby');
      }
    }
  })();
  try {
    return await state.micStopPromise;
  } finally {
    state.micStopPromise = null;
    updateOfflineDecodeMode();
  }
}

function downloadMicrophoneRecording({ samples, sampleRate, capturedAt = new Date() }) {
  const wav = encodeWAV(samples, sampleRate);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const timestamp = capturedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  link.href = url;
  link.download = `sstv_recording_${timestamp}.wav`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function syncModalBodyState() {
  const completionOpen = document.getElementById('receiveCompleteDialog')?.hidden === false;
  const recordingOpen = document.getElementById('recordingSaveDialog')?.hidden === false;
  document.body.classList.toggle('recording-dialog-open', completionOpen || recordingOpen);
}

function receiveCompletionKey(detail) {
  const sessionId = Number.isSafeInteger(detail?.sessionId) ? detail.sessionId : 'local';
  const frameId = Number.isSafeInteger(detail?.frameId) ? detail.frameId : state.receiverFrameCount;
  return `${sessionId}:${frameId}`;
}

export function shouldPromptReceiveCompletion(detail, context = {}) {
  const recordingDialogOpen = document.getElementById('recordingSaveDialog')?.hidden === false;
  const values = {
    micActive: state.micActive,
    micStarting: state.micStarting,
    micStopPending: !!state.micStopPromise,
    realtimeActive: !!state.realtimeDecode,
    dialogOpen: document.getElementById('receiveCompleteDialog')?.hidden === false || recordingDialogOpen,
    ...context,
  };
  return detail?.complete === true && detail?.reason === 'nominal-tail' &&
    values.micActive === true && values.micStarting !== true &&
    values.micStopPending !== true && values.realtimeActive !== true &&
    values.dialogOpen !== true;
}

export function scheduleReceiveCompletionPrompt(detail, delayMs = RECEIVE_COMPLETE_PROMPT_DELAY_MS) {
  if (!shouldPromptReceiveCompletion(detail)) return false;
  const key = receiveCompletionKey(detail);
  if (state.receiveCompleteCandidateKey === key || state.receiveCompleteLastPromptedKey === key) return false;

  if (state.receiveCompleteTimer != null) clearTimeout(state.receiveCompleteTimer);
  state.receiveCompleteCandidateKey = key;
  state.receiveCompleteTimer = setTimeout(() => {
    state.receiveCompleteTimer = null;
    if (state.receiveCompleteCandidateKey !== key || !shouldPromptReceiveCompletion(detail)) return;
    state.receiveCompleteCandidateKey = null;
    state.receiveCompleteLastPromptedKey = key;
    openReceiveCompletionDialog(detail);
  }, Math.max(0, Number(delayMs) || 0));
  return true;
}

export function cancelReceiveCompletionPrompt({ closeDialog = true, restoreFocus = true } = {}) {
  if (state.receiveCompleteTimer != null) clearTimeout(state.receiveCompleteTimer);
  state.receiveCompleteTimer = null;
  state.receiveCompleteCandidateKey = null;
  if (closeDialog) closeReceiveCompletionDialog(restoreFocus);
}

function setupReceiveCompletionDialog() {
  const dialog = document.getElementById('receiveCompleteDialog');
  const continueButton = document.getElementById('receiveCompleteContinue');
  const stopButton = document.getElementById('receiveCompleteStop');
  if (!dialog || !continueButton || !stopButton) return;

  continueButton.addEventListener('click', () => {
    closeReceiveCompletionDialog();
    try { state.webDecoder?.rearmReceiver?.(); } catch (error) { console.warn('Receiver rearm:', error); }
  });
  stopButton.addEventListener('click', () => {
    if (state.receiveCompleteDecisionInFlight || !state.micActive) return;
    state.receiveCompleteDecisionInFlight = true;
    closeReceiveCompletionDialog(false, { fallbackFocus: true });
    void stopMicrophoneReceiver().finally(() => {
      state.receiveCompleteDecisionInFlight = false;
    });
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) continueButton.click();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      continueButton.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = [continueButton, stopButton];
    const index = buttons.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      stopButton.focus();
    } else if (!event.shiftKey && index === buttons.length - 1) {
      event.preventDefault();
      continueButton.focus();
    }
  });
}

export function openReceiveCompletionDialog(detail = {}) {
  const dialog = document.getElementById('receiveCompleteDialog');
  const recordingDialog = document.getElementById('recordingSaveDialog');
  if (!dialog || !dialog.hidden || recordingDialog?.hidden === false) return false;

  // A navigation drawer or settings sheet may already own the page's inert
  // state. Close those layers before making this dialog modal, otherwise the
  // prompt itself can remain inert and become impossible to operate.
  const navToggle = document.getElementById('navToggle');
  if (navToggle?.getAttribute('aria-expanded') === 'true') navToggle.click();
  const settingsToggle = document.querySelector('.rx-settings-fab[aria-expanded="true"]');
  if (settingsToggle) settingsToggle.click();
  dialog.removeAttribute('inert');

  state.receiveCompleteDialogReturnFocus = document.activeElement;
  state.receiveCompleteDialogInertElements = [...document.body.children].filter(element =>
    element !== dialog && !element.hasAttribute('inert')
  );
  for (const element of state.receiveCompleteDialogInertElements) element.setAttribute('inert', '');
  const modeName = typeof detail.mode === 'string' ? detail.mode : detail.mode?.name;
  document.getElementById('receiveCompleteMode').textContent = modeName || 'AUTO DETECTED';
  dialog.hidden = false;
  dialog.setAttribute('aria-hidden', 'false');
  syncModalBodyState();
  const continueButton = document.getElementById('receiveCompleteContinue');
  try { continueButton?.focus({ preventScroll: true }); } catch (_) { continueButton?.focus(); }
  return true;
}

export function closeReceiveCompletionDialog(restoreFocus = true, { fallbackFocus = false } = {}) {
  const dialog = document.getElementById('receiveCompleteDialog');
  if (!dialog || dialog.hidden) return false;
  dialog.hidden = true;
  dialog.setAttribute('aria-hidden', 'true');
  for (const element of state.receiveCompleteDialogInertElements) element.removeAttribute('inert');
  state.receiveCompleteDialogInertElements = [];
  syncModalBodyState();
  if (restoreFocus) {
    const target = state.receiveCompleteDialogReturnFocus?.isConnected
      ? state.receiveCompleteDialogReturnFocus
      : document.getElementById('micReceiveBtn');
    target?.focus?.();
  }
  if (!restoreFocus && fallbackFocus) document.getElementById('micReceiveBtn')?.focus?.();
  state.receiveCompleteDialogReturnFocus = null;
  return true;
}

function setupRecordingSaveDialog() {
  const dialog = document.getElementById('recordingSaveDialog');
  const yes = document.getElementById('recordingSaveYes');
  const no = document.getElementById('recordingSaveNo');
  if (!dialog || !yes || !no) return;
  yes.addEventListener('click', () => {
    if (state.microphoneRecording) downloadMicrophoneRecording(state.microphoneRecording);
    state.microphoneRecording = null;
    closeRecordingSaveDialog();
    updateResultActionButtons();
    ui.toast('接收录音已保存', 'success');
  });
  no.addEventListener('click', () => {
    closeRecordingSaveDialog();
    updateResultActionButtons();
    ui.toast('录音已暂存，可稍后下载', 'success');
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) no.click();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      no.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = [no, yes];
    const index = buttons.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      yes.focus();
    } else if (!event.shiftKey && index === buttons.length - 1) {
      event.preventDefault();
      no.focus();
    }
  });
}

function openRecordingSaveDialog(recording) {
  const dialog = document.getElementById('recordingSaveDialog');
  if (!dialog || !dialog.hidden) return;
  const openedFromCompletionPrompt = state.receiveCompleteDecisionInFlight;
  closeReceiveCompletionDialog(false);
  const activeElement = document.activeElement;
  const completionAction = activeElement?.closest?.('#receiveCompleteDialog');
  state.recordingDialogReturnFocus = !openedFromCompletionPrompt && !completionAction && activeElement?.isConnected &&
      !activeElement.hidden && !activeElement.closest?.('[hidden], [inert]')
    ? activeElement
    : document.getElementById('micReceiveBtn');
  state.recordingDialogInertElements = [...document.body.children].filter(element =>
    element !== dialog && !element.hasAttribute('inert')
  );
  for (const element of state.recordingDialogInertElements) element.setAttribute('inert', '');
  const duration = recording.samples.length / recording.sampleRate;
  document.getElementById('recordingSaveDuration').textContent = `${duration.toFixed(1)} 秒`;
  const description = document.getElementById('recordingSaveDescription');
  description.textContent = recording.limitReached
    ? `录音已达到 ${Math.round(duration / 60)} 分钟安全上限并自动停止；仅保留前 ${Math.round(duration / 60)} 分钟，可立即导出为 WAV 文件。`
    : '接收期间的原始单声道音频已暂存，可以立即导出为 WAV 文件。';
  dialog.hidden = false;
  dialog.setAttribute('aria-hidden', 'false');
  syncModalBodyState();
  requestAnimationFrame(() => document.getElementById('recordingSaveYes')?.focus());
}

function closeRecordingSaveDialog(restoreFocus = true) {
  const dialog = document.getElementById('recordingSaveDialog');
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  dialog.setAttribute('aria-hidden', 'true');
  for (const element of state.recordingDialogInertElements) element.removeAttribute('inert');
  state.recordingDialogInertElements = [];
  syncModalBodyState();
  if (restoreFocus) {
    const target = state.recordingDialogReturnFocus?.isConnected &&
        !state.recordingDialogReturnFocus.closest?.('[hidden], [inert]')
      ? state.recordingDialogReturnFocus
      : document.getElementById('micReceiveBtn');
    target?.focus?.();
  }
  state.recordingDialogReturnFocus = null;
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
      const firstControl = panel.querySelector('.custom-select-trigger:not(:disabled)') || getFocusable()[0] || panel;
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
  const select = document.getElementById('modeSelect');
  select.title = auto
    ? '编码模式；接收将自动识别 VIS、FSK 或同步脉冲'
    : '编码与手动接收模式';
  select._enhancedControl?.setDisabled(auto);
  const trigger = select._enhancedControl?.trigger;
  if (trigger) trigger.title = auto ? '自动接收已启用；关闭 AUTO 后可指定模式' : '选择手动接收模式';
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
  const fast = document.getElementById('fastDecodeMode').checked;
  document.getElementById('offlineDecodeBtn').disabled = state.micActive || state.micStarting || !!state.micStopPromise
    || !valid || !state.uploadedAudio || (!fast && !state.webDecoder);
}

async function saveDecodedImage() {
  const frame = activeDecodedFrame();
  if (!frame) return;
  const format = document.getElementById('imageFormat').value;
  try {
    const blob = await canvasBlob(document.getElementById('resultCanvas'), format);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const page = String(state.activeDecodedFrameIndex + 1).padStart(3, '0');
    const timeRange = Number.isFinite(frame.startSec) && Number.isFinite(frame.endSec)
      ? `_${audioTimeFilenameToken(frame.startSec)}-${audioTimeFilenameToken(frame.endSec)}`
      : `_${Date.now()}`;
    link.download = `sstv_${frame.result.mode.name.replace(/\s+/g, '_')}_${page}${timeRange}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.toast(`图片已保存为 ${format.toUpperCase()}`, 'success');
  } catch (error) {
    ui.toast(`图片保存失败: ${error.message}`, 'error');
  }
}

export function audioTimeFilenameToken(seconds) {
  const tenths = Math.max(0, Math.round((Number(seconds) || 0) * 10));
  return (tenths / 10).toFixed(1);
}

// ---- 音频上传(WAV / MP3 等)----
async function onAudioFile(file) {
  const loadId = ++state.audioLoadId;
  if (state.realtimeDecode) stopRealtimeDecode(false);
  resetDecodedResult();
  state.audioPlayer?.clear();
  state.uploadedAudio = null;
  document.getElementById('offlineDecodeBtn').disabled = true;
  for (const id of ['decodeStartSec', 'decodeEndSec']) document.getElementById(id).disabled = true;
  document.getElementById('audioMeta').textContent = 'LOADING AUDIO...';
  document.getElementById('audioMeta').classList.remove('is-error');
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

    updateOfflineDecodeMode();
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
    document.getElementById('audioMeta').classList.remove('is-error');
    ui.toast(`${file.name || '音频'} 已加载(${format}, ${sampleRate}Hz, ${dur}s)`, 'success');
  } catch (e) {
    if (loadId !== state.audioLoadId) return;
    console.error(e);
    document.getElementById('audioMeta').textContent = `AUDIO LOAD FAILED · ${e.message}`;
    document.getElementById('audioMeta').classList.add('is-error');
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

export function getFieldReceiverState() {
  return { micActive: state.micActive, micStarting: state.micStarting,
    fileActive: state.offlineDecodeActive || !!state.realtimeDecode,
    busy: state.micActive || state.micStarting || !!state.micStopPromise || state.isProcessing || state.offlineDecodeActive || !!state.realtimeDecode || !document.getElementById('audioPlayer').paused };
}

fieldPwa = initPwa({ isBusy: () => getFieldReceiverState().busy,
  isReceiving: () => state.micActive || state.micStarting || !!state.realtimeDecode });
const fieldTracking = initTracking({ receiver: getFieldReceiverState, onActivity: active => fieldPwa.setTrackingActive(active) });
export function destroyFieldApp() { fieldTracking?.destroy(); fieldPwa?.destroy(); }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.micStarting) backgroundDuringMicStart = true;
    if (state.micActive) void stopMicrophoneReceiver({ background: true });
  } else if (deferredRecordingDialog && state.microphoneRecording) {
    deferredRecordingDialog = false;
    openRecordingSaveDialog(state.microphoneRecording);
  }
});
