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
 * 方法:1阶 PLL(锁相环),对应 MMSSTV 逆向 DemType=0(CPLL):
 *   - 鉴相器:输入信号 × VCO 正交分量 → 相位误差
 *   - 环路滤波:1阶,FC=1500Hz(ini pllLoopFC)——跟踪速度
 *   - VCO:频率围绕中心(1800Hz,SSTV 中点)摆动
 *   - 输出滤波:1阶低通,FC=900Hz(ini pllOutFC)——平滑频率估计
 *   - fqcSmooth=2200:输出再经轻平滑
 *
 * PLL 相比"瞬时频率法+移动平均"的优势:环路滤波自适应跟踪载波,锁定后只跟随频率
 * 变化(图像内容),不引入固定线性平滑——边缘不糊,噪声被环路带宽抑制。
 */
export function demodulate(samples, sr = DEFAULT_SAMPLE_RATE) {
  // 1. 带通滤波(去带外噪声,保留 1000-2400Hz)
  const filt = convolve(samples, makeBandpass(sr));

  // 2. 1阶 PLL 跟踪瞬时频率
  // 环路参数(逆向 ini):pllLoopFC=1500, pllOutFC=900, pllVcoGain=1.0
  const centerFreq = 1800;  // SSTV 频率中点(1500 黑 ~ 2300 白 的中心)
  const loopFC = 1500;      // 环路带宽(跟踪速度)
  const outFC = 900;        // 输出低通(平滑)
  // 1阶环路滤波系数:alpha = 2π·FC/sr,钳位到 [0,1]
  const loopAlpha = Math.min(1, 2 * Math.PI * loopFC / sr);
  const outAlpha = Math.min(1, 2 * Math.PI * outFC / sr);

  const freq = new Float32Array(samples.length);
  let vcoPhase = 0;          // VCO 累积相位
  let vcoFreq = centerFreq;  // VCO 当前频率(Hz)
  let outFreq = centerFreq;  // 输出滤波后的频率

  for (let i = 0; i < samples.length; i++) {
    const s = filt[i] || 1e-9;
    // 鉴相器:输入信号与 VCO 正交分量(sin)的乘积 ≈ 相位误差(经 sin 近似)
    // 误差 = s · (-sin(vcoPhase)) ,正比于 (vcoPhase - signalPhase) 的 sin
    const err = -s * Math.sin(vcoPhase);
    // 环路滤波(1阶低通)→ 频率修正
    vcoFreq = centerFreq + loopAlpha * (vcoFreq - centerFreq) + loopAlpha * err * sr * 0.5;
    // 钳位 VCO 频率到 SSTV 带(防失锁飞)
    if (vcoFreq < 900) vcoFreq = 900;
    if (vcoFreq > 2600) vcoFreq = 2600;
    // VCO 相位推进
    vcoPhase += 2 * Math.PI * vcoFreq / sr;
    if (vcoPhase > Math.PI) vcoPhase -= 2 * Math.PI;
    else if (vcoPhase < -Math.PI) vcoPhase += 2 * Math.PI;
    // 输出低通(平滑频率估计)
    outFreq = outFreq + outAlpha * (vcoFreq - outFreq);
    freq[i] = outFreq;
  }

  // 3. 轻平滑(fqcSmooth):极短移动平均抑制残余相噪
  //    PLL 输出已比瞬时频率法干净,只需极轻平滑(0.3ms),不致模糊像素
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
