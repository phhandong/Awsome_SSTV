// SPDX-License-Identifier: LGPL-3.0-or-later
// decoder.js — SSTV 解码器:PCM → 图像
//
// 流程:
//   1. 重采样到 44100Hz(若需要)
//   2. demodulate → freq[](每样本频率)
//   3. decodeVISHeader → 模式 + 图像起始偏移
//   4. findSyncPulses + autoSlant → 每行起点
//   5. 逐行:按 lineSegments 在 freq[] 上取段,SCAN 段把样本均分到像素→亮度
//   6. Robot YUV:奇偶场合并 + YUV→RGB

import { DEFAULT_SAMPLE_RATE, SegType, ColorSpace, getMode, freqToPixel, FREQ } from './modes.js';
import { resample, demodulate, applyAFC, findSyncPulses, autoSlant } from './demod.js';
import { decodeNarrowFSKHeader, decodeVISHeader } from './vis.js';
import { detectSyncMode, resolveReceiveMode } from './sync-acquisition.js';

/**
 * @param {Float32Array} samples  PCM
 * @param {number} sampleRate
 * @param {{onProgress?:(p:number)=>void}} opts
 * @returns {{width,height,pixels:Uint8ClampedArray,mode,psnr?:number}|null}
 */
export function decode(samples, sampleRate, opts = {}) {
  const dspOpts = opts.dsp || opts;
  // 1. 重采样
  const sr = dspOpts.engine === 'mmsstv' ? 11025 : DEFAULT_SAMPLE_RATE;
  let pcm = (sampleRate === sr) ? samples : resample(samples, sampleRate, sr);

  // 2. DSP + 解调。嵌套 dsp 供 UI 使用，同时兼容直接传入平铺选项。
  const dspState = {
    bpf: dspOpts.bpf !== false,
    lms: dspOpts.lms === true,
    afc: dspOpts.afc === true,
    afcOffsetHz: 0,
    afcLocked: false,
    engine: dspOpts.engine || 'legacy',
  };
  let freq = demodulate(pcm, sr, {
    ...dspState,
    lmsOptions: dspOpts.lmsOptions,
  });
  if (dspState.afc) {
    const correction = applyAFC(freq, sr, dspOpts.afcOptions);
    freq = correction.freq;
    dspState.afcOffsetHz = correction.offsetHz;
    dspState.afcLocked = correction.locked;
  }

  // 3. Acquisition: a selected mode bypasses VIS. In automatic mode, use
  // MMSSTV's repeated sync-interval start when VIS/FSK cannot be decoded.
  const forcedMode = resolveReceiveMode(opts.mode);
  const vis = forcedMode ? null : (decodeVISHeader(freq, sr, 0) || decodeNarrowFSKHeader(freq, sr, 0));
  let acquisition;
  let mode;
  if (forcedMode) {
    mode = forcedMode;
    acquisition = { source: 'manual', mode, sampleOffset: Math.max(0, opts.startSample || 0) };
  } else if (vis) {
    mode = getMode(vis.visCode7);
    if (!mode) throw new Error('未知 VIS 码: ' + vis.visCode7);
    acquisition = { ...vis, source: vis.extended || mode.narrow ? 'fsk' : 'vis', mode };
  } else if (opts.autoSync !== false) {
    acquisition = detectSyncMode(freq, sr, opts.syncOptions);
    mode = acquisition?.mode;
  }
  if (!mode) throw new Error('未检测到 VIS/FSK 头或可识别的同步脉冲周期');
  if (mode.narrow && dspState.engine === 'mmsstv') {
    freq = demodulate(pcm, sr, {
      ...dspState,
      narrow: true,
      bpfLow: mode.bpfLow,
      bpfHigh: mode.bpfHigh,
      lmsOptions: dspOpts.lmsOptions,
    });
  } else if (dspState.engine === 'mmsstv') {
    // MMSSTV's CPLL owns acquisition and mode lock. For a complete browser
    // recording, retain the zero-crossing track for pixel integration: it is
    // zero-phase, preserves short pixels and avoids adding the live loop's
    // group delay to every scan line.
    freq = demodulate(pcm, sr, {
      ...dspState,
      engine: 'legacy',
      lmsOptions: dspOpts.lmsOptions,
    });
    if (dspState.afc) {
      const correction = applyAFC(freq, sr, dspOpts.afcOptions);
      freq = correction.freq;
      dspState.afcOffsetHz = correction.offsetHz;
      dspState.afcLocked = correction.locked;
    }
  }
  const { width, height } = mode;

  // AVT 不以行同步锁定。VIS 后按其标准行周期连续取样，因而不存在可供
  // autoSlant 使用的可靠同步脉冲。
  if (mode.noSync) {
    const firstScanStarts = new Array(height);
    const start = acquisition.sampleOffset + Math.floor((mode.firstScanAfterVisMs || 0) * sr / 1000);
    // 本地 44.1kHz 编码器逐段向下取整；其他采样率的输入经过重采样后，
    // 应保持理论行周期。两者混用会在 AVT 的整幅图上积累明显水平漂移。
    const lineSamples = sampleRate === sr
      ? mode.lineSegments.reduce(
        (sum, seg) => sum + Math.floor(seg.durationMs * sr / 1000), 0
      )
      : mode.lineDurationMs * sr / 1000;
    for (let y = 0; y < height; y++) firstScanStarts[y] = Math.round(start + y * lineSamples);
    const pixels = new Uint8ClampedArray(width * height * 4);
    decodeRgb(freq, mode, firstScanStarts, sr, pixels, width, height, opts);
    return { width, height, pixels, mode, dsp: dspState, acquisition };
  }

  // 4. 同步脉冲搜索 + 斜率校正
  //    自适应阈值:先用高阈值(0.25,避免假阳性);若脉冲数明显不足(漏检),
  //    降到 0.12 重检(MP3 相噪下后半场 SYNC 单样本落容差比例低)。
  //    再用行周期过滤假阳性(间隔 < 0.6 行周期的相邻脉冲合并)。
  const lineCount = mode.dataLines || height;
  const need = mode.interlace ? height : (mode.syncAtLineStart ? lineCount - 1 : lineCount);
  let rawPulses = findSyncPulses(freq, sr, 4.0, 0.25, mode.syncFreq ?? FREQ.SYNC);
  const afterAcquisition = p => acquisition.source === 'vis' || acquisition.source === 'fsk'
    ? p > acquisition.sampleOffset
    : p >= acquisition.sampleOffset;
  let imgPulses = rawPulses.filter(afterAcquisition).sort((a, b) => a - b);
  if (imgPulses.length < need * 0.9) {
    imgPulses = findSyncPulses(freq, sr, 4.0, 0.12, mode.syncFreq ?? FREQ.SYNC)
      .filter(afterAcquisition).sort((a, b) => a - b);
  }
  if (imgPulses.length === 0) throw new Error('未找到同步脉冲');
  imgPulses = filterFalsePulses(imgPulses, mode, sr);
  // ReSync is a common stage, not a Robot-only repair. Refine every accepted
  // pulse before fitting the line clock so Martin/Scottie/PD benefit too.
  imgPulses = resyncPulses(freq, imgPulses, mode, sr);
  const { lineStarts } = autoSlant(imgPulses, mode, sr);

  // 5. 把脉冲位置转换成"每行首个 SCAN 段的绝对样本起点"
  //    - syncAtLineStart(Martin/Robot):脉冲 y 是行 y 行首 SYNC,首个 SCAN 在脉冲 + syncToFirstScanMs
  //    - 否则(Scottie):脉冲 i 是行 i 末尾 SYNC,其后 syncToFirstScanMs 是行 (i+1) 首个 SCAN
  const offsetSamples = Math.floor(mode.syncToFirstScanMs * sr / 1000);
  const firstScanStarts = new Array(lineCount).fill(null);

  if (acquisition.source === 'sync' || acquisition.source === 'manual') {
    // Without a header, the first detected pulse anchors the first complete
    // row. End-of-line sync modes therefore start at the following row.
    for (let y = 0; y < lineCount; y++) {
      firstScanStarts[y] = lineStarts[y] !== undefined ? lineStarts[y] + offsetSamples : null;
    }
  } else if (mode.interlace) {
    // Robot 36/72:实测真实 MMSSTV 信号为逐行顺序(脉冲 i → 图像行 i+1),
    // 非奇偶分场。行 0 SYNC 紧跟 VIS(imageStart),findSyncPulses 会把 VIS stop bit
    // (1200Hz@30ms)与行0 SYNC 合并检出,导致首个图像脉冲实为行1。故行0 起点用 imageStart,
    // 脉冲序列从行1起。Cr/Cb 仍逐行交替(行 y 偶发 Cr、奇发 Cb)。
    //
    // 用 PLL 跟踪逐行起点(鲁棒于 SYNC 漏检/假阳性):行0=imageStart,每行期望 pos+=T,
    // 在期望位置±窗口找最近脉冲,严格容差(<15ms)内才采纳并修正相位,否则自由运行(漏检)。
    // T 仅在前段(信号好)用 EMA 锁定,避免后段坏脉冲污染周期估计。
    const lineSyncPos = trackLineStartsPLL(lineStarts, acquisition.sampleOffset, mode, sr, freq);
    for (let y = 0; y < height; y++) {
      firstScanStarts[y] = (lineSyncPos[y] != null) ? lineSyncPos[y] + offsetSamples : null;
    }
  } else if (mode.syncAtLineStart) {
    // Martin:行 0 SYNC 紧跟 VIS(imageStart),脉冲[0] 是行 1 SYNC,脉冲[y-1] 是行 y SYNC
    firstScanStarts[0] = acquisition.sampleOffset + offsetSamples;
    for (let y = 1; y < lineCount; y++) {
      firstScanStarts[y] = (lineStarts[y - 1] !== undefined) ? lineStarts[y - 1] + offsetSamples : null;
    }
  } else {
    // Scottie/SC2/BW:脉冲位于行尾。首行及后续行到第一个 SCAN 的偏移
    // 因族而异，不能再写死 Scottie 1 的 9.0ms + 1.522ms。
    const firstOffset = Math.floor((mode.firstScanAfterVisMs ?? 9.0 + 1.522) * sr / 1000);
    firstScanStarts[0] = acquisition.sampleOffset + firstOffset;
    for (let y = 1; y < lineCount; y++) {
      const p = lineStarts[y - 1];
      firstScanStarts[y] = (p !== undefined) ? p + offsetSamples : null;
    }
  }

  const pixels = new Uint8ClampedArray(width * height * 4);  // RGBA

  if (mode.colorSpace === ColorSpace.YUV && mode.interlace) {
    decodeYuvInterlaced(freq, mode, firstScanStarts, sr, pixels, width, height, opts);
  } else if (mode.lineYuv) {
    decodeYuvInterlaced(freq, mode, firstScanStarts, sr, pixels, width, height, opts);
  } else if (mode.pairedLines) {
    decodeYuvPaired(freq, mode, firstScanStarts, sr, pixels, width, height, opts);
  } else {
    decodeRgb(freq, mode, firstScanStarts, sr, pixels, width, height, opts);
  }

  return { width, height, pixels, mode, dsp: dspState, acquisition };
}

// SCAN 段开头预留 guard(毫秒):避开段边界的瞬态(前接 porch/SYNC 的频率过渡,
// 实测 CHROMA 段开头 ~2ms 内频率虚高致最左侧列偏蓝)。像素从 guard 后均分到段末。
const SCAN_GUARD_MS = 1.5;

// RGB 模式(Martin/Scottie)逐行重建
function decodeRgb(freq, mode, firstScanStarts, sr, pixels, width, height, opts) {
  // 找到首个 SCAN 段在 lineSegments 中的索引,从它开始遍历(SCAN 之前的 SYNC/porch 已由 firstScanStarts 跳过)
  const segs = mode.lineSegments;
  const firstScanIdx = segs.findIndex(s => s.type === SegType.SCAN);
  for (let y = 0; y < height; y++) {
    const lineStart = firstScanStarts[y];
    if (lineStart == null) continue;
    let segOffsetSamples = 0;
    for (let si = firstScanIdx; si < segs.length; si++) {
      const seg = segs[si];
      // 用 floor 对齐编码端的整数样本数,避免行内像素累积漂移
      const segSamples = Math.floor(seg.durationMs * sr / 1000);
      if (seg.type === SegType.SCAN) {
        const channelOff = seg.channel === 'R' ? 0 : seg.channel === 'G' ? 1 : 2;
        // 段开头留 guard,剩余样本均分到像素(避开边界瞬态)
        const guard = Math.min(Math.floor(SCAN_GUARD_MS * sr / 1000), segSamples >> 1);
        const usable = segSamples - guard;
        const perPixel = usable / width;
        for (let x = 0; x < width; x++) {
          const pxStart = Math.floor(lineStart + segOffsetSamples + guard + x * perPixel);
          const pxEnd = Math.floor(lineStart + segOffsetSamples + guard + (x + 1) * perPixel);
          const lum = averageFreqToPixel(freq, pxStart, pxEnd, mode);
          const pixelOff = (y * width + x) * 4;
          if (mode.colorSpace === ColorSpace.GRAY) {
            pixels[pixelOff] = lum;
            pixels[pixelOff + 1] = lum;
            pixels[pixelOff + 2] = lum;
          } else {
            pixels[pixelOff + channelOff] = lum;
          }
          pixels[pixelOff + 3] = 255;  // alpha
        }
      }
      segOffsetSamples += segSamples;
    }
    if (opts.onProgress && (y % 16 === 0)) opts.onProgress(y / height);
  }
  if (opts.onProgress) opts.onProgress(1);
}

// PD: 一个传输行带有两条亮度线和一套共享的 Cr/Cb。色度按两个相邻显示行
// 复制，这是 PD 的 4:2:0 采样格式，而不是 Robot 的逐行交替色度。
function decodeYuvPaired(freq, mode, firstScanStarts, sr, pixels, width, height, opts) {
  const Y = new Float32Array(width * height);
  const Cr = new Float32Array(width * height);
  const Cb = new Float32Array(width * height);
  Cr.fill(128); Cb.fill(128);
  const segs = mode.lineSegments;
  const firstScanIdx = segs.findIndex(s => s.type === SegType.SCAN);

  for (let line = 0; line < mode.dataLines; line++) {
    const lineStart = firstScanStarts[line];
    if (lineStart == null) continue;
    const row0 = line * 2, row1 = row0 + 1;
    let segOffsetSamples = 0;
    for (let si = firstScanIdx; si < segs.length; si++) {
      const seg = segs[si];
      const segSamples = Math.floor(seg.durationMs * sr / 1000);
      if (seg.type === SegType.SCAN) {
        const guard = Math.min(Math.floor(SCAN_GUARD_MS * sr / 1000), segSamples >> 1);
        const usable = segSamples - guard;
        const perPixel = usable / width;
        for (let x = 0; x < width; x++) {
          const pxStart = Math.floor(lineStart + segOffsetSamples + guard + x * perPixel);
          const pxEnd = Math.floor(lineStart + segOffsetSamples + guard + (x + 1) * perPixel);
          const value = averageFreqToPixel(freq, pxStart, pxEnd, mode);
          if (seg.channel === 'YODD') Y[row0 * width + x] = value;
          else if (seg.channel === 'YEVEN') Y[row1 * width + x] = value;
          else {
            const target = seg.channel === 'Cr' ? Cr : Cb;
            target[row0 * width + x] = value;
            target[row1 * width + x] = value;
          }
        }
      }
      segOffsetSamples += segSamples;
    }
    if (opts.onProgress && (line % 16 === 0)) opts.onProgress(line / mode.dataLines);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const yv = Y[idx], cr = Cr[idx], cb = Cb[idx];
      const off = idx * 4;
      pixels[off] = clamp(yv + 1.402 * (cr - 128));
      pixels[off + 1] = clamp(yv - 0.344 * (cb - 128) - 0.714 * (cr - 128));
      pixels[off + 2] = clamp(yv + 1.772 * (cb - 128));
      pixels[off + 3] = 255;
    }
  }
  if (opts.onProgress) opts.onProgress(1);
}

// Robot YUV 4:2:2 隔行双场。firstScanStarts 已按 y 索引(奇偶场已在主流程映射)。
function decodeYuvInterlaced(freq, mode, firstScanStarts, sr, pixels, width, height, opts) {
  const Y = new Float32Array(width * height);
  const Cr = new Float32Array(width * height);
  const Cb = new Float32Array(width * height);
  Cr.fill(128); Cb.fill(128); Y.fill(0);  // 色度默认中心,避免空场偏色

  const segs = mode.lineSegments;
  const firstScanIdx = segs.findIndex(s => s.type === SegType.SCAN);

  for (let y = 0; y < height; y++) {
    const lineStart = firstScanStarts[y];
    if (lineStart == null) continue;
    let segOffsetSamples = 0;
    for (let si = firstScanIdx; si < segs.length; si++) {
      const seg = segs[si];
      const segSamples = Math.floor(seg.durationMs * sr / 1000);
      if (seg.type === SegType.SCAN) {
        // 段开头留 guard,避开边界瞬态(CHROMA 段开头 ~2ms 频率虚高致最左列偏蓝)
        const guard = Math.min(Math.floor(SCAN_GUARD_MS * sr / 1000), segSamples >> 1);
        const usable = segSamples - guard;
        const perPixel = usable / width;
        // CHROMA 逐行交替:行 y 偶发 Cr,奇发 Cb(与 encoder 一致)
        const wantCr = seg.channel === 'Cr' || (seg.channel === 'CHROMA' && (y % 2 === 0));
        const target = seg.channel === 'Y' ? Y : (wantCr ? Cr : Cb);
        for (let x = 0; x < width; x++) {
          const pxStart = Math.floor(lineStart + segOffsetSamples + guard + x * perPixel);
          const pxEnd = Math.floor(lineStart + segOffsetSamples + guard + (x + 1) * perPixel);
          const v = averageFreqToPixel(freq, pxStart, pxEnd, mode);
          target[y * width + x] = v;
        }
      }
      segOffsetSamples += segSamples;
    }
    if (opts.onProgress && (y % 16 === 0)) opts.onProgress(y / height);
  }

  // Cr/Cb 逐行交替:每行只有一种色度,用相邻互补行填充缺失的色度。
  // Robot36 是 line-alternating:行 y 偶发 Cr、y 奇发 Cb,互补行是 y±1(不是 y±2)。
  //   偶行(y%2==0,有Cr)缺 Cb → 从 y+1(奇行,有Cb)借
  //   奇行(y%2==1,有Cb)缺 Cr → 从 y-1(偶行,有Cr)借
  // 注意:借 y±2 会取到同类行(也只有同种色度),只能借到默认 128,导致每行丢一个色度通道。
  if (mode.chromaAlternate) {
    for (let y = 0; y < height; y++) {
      if (y % 2 === 0) {
        // 偶行有 Cr,缺 Cb:优先从下一行(y+1)借;末行退到上一行
        const src = (y + 1 < height) ? y + 1 : (y - 1 >= 0 ? y - 1 : y);
        for (let x = 0; x < width; x++) Cb[y * width + x] = Cb[src * width + x];
      } else {
        // 奇行有 Cb,缺 Cr:优先从上一行(y-1)借;首行退到下一行
        const src = (y - 1 >= 0) ? y - 1 : (y + 1 < height ? y + 1 : y);
        for (let x = 0; x < width; x++) Cr[y * width + x] = Cr[src * width + x];
      }
    }
  }

  // YUV→RGB
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const yv = Y[idx], cr = Cr[idx], cb = Cb[idx];
      const r = yv + 1.402 * (cr - 128);
      const g = yv - 0.344 * (cb - 128) - 0.714 * (cr - 128);
      const b = yv + 1.772 * (cb - 128);
      const off = idx * 4;
      pixels[off]     = clamp(r);
      pixels[off + 1] = clamp(g);
      pixels[off + 2] = clamp(b);
      pixels[off + 3] = 255;
    }
  }
  if (opts.onProgress) opts.onProgress(1);
}

// 取样本窗口 [s,e) 内的平均频率 → 亮度
function averageFreqToPixel(freq, s, e, mode) {
  const s0 = Math.max(0, Math.floor(s));
  const e0 = Math.min(freq.length, Math.ceil(e));
  if (e0 <= s0) return 0;
  let sum = 0;
  for (let i = s0; i < e0; i++) sum += freq[i];
  return freqToPixel(sum / (e0 - s0), mode);
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * PLL 逐行起点跟踪(Robot 逐行模式)。
 *
 * 输入 lineStarts 是 findSyncPulses+filterFalsePulses 后的脉冲位置(行1起,因行0 SYNC
 * 与 VIS stop bit 合并)。返回每行(0..height-1)的 SYNC 样本位置。
 *
 * 策略:
 *  - 行周期 T 用脉冲间隔中位数初值
 *  - 行0:imgStart 附近 ±30ms 内用 refineSync 精确定位(找 1200Hz 最集中的 9ms 窗口)
 *    —— imgStart 来自 VIS 头计算,实测可偏 ±24ms,直接用会导致最左侧列错位(蓝色竖线)
 *  - 从行1起,每行期望 pos=上行位置+T,在 [pos-0.4T, pos+0.4T] 找最近脉冲
 *  - 严格容差(<15ms)内才采纳该脉冲,并 refineSync 精化到 SYNC 中心(消除脉冲起点抖动)
 *  - T 仅在前段(信号好)用 EMA 锁定,避免后段坏脉冲污染周期估计
 *  - 超出容差(漏检/假阳性)则用期望位置自由运行,保持相位连续
 *
 * refineSync 对应 MMSSTV ReSync 的"在窗口内找最优同步点"(逆向文档 §6.1,最小度量初值
 * 0x7fffffff):以 1200Hz 样本数为度量,在候选起点附近滑动 9ms 窗口找最大值。
 */
function trackLineStartsPLL(pulses, imgStart, mode, sr, freq) {
  const height = mode.height;
  const out = new Array(height).fill(null);
  const syncMs = mode.lineSegments[0].durationMs;  // SYNC 时长(Robot 9ms)

  if (pulses.length === 0) {
    const T = mode.lineDurationMs * sr / 1000;
    const syncSamples = Math.floor(syncMs * sr / 1000);
    out[0] = imgStart - syncSamples;  // imgStart 是 SYNC 结束,起点前移 SYNC 时长
    for (let y = 1; y < height; y++) out[y] = out[0] + y * T;
    return out;
  }

  // T 初值:脉冲间隔中位数,回退到模式理想行周期
  const gaps = [];
  for (let i = 1; i < pulses.length; i++) gaps.push(pulses[i] - pulses[i - 1]);
  gaps.sort((a, b) => a - b);
  let T = gaps.length ? gaps[gaps.length >> 1] : (mode.lineDurationMs * sr / 1000);

  const strictMs = 15;                        // 严格容差:仅接受 15ms 内的脉冲
  const strict = Math.floor(strictMs * sr / 1000);
  const lockRows = 30;                         // T 的 EMA 锁定区(前段信号好)

  // 行0:先暂用 imgStart,等行1 锁定后回填(行0 = 行1 - T)。
  // 不直接对 imgStart 做大范围 refineSync:行0 SYNC 紧贴 VIS stop bit(同为 1200Hz),
  // refineSync 会误选 stop bit 起点(闭环实测偏 -28ms)。imgStart 的 VIS 计算误差(真实
  // MP3 可偏 +24ms)由"行1 精确定位后反推"补偿。
  let prevBest = imgStart;
  let pos = imgStart + T;   // 行1 的期望 SYNC
  let pi = 0;             // pulses 指针(前向,不回头)
  let row1Locked = null;

  for (let y = 1; y < height; y++) {
    const win = 0.4 * T;
    // 跳过已过期的脉冲(在期望位置左侧很远)
    while (pi < pulses.length && pulses[pi] < pos - win) pi++;
    // 在 [pos-win, pos+win] 找最近脉冲
    let best = null, bd = win;
    let pj = pi;
    while (pj < pulses.length && pulses[pj] <= pos + win) {
      const d = Math.abs(pulses[pj] - pos);
      if (d < bd) { bd = d; best = pulses[pj]; }
      pj++;
    }
    let usePos;
    if (best !== null && bd < strict) {
      // 严格命中:小范围(±5ms)精化到 SYNC 中心(消除脉冲起点抖动,解决模糊)
      usePos = refineSync(freq, best, 5, syncMs, sr);
      if (y < lockRows) {
        const observed = usePos - prevBest;
        if (observed > 0.85 * T && observed < 1.15 * T) {
          T = 0.7 * T + 0.3 * observed;  // EMA 修正 T
        }
      }
      prevBest = usePos;
      if (row1Locked === null) row1Locked = usePos;
    } else {
      usePos = pos;   // 漏检/假阳性:自由运行
    }
    out[y] = usePos;
    pos = usePos + T;
  }
  // 行0 回填:imgStart 是 VIS 头结束点 = 行0 SYNC 的结束(SYNC 紧贴 stop bit,同为 1200Hz,
  // refineSync 无法区分会误选 stop bit 起点)。行0 SYNC 起点 = imgStart - SYNC 时长。
  // 行1 锁定则交叉验证:行1-T 应 ≈ imgStart-syncMs,取均值更稳。
  const syncSamples = Math.floor(syncMs * sr / 1000);
  const row0FromImg = imgStart - syncSamples;
  const row0FromRow1 = (row1Locked !== null) ? row1Locked - T : null;
  out[0] = (row0FromRow1 !== null)
    ? Math.round((row0FromImg + row0FromRow1) / 2)
    : row0FromImg;
  return out;
}

/**
 * 局部精化 SYNC 位置:在 center ± searchMs 内,滑动 syncMs 窗口,
 * 找 1200Hz(±60)样本数最多的窗口起点。对应 MMSSTV ReSync 的最优同步点搜索。
 * 信号差时(1200Hz 占比低)返回 center 不动,避免被噪声拉偏。
 */
function refineSync(freq, center, searchMs, syncMs, sr, targetHz = FREQ.SYNC) {
  const c = Math.floor(center);
  const search = Math.floor(searchMs * sr / 1000);
  const winLen = Math.floor(syncMs * sr / 1000);
  const lo = targetHz - 60, hi = targetHz + 60;
  const isSync = i => i >= 0 && i < freq.length && freq[i] >= lo && freq[i] <= hi;
  let pos = c - search;
  let count = 0;
  for (let k = 0; k < winLen; k++) if (isSync(pos + k)) count++;
  let bestPos = pos, bestCnt = count;
  for (pos++; pos <= c + search; pos++) {
    if (isSync(pos - 1)) count--;
    if (isSync(pos + winLen - 1)) count++;
    if (count > bestCnt) { bestCnt = count; bestPos = pos; }
  }
  // 信号太差(SYNC 段 1200Hz 不足 20%):不信任精化,保留 center
  if (bestCnt < winLen * 0.2) return c;
  return bestPos;
}

/**
 * Commit and reset-style ReSync pass for every mode with line sync.
 * Candidates are refined to the minimum 1200-Hz mismatch metric, then
 * de-duplicated with the DLL's confirmed five-sample minimum interval.
 */
function resyncPulses(freq, pulses, mode, sr) {
  if (pulses.length === 0) return pulses;
  const syncSeg = mode.lineSegments.find(seg => seg.type === SegType.SYNC);
  if (!syncSeg) return pulses;
  const refined = [];
  for (const candidate of pulses.slice().sort((a, b) => a - b)) {
    const best = refineSync(freq, candidate, 5, syncSeg.durationMs, sr, mode.syncFreq ?? FREQ.SYNC);
    if (refined.length === 0 || best - refined[refined.length - 1] >= 5) {
      refined.push(best);
    }
  }
  return refined;
}

/**
 * 过滤假阳性 SYNC 脉冲。
 *
 * 降阈值(0.12)检出的脉冲可能含假阳性:
 *  - SYNC 段(9ms)被抖动拆成两个相邻脉冲,间隔远小于行周期
 *  - 像素段的瞬时频率偶然落入 1200Hz 容差
 *
 * 用行周期 T(脉冲间隔中位数)合并间隔 < 0.6T 的相邻脉冲(取首个)。
 * 不删除间隔 > T 的(那可能是隔行场切换或漏检,由行映射的 null 处理)。
 */
function filterFalsePulses(pulses, mode, sr) {
  if (pulses.length < 2) return pulses;
  const gaps = [];
  for (let i = 1; i < pulses.length; i++) gaps.push(pulses[i] - pulses[i - 1]);
  gaps.sort((a, b) => a - b);
  const T = gaps[gaps.length >> 1] || (mode.lineDurationMs * sr / 1000);
  const out = [pulses[0]];
  for (let i = 1; i < pulses.length; i++) {
    if (pulses[i] - out[out.length - 1] >= 0.6 * T) out.push(pulses[i]);
  }
  return out;
}
