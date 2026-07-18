// audiodecode.js — 统一音频文件解码(WAV / MP3 / 任意浏览器支持格式)
//
// 策略:
//   WAV  → 走纯 JS wav.js(无 AudioContext 也能解码,且离线/Node 友好)
//   其他 → 走 Web Audio API 的 AudioContext.decodeAudioData(浏览器原生 MP3 等)
// 两者最终都输出 { sampleRate, samples: Float32Array(单声道) },sampleRate 为原始值,
// 由 decoder 端的 resample 统一到 44100Hz。

import { decodeWAV } from './wav.js';
import { DEFAULT_SAMPLE_RATE } from './modes.js';

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
export async function decodeAudioFile(fileOrBuf) {
  const buf = fileOrBuf instanceof ArrayBuffer ? fileOrBuf : await fileOrBuf.arrayBuffer();

  // 先尝试 WAV(纯 JS,最快且无副作用)
  // 通过 RIFF 头判定
  const isWav = buf.byteLength > 12 &&
    String.fromCharCode(...new Uint8Array(buf).slice(0, 4)) === 'RIFF';
  if (isWav) {
    try {
      const r = decodeWAV(buf);
      return { sampleRate: r.sampleRate, samples: r.samples, format: 'WAV' };
    } catch (e) {
      // WAV 解析失败则回退 Web Audio
    }
  }

  // MP3 / 其他 → Web Audio
  if (!hasWebAudio()) {
    throw new Error('当前环境不支持 MP3 解码(需要浏览器 Web Audio API)。WAV 仍可用。');
  }
  const ctx = audioContext();
  // 某些浏览器需 resume
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }

  const audioBuf = await ctx.decodeAudioData(buf.slice(0));  // slice 防止 ArrayBuffer 被分离
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
