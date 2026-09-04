// audiodecode.js — 统一音频文件解码(WAV / MP3 / 任意浏览器支持格式)
//
// 策略:
//   WAV  → 走纯 JS wav.js(无 AudioContext 也能解码,且离线/Node 友好)
//   其他 → 走 Web Audio API 的 AudioContext.decodeAudioData(浏览器原生 MP3 等)
// 两者最终都输出 { sampleRate, samples: Float32Array(单声道) },sampleRate 为原始值,
// 由 decoder 端的 resample 统一到 44100Hz。

import { decodeWAV } from './wav.js';

export const AUDIO_FILE_LIMITS = Object.freeze({
  maxFileBytes: 128 * 1024 * 1024,
  minSampleRate: 8000,
  maxSampleRate: 192000,
  maxChannels: 8,
  maxDurationSeconds: 30 * 60,
  maxSamples: 50 * 1024 * 1024,
});

function assertFileWithinLimits(fileOrBuf, limits) {
  const byteLength = fileOrBuf instanceof ArrayBuffer
    ? fileOrBuf.byteLength
    : Number(fileOrBuf?.size);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('无法确定音频文件大小');
  }
  if (byteLength > limits.maxFileBytes) {
    throw new Error(`音频文件过大，最大支持 ${Math.floor(limits.maxFileBytes / 1024 / 1024)} MB`);
  }
}

function assertDecodedAudioWithinLimits({ sampleRate, sampleCount, channelCount }, limits) {
  if (!Number.isFinite(sampleRate) || sampleRate < limits.minSampleRate || sampleRate > limits.maxSampleRate) {
    throw new Error(`音频采样率超出支持范围 (${limits.minSampleRate}-${limits.maxSampleRate} Hz)`);
  }
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > limits.maxChannels) {
    throw new Error(`音频声道数超出支持范围 (最大 ${limits.maxChannels})`);
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > limits.maxSamples) {
    throw new Error('音频样本数超出安全上限');
  }
  const duration = sampleCount / sampleRate;
  if (!Number.isFinite(duration) || duration > limits.maxDurationSeconds) {
    throw new Error(`音频时长超出支持范围 (最大 ${limits.maxDurationSeconds / 60} 分钟)`);
  }
}

function isWavHeader(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 12) return false;
  const bytes = new Uint8Array(buf, 0, 12);
  return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
}

function isBrowserBlob(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob &&
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' &&
    typeof Audio !== 'undefined';
}

async function assertCompressedMediaMetadataWithinLimits(file, limits) {
  if (!isBrowserBlob(file)) return;
  const media = new Audio();
  const objectUrl = URL.createObjectURL(file);
  let timeoutId = null;
  try {
    const duration = await new Promise((resolve, reject) => {
      const settle = callback => value => {
        media.onloadedmetadata = null;
        media.onerror = null;
        callback(value);
      };
      media.preload = 'metadata';
      media.onloadedmetadata = settle(() => resolve(media.duration));
      media.onerror = settle(() => reject(new Error('无法读取音频元数据或格式不受支持')));
      timeoutId = setTimeout(
        settle(() => reject(new Error('读取音频元数据超时'))),
        10000
      );
      media.src = objectUrl;
      media.load();
    });
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('音频时长无效');
    }
    if (duration > limits.maxDurationSeconds) {
      throw new Error(`音频时长超出支持范围 (最大 ${limits.maxDurationSeconds / 60} 分钟)`);
    }
  } finally {
    clearTimeout(timeoutId);
    media.onloadedmetadata = null;
    media.onerror = null;
    try {
      media.removeAttribute('src');
      media.load();
    } catch (_) {}
    URL.revokeObjectURL(objectUrl);
  }
}

// 是否有 Web Audio(浏览器环境)
function hasWebAudio() {
  return typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
}

let _ctx = null;
function audioContext() {
  if (_ctx) return _ctx;
  const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
  _ctx = new Ctor();
  return _ctx;
}

/**
 * 解码任意音频文件 → 单声道 Float32Array。
 * @param {File|ArrayBuffer} fileOrBuf  File 或已读 ArrayBuffer
 * @returns {Promise<{sampleRate:number, samples:Float32Array, format:string}>}
 */
export async function decodeAudioFile(fileOrBuf, limits = AUDIO_FILE_LIMITS) {
  limits = { ...AUDIO_FILE_LIMITS, ...limits };
  assertFileWithinLimits(fileOrBuf, limits);
  let metadataChecked = false;
  if (isBrowserBlob(fileOrBuf)) {
    const header = await fileOrBuf.slice(0, 12).arrayBuffer();
    if (!isWavHeader(header)) {
      await assertCompressedMediaMetadataWithinLimits(fileOrBuf, limits);
      metadataChecked = true;
    }
  }
  const buf = fileOrBuf instanceof ArrayBuffer ? fileOrBuf : await fileOrBuf.arrayBuffer();
  if (!(buf instanceof ArrayBuffer) || buf.byteLength > limits.maxFileBytes) {
    throw new Error('读取后的音频文件超出安全上限');
  }

  // 先尝试 WAV(纯 JS,最快且无副作用)
  // 通过 RIFF 头判定
  const isWav = isWavHeader(buf);
  let wavError = null;
  if (isWav) {
    try {
      const r = decodeWAV(buf, {
        minSampleRate: limits.minSampleRate,
        maxSampleRate: limits.maxSampleRate,
        maxChannels: limits.maxChannels,
        maxFrames: limits.maxSamples,
        maxDurationSeconds: limits.maxDurationSeconds,
      });
      assertDecodedAudioWithinLimits({
        sampleRate: r.sampleRate,
        sampleCount: r.samples.length,
        channelCount: r.channelCount,
      }, limits);
      return { sampleRate: r.sampleRate, samples: r.samples, format: 'WAV' };
    } catch (e) {
      // WAV 解析失败则回退 Web Audio
      wavError = e;
    }
  }

  // MP3 / 其他 → Web Audio
  if (!metadataChecked && isBrowserBlob(fileOrBuf)) {
    await assertCompressedMediaMetadataWithinLimits(fileOrBuf, limits);
  }
  if (!hasWebAudio()) {
    if (wavError) throw new Error(`WAV 解析失败: ${wavError.message}`);
    throw new Error('当前环境不支持 MP3 解码(需要浏览器 Web Audio API)。WAV 仍可用。');
  }
  const ctx = audioContext();
  // 某些浏览器需 resume
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }

  const audioBuf = await ctx.decodeAudioData(buf.slice(0));  // slice 防止 ArrayBuffer 被分离
  assertDecodedAudioWithinLimits({
    sampleRate: audioBuf.sampleRate,
    sampleCount: audioBuf.length,
    channelCount: audioBuf.numberOfChannels,
  }, limits);
  const samples = toMono(audioBuf);
  return { sampleRate: audioBuf.sampleRate, samples, format: 'Web Audio' };
}

// AudioBuffer → 单声道 Float32Array(多声道取平均)
function toMono(audioBuf) {
  const ch = audioBuf.numberOfChannels;
  const len = audioBuf.length;
  if (ch === 1) {
    // 复制一份,避免引用 AudioBuffer 内部缓冲
    const out = new Float32Array(len);
    out.set(audioBuf.getChannelData(0));
    return out;
  }
  const out = new Float32Array(len);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(audioBuf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += chans[c][i];
    out[i] = s / ch;
  }
  return out;
}

/**
 * 按起始时间(秒)截取 PCM。返回新 Float32Array。
 * startSec 为 0 或负则原样返回。
 */
export function sliceFromStart(samples, sampleRate, startSec) {
  if (!startSec || startSec <= 0) return samples;
  const offset = Math.floor(startSec * sampleRate);
  if (offset >= samples.length) {
    throw new Error(`起始时间 ${startSec}s 超出音频时长 ${(samples.length / sampleRate).toFixed(1)}s`);
  }
  return samples.subarray(offset);
}
