// SPDX-License-Identifier: LGPL-3.0-or-later
// demod.js — FM 解调 + 重采样 + 同步搜索 + AutoSlant
//
// 解调方法:解析信号瞬时频率法。
//   解析信号 s~ = filt + j·H(filt)(Hilbert 变换)
//   瞬时频率 = sr/(2π) · unwrap(angle(s~[i] · conj(s~[i-1])))
// 每样本一个频率值,时间分辨率最高,适合 SSTV 短同步脉冲(4.862ms)与 VIS 位(30ms)。

import { FREQ, DEFAULT_SAMPLE_RATE } from './modes.js';
import { MMSSTVCPLL, MMSSTVCLMS, StreamingFIR, makeMmsstvBandpass } from './mmsstv-dsp.js';

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
export function makeBandpass(sr) {
  // 31 taps was appropriate around the DLL's 11.025 kHz working rate.  At
  // the browser pipeline's fixed 44.1 kHz it has only one quarter of that
  // time aperture, so scale it to preserve the same filter duration.
  const lo = 1000, hi = 2400;
  const N = Math.max(31, (Math.round(31 * sr / 11025) | 1));
  const h = new Float32Array(N);
  const mid = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    const n = i - mid;
    const win = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1));  // Hamming
    // Ideal low-pass impulse response.  The non-zero branch must not be
    // multiplied by 2f/sr again: sin(2*pi*f*n/sr)/(pi*n) already contains
    // the cutoff-frequency scale.  Doing so turns the intended band-pass
    // into an almost-flat, DC-passing filter.
    const sinc = (f, n) => n === 0
      ? 2 * f / sr
      : Math.sin(2 * Math.PI * f * n / sr) / (Math.PI * n);
    h[i] = (sinc(hi, n) - sinc(lo, n)) * win;
  }
  return h;
}

/**
 * CLMS/NLMS adaptive line enhancer. A delayed input is used as the adaptive
 * reference: periodic SSTV carriers remain predictable while broadband noise
 * becomes prediction error. The dry/wet blend protects tone transitions.
 */
export function lmsAdaptiveLineEnhance(samples, sr = DEFAULT_SAMPLE_RATE, options = {}) {
  const defaultTaps = Math.max(16, Math.round(16 * sr / 11025));
  const defaultDelay = Math.max(2, Math.round(2 * sr / 11025));
  const taps = Math.max(1, Math.min(256, Math.round(options.taps ?? defaultTaps)));
  const delay = Math.max(1, Math.min(256, Math.round(options.delay ?? defaultDelay)));
  const mu = Math.max(0, Math.min(1, options.mu ?? 0.04));
  const leak = Math.max(0.9, Math.min(1, options.leak ?? 0.999999));
  const strength = Math.max(0, Math.min(1, options.strength ?? 0.75));

  const weights = new Float64Array(taps);
  const out = new Float32Array(samples.length);
  const warmup = delay + taps * 2;

  for (let i = 0; i < samples.length; i++) {
    const desired = samples[i];
    let predicted = 0;
    let power = 1e-8;
    for (let k = 0; k < taps; k++) {
      const j = i - delay - k;
      const reference = j >= 0 ? samples[j] : 0;
      predicted += weights[k] * reference;
      power += reference * reference;
    }
    const error = desired - predicted;
    const step = mu * error / power;
    for (let k = 0; k < taps; k++) {
      const j = i - delay - k;
      const reference = j >= 0 ? samples[j] : 0;
      weights[k] = leak * weights[k] + step * reference;
    }
    out[i] = i < warmup ? desired : desired - strength * error;
  }
  return out;
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
 *   - 对正、负过零点都做线性插值,分别用相邻同极性过零点换算为 Hz
 *   - 每个完整周期测量值放在区间中点,再插值为逐样本频率
 *   - 钳位 [1000, 2400] Hz(SSTV 视频带)
 *   - 最后用极短的对称窗口平滑量化噪声
 *
 * 原 DLL 必须实时工作,所以滤波是因果的;网页解码面对完整文件,可把周期估计放回其
 * 时间中心并做零相位平滑。这仍使用相同的过零鉴相量,但不会把短 Martin 2 像素拖后
 * 数个载波周期。返回 Hz 值供后续 VIS/SYNC/像素使用。
 */
export function demodulate(samples, sr = DEFAULT_SAMPLE_RATE, options = {}) {
  if (options.engine === 'mmsstv') return demodulateMmsstv(samples, sr, options);
  // 1. 可选带通与自适应线增强。BPF 默认开启以保持原行为；LMS 默认关闭。
  let filt = options.bpf === false ? samples : convolve(samples, makeBandpass(sr));
  if (options.lms === true) filt = lmsAdaptiveLineEnhance(filt, sr, options.lmsOptions);

  const n = filt.length;
  const freq = new Float32Array(n);
  // AFC needs headroom before its offset is known; applyAFC restores the
  // protocol range after translation. Without AFC preserve the old clamp.
  const F_LO = options.afc === true ? 750 : 1000;
  const F_HI = options.afc === true ? 2650 : 2400;

  // 每个测量点代表一个完整载波周期,时间戳取周期中点。若把测量值从后一个
  // 过零点起保持,会产生 0.4~1ms 固有滞后,对 Martin 2 的短像素尤其明显。
  const centers = [];
  const values = [];
  let prevSample = filt[0] || 0;
  let prevPositiveCross = -1;
  let prevNegativeCross = -1;
  for (let i = 1; i < n; i++) {
    const s = filt[i];
    // 两个极性的过零都参与。相比只看正过零，更新率翻倍，也与 SSTVENG
    // CPLL 的双极性过零路径一致。
    const positive = prevSample <= 0 && s > 0;
    const negative = prevSample >= 0 && s < 0;
    if (positive || negative) {
      const denom = s - prevSample;
      const cross = (i - 1) + (denom === 0 ? 0 : -prevSample / denom);
      // Keep one history per polarity. Both CPLL paths therefore contribute
      // estimates, while each estimate spans a full period and is not biased
      // by asymmetric positive/negative half-cycles in compressed audio.
      const previous = positive ? prevPositiveCross : prevNegativeCross;
      if (previous >= 0) {
        const period = cross - previous;
        if (period >= 2) {
          let f = sr / period;
          if (f > F_HI) f = F_HI;
          else if (f < F_LO) f = F_LO;
          centers.push((previous + cross) * 0.5);
          values.push(f);
        }
      }
      if (positive) prevPositiveCross = cross;
      else prevNegativeCross = cross;
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

export function demodulateMmsstv(samples, sr = DEFAULT_SAMPLE_RATE, options = {}) {
  const narrow = options.narrow === true;
  let processor = null;
  if (options.bpf !== false) {
    processor = new StreamingFIR(makeMmsstvBandpass(sr, {
      quality: options.bpfQuality ?? 2,
      // MMSSTV uses HBPFS (about 400..2500 Hz) while searching so that the
      // 1100/1300-Hz VIS bits are not removed. The receiver switches to the
      // narrower image filter only after mode lock.
      low: options.bpfLow ?? (narrow ? 1600 : 400),
      high: options.bpfHigh ?? (narrow ? 2500 : 2500),
    }));
  }
  const lms = options.lms === true ? new MMSSTVCLMS(sr, options.lmsMode || 'lms') : null;
  const pll = new MMSSTVCPLL(sr, { narrow, ...(options.pllOptions || {}) });
  const out = new Float32Array(samples.length);
  const center = narrow ? (2044 + 2300) / 2 : 1900;
  const shift = narrow ? 256 : 800;
  let previous = 0;
  for (let i = 0; i < samples.length; i++) {
    let value = (samples[i] + previous) * 0.5;
    previous = samples[i];
    if (processor) value = processor.process(value);
    if (lms) value = lms.process(value);
    // CSSTVDEM feeds CPLL with AGC-normalized 16-bit soundcard units. Keeping
    // that scale is important for fast acquisition of 30-ms VIS tones.
    const control = pll.process(value * 32768) / 32768;
    out[i] = Math.max(narrow ? 1700 : 1000, Math.min(2600, center - control * shift));
  }
  return out;
}

/**
 * AFC: lock to the first stable VIS leader-like tone and use its known
 * 1900-Hz frequency to remove a constant receiver/tuning offset.
 */
export function applyAFC(freq, sr = DEFAULT_SAMPLE_RATE, options = {}) {
  const window = Math.max(1, Math.floor((options.windowMs ?? 100) * sr / 1000));
  const step = Math.max(1, Math.floor((options.stepMs ?? 10) * sr / 1000));
  const end = Math.min(freq.length, Math.floor((options.searchSeconds ?? 5) * sr));
  const maxStdDev = options.maxStdDev ?? 55;
  let offsetHz = 0;
  let found = false;

  for (let start = 0; start + window <= end; start += step) {
    let sum = 0, sumSq = 0;
    for (let i = start; i < start + window; i++) {
      const value = freq[i];
      sum += value;
      sumSq += value * value;
    }
    const mean = sum / window;
    const variance = Math.max(0, sumSq / window - mean * mean);
    if (mean >= 1650 && mean <= 2150 && Math.sqrt(variance) <= maxStdDev) {
      offsetHz = Math.max(-250, Math.min(250, mean - 1900));
      found = true;
      break;
    }
  }

  const corrected = new Float32Array(freq.length);
  const correction = found && Math.abs(offsetHz) >= 0.5 ? offsetHz : 0;
  for (let i = 0; i < freq.length; i++) {
    const value = freq[i] - correction;
    corrected[i] = value < 1000 ? 1000 : value > 2400 ? 2400 : value;
  }
  return { freq: corrected, offsetHz: found ? offsetHz : 0, locked: found };
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
export function findSyncPulses(freq, sr, minSyncMs = 4.0, ratioThresh = 0.25, targetHz = FREQ.SYNC) {
  const minLen = Math.floor(minSyncMs * sr / 1000);
  const lo = targetHz - 60, hi = targetHz + 60;
  const winMs = 5;  // 占比判定窗口(大于 SYNC 抖动相关时间)
  const win = Math.max(1, Math.floor(winMs * sr / 1000));
  // ratioThresh:窗口内落在 1200Hz 容差的样本占比阈值。
  //   0.25(默认):干净/闭环信号,避免假阳性。
  //   0.12:MP3 相噪下用(decoder 在脉冲数不足时以低阈值重检)。

  // 1. 计算每个样本点为中心的窗口内"在容差"的占比
  const isSync = new Uint8Array(freq.length);
  const half = win >> 1;
  let cnt = 0;
  for (let k = 0; k < win; k++) {
    const j = k - half;
    if (j >= 0 && j < freq.length && freq[j] >= lo && freq[j] <= hi) cnt++;
  }
  for (let i = 0; i < freq.length; i++) {
    if (i > 0) {
      const leaving = i - 1 - half;
      const entering = i + win - 1 - half;
      if (leaving >= 0 && leaving < freq.length && freq[leaving] >= lo && freq[leaving] <= hi) cnt--;
      if (entering >= 0 && entering < freq.length && freq[entering] >= lo && freq[entering] <= hi) cnt++;
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
  const idealLineSamples = mode.lineDurationMs * sr / 1000;
  if (syncPulses.length < 2) {
    return { lineStarts: syncPulses.slice(), slope: 1.0, idealLineSamples };
  }

  const pulses = syncPulses.slice().sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < pulses.length; i++) gaps.push(pulses[i] - pulses[i - 1]);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[gaps.length >> 1] || idealLineSamples;

  // Give every observation a line ordinal. Missing sync pulses therefore
  // create holes instead of shifting all following rows by one.
  const ordinals = [0];
  for (let i = 1; i < pulses.length; i++) {
    const step = Math.max(1, Math.round((pulses[i] - pulses[i - 1]) / medianGap));
    ordinals.push(ordinals[i - 1] + step);
  }

  let keep = pulses.map((_, i) => i).filter(i => ordinals[i] >= 2);
  let intercept = pulses[0];
  let lineSamples = medianGap;
  let window = Math.max(5, Math.floor(0.1 * sr));

  // Mirror CorrectSlant's robust shape: at least 16 acquired lines, at
  // least six regression points, up to five successively narrower fits.
  if (pulses.length >= 16 && keep.length >= 6) {
    for (let iteration = 0; iteration < 5 && keep.length >= 6; iteration++) {
      const fit = linearRegression(ordinals, pulses, keep);
      if (!fit) break;
      intercept = fit.intercept;
      lineSamples = fit.slope;
      const next = keep.filter(i => Math.abs(pulses[i] - (intercept + lineSamples * ordinals[i])) <= window);
      if (next.length < 6) break;
      keep = next;
      window *= 0.5;
    }
  }

  // Protect against a bad lock using the limits recovered for CorrectSlant.
  lineSamples = Math.max(idealLineSamples * 0.875, Math.min(idealLineSamples * 1.25, lineSamples));
  const firstOrdinal = ordinals[0];
  const lastOrdinal = ordinals[ordinals.length - 1];
  const lineStarts = [];
  for (let line = firstOrdinal; line <= lastOrdinal; line++) {
    lineStarts.push(Math.round(intercept + lineSamples * line));
  }
  return { lineStarts, slope: lineSamples / idealLineSamples, idealLineSamples, lineSamples };
}

function linearRegression(xs, ys, indices) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const i of indices) {
    const x = xs[i], y = ys[i];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = indices.length;
  const denom = n * sxx - sx * sx;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  return { slope, intercept };
}
