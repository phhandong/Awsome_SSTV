// demod.js — FM 解调 + 重采样 + 同步搜索 + AutoSlant
//
// 解调方法:解析信号瞬时频率法。
//   解析信号 s~ = filt + j·H(filt)(Hilbert 变换)
//   瞬时频率 = sr/(2π) · unwrap(angle(s~[i] · conj(s~[i-1])))
// 每样本一个频率值,时间分辨率最高,适合 SSTV 短同步脉冲(4.862ms)与 VIS 位(30ms)。

import { FREQ, DEFAULT_SAMPLE_RATE } from './modes.js';

// 线性重采样到目标采样率
export function resample(samples, fromSr, toSr = DEFAULT_SAMPLE_RATE) {
  if (fromSr === toSr) return samples;
  const ratio = toSr / fromSr;
  const outLen = Math.floor(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcPos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

// 带通 FIR(窗口 sinc),保留 [1000, 2400] Hz,抑制直流与带外噪声
function makeBandpass(sr) {
  const lo = 1000, hi = 2400, N = 31;  // 短 tap 降低群延迟
  const h = new Float32Array(N);
  const mid = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    const n = i - mid;
    const win = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1));  // Hamming
    const sinc = (f, n) => n === 0 ? 2 * f / sr : Math.sin(2 * Math.PI * f * n / sr) / (Math.PI * n) * 2 * f / sr;
    h[i] = (sinc(hi, n) - sinc(lo, n)) * win;
  }
  return h;
}

// Hilbert 变换 FIR(近似解析信号的虚部)
function makeHilbert(N = 33) {
  const h = new Float32Array(N);
  const mid = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    if (i === mid) { h[i] = 0; continue; }
    const n = i - mid;
    const win = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1));
    // h[n] = (1 - cos(πn)) / (πn)
    h[i] = (1 - Math.cos(Math.PI * n)) / (Math.PI * n) * win;
  }
  return h;
}

function convolve(samples, h) {
  const out = new Float32Array(samples.length);
  const half = (h.length - 1) / 2;
  for (let i = 0; i < samples.length; i++) {
    let acc = 0;
    for (let k = 0; k < h.length; k++) {
      const idx = i + k - half;
      if (idx >= 0 && idx < samples.length) acc += samples[idx] * h[k];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * FM 解调:返回与样本等长的瞬时频率数组 freq[](Hz)。
 *
 * 方法:过零测频,对应 MMSSTV CPLL 的周期鉴相思路:
 *   - 对正过零点做线性插值,相邻过零点间隔直接换算为 Hz
 *   - 周期测量值放在周期中点,再插值为逐样本频率
 *   - 钳位 [1000, 2400] Hz(SSTV 视频带)
 *   - 最后用极短的对称窗口平滑量化噪声
 *
 * 原 DLL 必须实时工作,所以滤波是因果的;网页解码面对完整文件,可把周期估计放回其
 * 时间中心并做零相位平滑。这仍使用相同的过零鉴相量,但不会把短 Martin 2 像素拖后
 * 数个载波周期。返回 Hz 值供后续 VIS/SYNC/像素使用。
 */
export function demodulate(samples, sr = DEFAULT_SAMPLE_RATE) {
  // 1. 带通滤波(去带外噪声,保留 1000-2400Hz)
  const filt = convolve(samples, makeBandpass(sr));

  const n = filt.length;
  const freq = new Float32Array(n);
  const F_LO = 1000, F_HI = 2400;  // 钳位范围(SSTV 视频带)

  // 每个测量点代表一个完整载波周期,时间戳取周期中点。若把测量值从后一个
  // 过零点起保持,会产生 0.4~1ms 固有滞后,对 Martin 2 的短像素尤其明显。
  const centers = [];
  const values = [];
  let prevSample = filt[0] || 0;
  let prevCross = -1;
  for (let i = 1; i < n; i++) {
    const s = filt[i];
    if (prevSample <= 0 && s > 0) {
      const denom = s - prevSample;
      const cross = (i - 1) + (denom === 0 ? 0 : -prevSample / denom);
      if (prevCross >= 0) {
        const period = cross - prevCross;
        if (period > 0) {
          let f = sr / period;
          if (f > F_HI) f = F_HI;
          else if (f < F_LO) f = F_LO;
          centers.push((prevCross + cross) * 0.5);
          values.push(f);
        }
      }
      prevCross = cross;
    }
    prevSample = s;
  }

  if (centers.length === 0) {
    freq.fill(1500);
    return freq;
  }

  // 周期中点之间线性插值;两端保持最近的有效估计。
  const first = Math.max(0, Math.ceil(centers[0]));
  freq.fill(values[0], 0, first);
  let lastWritten = first;
  for (let k = 1; k < centers.length; k++) {
    const x0 = centers[k - 1], x1 = centers[k];
    const f0 = values[k - 1], f1 = values[k];
    const start = Math.max(lastWritten, Math.ceil(x0));
    const end = Math.min(n, Math.ceil(x1));
    const span = x1 - x0;
    for (let i = start; i < end; i++) {
      const t = span > 0 ? (i - x0) / span : 0;
      freq[i] = f0 + (f1 - f0) * t;
    }
    lastWritten = end;
  }
  freq.fill(values[values.length - 1], lastWritten);

  // fqcSmooth 对应的轻平滑。对称窗口没有群延迟,不会改变行/像素相位。
  const smoothLen = Math.max(1, Math.floor(0.0003 * sr));
  return movingAverage(freq, smoothLen);
}

function movingAverage(arr, len) {
  const out = new Float32Array(arr.length);
  const half = (len - 1) / 2 | 0;
  let sum = 0;
  // 简化:逐点窗口平均(数据量不大)
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let k = -half; k <= half; k++) {
      const idx = i + k;
      if (idx >= 0 && idx < arr.length) { s += arr[idx]; c++; }
    }
    out[i] = s / c;
  }
  return out;
}

/**
 * 同步脉冲搜索:在 freq[] 中找所有 ~1200Hz 同步脉冲起点。
 * 返回脉冲起点样本数组。
 *
 * 抗抖动策略(针对 MP3/有损信号):不用"单样本连续在容差"判定
 * (MP3 解调的瞬时频率在 SYNC 段单样本抖动可达 ±400Hz),改用
 * "滑动窗口内落在 1200Hz 容差的样本占比 ≥ 阈值"定位 SYNC 区段。
 */
export function findSyncPulses(freq, sr, minSyncMs = 4.0, ratioThresh = 0.25) {
  const minLen = Math.floor(minSyncMs * sr / 1000);
  const lo = 1140, hi = 1260;
  const winMs = 5;  // 占比判定窗口(大于 SYNC 抖动相关时间)
  const win = Math.max(1, Math.floor(winMs * sr / 1000));
  // ratioThresh:窗口内落在 1200Hz 容差的样本占比阈值。
  //   0.25(默认):干净/闭环信号,避免假阳性。
  //   0.12:MP3 相噪下用(decoder 在脉冲数不足时以低阈值重检)。

  // 1. 计算每个样本点为中心的窗口内"在容差"的占比
  const isSync = new Uint8Array(freq.length);
  for (let i = 0; i < freq.length; i++) {
    let cnt = 0;
    for (let k = 0; k < win; k++) {
      const j = i + k - (win >> 1);
      if (j >= 0 && j < freq.length && freq[j] >= lo && freq[j] <= hi) cnt++;
    }
    if (cnt / win >= ratioThresh) isSync[i] = 1;
  }

  // 2. 提取 SYNC 区段,合并间距 < mergeMs 的小空洞(占比法会产生碎片),长度 ≥ minLen 记为脉冲
  const mergeMs = 4;
  const mergeGap = Math.floor(mergeMs * sr / 1000);
  const pulses = [];
  let i = 0;
  let segStart = -1, segEnd = -1;
  while (i < isSync.length) {
    if (isSync[i]) {
      if (segStart < 0) segStart = i;
      segEnd = i + 1;
      i++;
    } else {
      // 看是否在合并窗口内重新出现 SYNC
      let k = i;
      while (k < isSync.length && !isSync[k] && k - i < mergeGap) k++;
      if (k < isSync.length && isSync[k] && k - i < mergeGap) {
        i = k;  // 合并:跨过空洞继续
      } else {
        if (segStart >= 0 && segEnd - segStart >= minLen) pulses.push(segStart);
        segStart = -1;
        i = k;
      }
    }
  }
  if (segStart >= 0 && segEnd - segStart >= minLen) pulses.push(segStart);
  return pulses;
}

/**
 * AutoSlant:用相邻同步脉冲间距的中位数估计实际行周期,校正采样率漂移。
 */
export function autoSlant(syncPulses, mode, sr) {
  if (syncPulses.length < 2) return { lineStarts: syncPulses, slope: 1.0, idealLineSamples: 0 };
  const idealLineSamples = mode.lineDurationMs * sr / 1000;
  const gaps = [];
  for (let i = 1; i < syncPulses.length; i++) gaps.push(syncPulses[i] - syncPulses[i - 1]);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  const slope = medianGap / idealLineSamples;
  return { lineStarts: syncPulses, slope, idealLineSamples };
}
