// find_signal.js — 在 MP3 解码后的 PCM 中定位真正的 SSTV VIS leader
import { readFileSync } from 'fs';
import { MPEGDecoder } from 'mpg123-decoder';
import { resample, demodulate } from './js/demod.js';
import { DEFAULT_SAMPLE_RATE } from './js/modes.js';

const mp3Buf = readFileSync('./asset/ROBOT36_test.mp3');
const dec = new MPEGDecoder();
await dec.ready;
const { channelData, sampleRate } = dec.decode(mp3Buf);
try { dec.free && dec.free(); } catch (_) {}
const len = channelData[0].length;
const mono = new Float32Array(len);
for (let i = 0; i < len; i++) { let s = 0; for (let c = 0; c < channelData.length; c++) s += channelData[c][i]; mono[i] = s / channelData.length; }
const pcm = resample(mono, sampleRate, DEFAULT_SAMPLE_RATE);
const sr = DEFAULT_SAMPLE_RATE;

// 1. RMS 能量分布(每 200ms 一段),找信号起始
console.log('=== RMS 能量分布(每 200ms)===');
for (let ms = 0; ms < pcm.length / sr * 1000; ms += 200) {
  const s = Math.floor(ms * sr / 1000), e = s + Math.floor(0.2 * sr);
  let sum = 0; for (let i = s; i < e && i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / (e - s));
  const bar = '#'.repeat(Math.min(40, Math.round(rms * 200)));
  console.log(`${ms.toString().padStart(6)}ms rms=${rms.toFixed(3)} ${bar}`);
}

// 2. 解调,找持续 1900Hz 的 leader(连续 >= 150ms 在 1800-2000Hz)
console.log('\n=== FM 解调后,扫描持续 1900Hz leader ===');
const freq = demodulate(pcm, sr);
const winMs = 10, winS = Math.floor(winMs * sr / 1000);
let bestStart = -1, bestLen = 0;
let curStart = -1, curLen = 0;
for (let ms = 0; ms < freq.length / sr * 1000 - winMs; ms += 5) {
  const idx = Math.floor(ms * sr / 1000);
  // 窗口内频率均值
  let sum = 0; for (let i = 0; i < winS; i++) sum += freq[idx + i];
  const f = sum / winS;
  if (f >= 1800 && f <= 2000) {
    if (curStart < 0) curStart = ms;
    curLen += 5;
  } else {
    if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    curStart = -1; curLen = 0;
  }
}
if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
console.log('最长持续 1900Hz 区段:起始', bestStart, 'ms, 持续', bestLen, 'ms',
  bestLen >= 150 ? '(可作 VIS leader)' : '(太短)');

// 3. 在该 leader 前后看频率序列,验证 VIS 结构
if (bestStart >= 0) {
  console.log('\n=== leader 起始', bestStart, 'ms 前后频率序列(每 30ms)===');
  for (let ms = bestStart - 60; ms < bestStart + 700; ms += 30) {
    if (ms < 0) continue;
    const idx = Math.floor(ms * sr / 1000);
    console.log(`  ${ms}ms: ${freq[idx].toFixed(0)}Hz`);
  }
}
