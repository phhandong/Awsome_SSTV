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
import {
  resample, demodulate, demodulatePhase, lmsAdaptiveLineEnhance,
  applyAFC, findSyncPulses, autoSlant,
} from './demod.js';
import { decodeNarrowFSKHeader, decodeVISHeader } from './vis.js';
import { detectSyncMode, resolveReceiveMode } from './sync-acquisition.js';

const SYNC_ONLY_ROBOT_LOCK_PULSES = 32;

/**
 * @param {Float32Array} samples  PCM
 * @param {number} sampleRate
 * @param {{onProgress?:(p:number)=>void}} opts
 * @returns {{width,height,pixels:Uint8ClampedArray,mode,psnr?:number}|null}
 */
export function decode(samples, sampleRate, opts = {}) {
  const dspOpts = opts.dsp || opts;
  const engine = dspOpts.engine || 'mmsstv';
  const requestedDemodulator = dspOpts.demodulator || 'phase';
  let demodulator = requestedDemodulator;
  const baseband = {
    lowHz: Number(dspOpts.baseband?.lowHz ?? 1000),
    highHz: Number(dspOpts.baseband?.highHz ?? 2800),
  };

  // Acquisition retains the MMSSTV-compatible 11.025-kHz path. Pixel and
  // line processing switch to the original input rate after mode lock.
  const acquisitionSr = engine === 'mmsstv' ? 11025 : DEFAULT_SAMPLE_RATE;
  const acquisitionPcm = sampleRate === acquisitionSr
    ? samples
    : resample(samples, sampleRate, acquisitionSr);

  const dspState = {
    bpf: dspOpts.bpf === true,
    lms: dspOpts.lms === true,
    afc: dspOpts.afc === true,
    afcOffsetHz: 0,
    afcLocked: false,
    engine,
    demodulator,
    baseband,
    lineOffsetValid: 0,
    lineOffsetMeanHz: 0,
  };
  const acquisitionLms = dspState.lms && dspOpts.lmsOptions?.strength !== 0;

  let acquisitionFreq = demodulate(acquisitionPcm, acquisitionSr, {
    ...dspState,
    lms: acquisitionLms,
    lmsOptions: dspOpts.lmsOptions,
  });
  if (dspState.afc) {
    const correction = applyAFC(acquisitionFreq, acquisitionSr, dspOpts.afcOptions);
    acquisitionFreq = correction.freq;
    dspState.afcOffsetHz = correction.offsetHz;
    dspState.afcLocked = correction.locked;
  }

  // 3. Acquisition: a selected mode bypasses VIS. In automatic mode, use
  // MMSSTV's repeated sync-interval start when VIS/FSK cannot be decoded.
  const forcedMode = resolveReceiveMode(opts.mode);
  const vis = forcedMode ? null
    : (decodeVISHeader(acquisitionFreq, acquisitionSr, 0)
      || decodeNarrowFSKHeader(acquisitionFreq, acquisitionSr, 0));
  let acquisition;
  let mode;
  if (forcedMode) {
    mode = forcedMode;
    const inputOffset = Math.max(0, opts.startSample || 0);
    acquisition = {
      source: 'manual', mode,
      sampleOffset: Math.round(inputOffset * acquisitionSr / sampleRate),
    };
  } else if (vis) {
    mode = getMode(vis.visCode7);
    if (!mode) throw new Error('未知 VIS 码: ' + vis.visCode7);
    acquisition = { ...vis, source: vis.extended || mode.narrow ? 'fsk' : 'vis', mode };
  } else if (opts.autoSync !== false) {
    acquisition = detectSyncMode(acquisitionFreq, acquisitionSr, opts.syncOptions);
    mode = acquisition?.mode;
  }
  if (!mode) throw new Error('未检测到 VIS/FSK 头或可识别的同步脉冲周期');

  // Robot 36 keeps the previous 11.025-kHz zero-crossing path. Several real
  // recordings are more stable with its legacy scan guard and fixed chroma
  // alternation than with separator-aware native phase decoding.
  if (mode.robot36Legacy) {
    demodulator = 'legacy';
    dspState.demodulator = demodulator;
    if (acquisition.source === 'vis' || acquisition.source === 'fsk') {
      // The earlier Robot path predates the standard-VIS smoothed-edge timing
      // correction used by native phase and fixed-clock modes.
      acquisition = {
        ...acquisition,
        sampleOffset: Math.max(0, acquisition.sampleOffset - Math.round(1.15 * acquisitionSr / 1000)),
      };
    }
  }

  let sr = acquisitionSr;
  let freq = acquisitionFreq;
  let groupDelaySamples = 0;
  if (demodulator === 'phase') {
    sr = sampleRate;
    const phaseInput = dspState.lms
      ? lmsAdaptiveLineEnhance(samples, sampleRate, dspOpts.lmsOptions)
      : samples;
    const phase = demodulatePhase(phaseInput, sr, { baseband });
    freq = phase.freq;
    groupDelaySamples = phase.groupDelaySamples;
    dspState.baseband = { lowHz: phase.lowHz, highHz: phase.highHz };
    dspState.phaseTaps = phase.taps;
    acquisition = {
      ...acquisition,
      sampleOffset: Math.round(acquisition.sampleOffset * sr / acquisitionSr + groupDelaySamples),
    };
  } else if (mode.narrow && engine === 'mmsstv') {
    freq = demodulate(acquisitionPcm, sr, {
      ...dspState,
      lms: acquisitionLms,
      narrow: true,
      bpfLow: mode.bpfLow,
      bpfHigh: mode.bpfHigh,
      lmsOptions: dspOpts.lmsOptions,
    });
  } else if (engine === 'mmsstv') {
    freq = demodulate(acquisitionPcm, sr, {
      ...dspState,
      lms: acquisitionLms,
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
    const lineSamples = Math.round(mode.lineDurationMs * sr / 1000);
    for (let y = 0; y < height; y++) firstScanStarts[y] = Math.round(start + y * lineSamples);
    const pixels = new Uint8ClampedArray(width * height * 4);
    const fallbackOffset = demodulator === 'phase' ? dspState.afcOffsetHz : 0;
    const lineOffsets = new Float32Array(height).fill(fallbackOffset);
    decodeRgb(freq, mode, firstScanStarts, lineOffsets, sr, pixels, width, height, opts);
    return { width, height, pixels, mode, dsp: dspState, acquisition };
  }

  // 4. 同步脉冲搜索 + 斜率校正
  //    自适应阈值:先用高阈值(0.25,避免假阳性);若脉冲数明显不足(漏检),
  //    降到 0.12 重检(MP3 相噪下后半场 SYNC 单样本落容差比例低)。
  //    再用行周期过滤假阳性(间隔 < 0.6 行周期的相邻脉冲合并)。
  const lineCount = mode.dataLines || height;
  const need = mode.linePll ? height : (mode.syncAtLineStart ? lineCount - 1 : lineCount);
  const syncToleranceHz = demodulator === 'phase' && !mode.narrow ? 80 : 60;
  const wideSyncToleranceHz = demodulator === 'phase' && !mode.narrow ? 200 : syncToleranceHz;
  const afterAcquisition = p => acquisition.source === 'vis' || acquisition.source === 'fsk'
    ? p > acquisition.sampleOffset
    : p >= acquisition.sampleOffset;
  const expectedPulse = expectedFirstSyncPulse(acquisition, mode, sr);
  const headerAnchoredPll = mode.robot36Legacy && Number.isFinite(expectedPulse);
  const searchPulses = (ratio, tolerance) => filterFalsePulses(
    findSyncPulses(freq, sr, 4.0, ratio, mode.syncFreq ?? FREQ.SYNC, tolerance)
      .filter(afterAcquisition).sort((a, b) => a - b),
    mode, sr, expectedPulse
  );
  let imgPulses = searchPulses(0.25, syncToleranceHz);
  // With no VIS, switching from the weak list to the strong list near the end
  // can move the fitted intercept by exactly one Robot line. That reverses the
  // fixed Cr/Cb parity and recolors every completed row. Once enough strong
  // observations exist for the robust fit, retain that phase and coast over
  // missing pulses instead of replacing it with the weak detector.
  const stableSyncOnlyRobot = mode.robot36Legacy && !headerAnchoredPll &&
    imgPulses.length >= SYNC_ONLY_ROBOT_LOCK_PULSES;
  if (headerAnchoredPll) {
    // A streaming prefix can never contain 90% of all 240 line pulses. Do
    // not alternate the whole frame between the strong and weak detector as
    // that fixed threshold is crossed. Strong observations always win their
    // theoretical row; the weak pass only fills missing ordinals.
    const weakPulses = searchPulses(0.12, syncToleranceHz);
    const period = (mode.syncPeriodMs || mode.lineDurationMs) * sr / 1000;
    const byOrdinal = new Map();
    for (const pulse of weakPulses) {
      byOrdinal.set(Math.round((pulse - expectedPulse) / period), pulse);
    }
    for (const pulse of imgPulses) {
      byOrdinal.set(Math.round((pulse - expectedPulse) / period), pulse);
    }
    imgPulses = [...byOrdinal.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, pulse]) => pulse);
  } else if (!stableSyncOnlyRobot && imgPulses.length < need * 0.9) {
    imgPulses = searchPulses(0.12, syncToleranceHz);
  }
  if (imgPulses.length < need * 0.9 && wideSyncToleranceHz > syncToleranceHz) {
    imgPulses = searchPulses(0.25, wideSyncToleranceHz);
    if (imgPulses.length < need * 0.9) {
      imgPulses = searchPulses(0.12, wideSyncToleranceHz);
    }
  }
  if (imgPulses.length === 0) throw new Error('未找到同步脉冲');
  // ReSync is a common stage, not a Robot-only repair. Refine every accepted
  // pulse before fitting the line clock so Martin/Scottie/PD benefit too.
  imgPulses = resyncPulses(freq, imgPulses, mode, sr);
  // A VIS/FSK header gives line-PLL modes an absolute clock phase. Feed their
  // real, ordinal-filtered observations directly to the causal PLL so later
  // noise cannot make a global slant regression rewrite completed rows.
  // Sync-only Robot recordings retain the compatibility fit because they do
  // not have a trustworthy absolute phase anchor.
  const syncOnlyRobotPll = stableSyncOnlyRobot && acquisition.source === 'sync';
  const lineStarts = headerAnchoredPll
    ? imgPulses
    : syncOnlyRobotPll
      ? trackSyncOnlyRobotClock(imgPulses, acquisition.sampleOffset, mode, sr)
      : autoSlant(imgPulses, mode, sr).lineStarts;

  // 5. 把脉冲位置转换成"每行首个 SCAN 段的绝对样本起点"
  //    - syncAtLineStart(Martin/Robot):脉冲 y 是行 y 行首 SYNC,首个 SCAN 在脉冲 + syncToFirstScanMs
  //    - 否则(Scottie):脉冲 i 是行 i 末尾 SYNC,其后 syncToFirstScanMs 是行 (i+1) 首个 SCAN
  const offsetSamples = Math.round(mode.syncToFirstScanMs * sr / 1000);
  const firstScanStarts = new Array(lineCount).fill(null);

  if (acquisition.source === 'sync' || acquisition.source === 'manual') {
    // Without a header, the first detected pulse anchors the first complete
    // row. End-of-line sync modes therefore start at the following row.
    for (let y = 0; y < lineCount; y++) {
      firstScanStarts[y] = lineStarts[y] !== undefined ? lineStarts[y] + offsetSamples : null;
    }
  } else if (mode.linePll) {
    // Robot 36/72:实测真实 MMSSTV 信号为逐行顺序(脉冲 i → 图像行 i+1),
    // 非奇偶分场。行 0 SYNC 紧跟 VIS(imageStart),findSyncPulses 会把 VIS stop bit
    // (1200Hz@30ms)与行0 SYNC 合并检出,导致首个图像脉冲实为行1。故行0 起点用 imageStart,
    // 脉冲序列从行1起。Cr/Cb 仍逐行交替(行 y 偶发 Cr、奇发 Cb)。
    //
    // 用 PLL 跟踪逐行起点(鲁棒于 SYNC 漏检/假阳性):行0=imageStart,每行期望 pos+=T,
    // 在期望位置±窗口找最近脉冲,严格容差(<15ms)内才采纳并修正相位,否则自由运行(漏检)。
    // T 仅在前段(信号好)用 EMA 锁定,避免后段坏脉冲污染周期估计。
    const lineSyncPos = trackLineStartsPLL(
      lineStarts, acquisition.sampleOffset, mode, sr, freq, headerAnchoredPll
    );
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

  const lineOffsetResult = demodulator === 'phase' && !mode.robot36Legacy
    ? estimateLineFrequencyOffsets(
      freq, mode, firstScanStarts, sr,
      dspState.afcLocked ? dspState.afcOffsetHz : 0
    )
    : { offsets: new Float32Array(lineCount), validCount: 0, meanHz: 0 };
  const lineOffsets = lineOffsetResult.offsets;
  dspState.lineOffsetValid = lineOffsetResult.validCount;
  dspState.lineOffsetMeanHz = lineOffsetResult.meanHz;

  const pixels = new Uint8ClampedArray(width * height * 4);  // RGBA

  if (mode.colorSpace === ColorSpace.YUV && (mode.chromaAlternate || mode.lineYuv)) {
    decodeYuvLines(freq, mode, firstScanStarts, lineOffsets, sr, pixels, width, height, opts);
  } else if (mode.pairedLines) {
    decodeYuvPaired(freq, mode, firstScanStarts, lineOffsets, sr, pixels, width, height, opts);
  } else {
    decodeRgb(freq, mode, firstScanStarts, lineOffsets, sr, pixels, width, height, opts);
  }

  return { width, height, pixels, mode, dsp: dspState, acquisition };
}

function segmentLayoutFromFirstScan(mode, sr) {
  const firstScanIdx = mode.lineSegments.findIndex(segment => segment.type === SegType.SCAN);
  if (mode.robot36Legacy) {
    let samples = 0;
    return mode.lineSegments.slice(firstScanIdx).map(segment => {
      const startSamples = samples;
      samples += Math.floor(segment.durationMs * sr / 1000);
      return { segment, startSamples, endSamples: samples };
    });
  }
  let elapsedMs = 0;
  return mode.lineSegments.slice(firstScanIdx).map(segment => {
    const startSamples = Math.round(elapsedMs * sr / 1000);
    elapsedMs += segment.durationMs;
    const endSamples = Math.round(elapsedMs * sr / 1000);
    return { segment, startSamples, endSamples };
  });
}

// RGB 模式(Martin/Scottie)逐行重建
function decodeRgb(freq, mode, firstScanStarts, lineOffsets, sr, pixels, width, height, opts) {
  const layout = segmentLayoutFromFirstScan(mode, sr);
  for (let y = 0; y < height; y++) {
    const lineStart = firstScanStarts[y];
    if (lineStart == null) continue;
    const frequencyOffset = lineOffsets[y] || 0;
    for (const { segment: seg, startSamples, endSamples } of layout) {
      if (seg.type === SegType.SCAN) {
        const channelOff = seg.channel === 'R' ? 0 : seg.channel === 'G' ? 1 : 2;
        const segmentStart = lineStart + startSamples;
        const perPixel = (endSamples - startSamples) / width;
        for (let x = 0; x < width; x++) {
          const pxStart = Math.round(segmentStart + x * perPixel);
          const pxEnd = Math.round(segmentStart + (x + 1) * perPixel);
          const lum = averageFreqToPixel(freq, pxStart, pxEnd, mode, frequencyOffset);
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
    }
    if (opts.onProgress && (y % 16 === 0)) opts.onProgress(y / height);
  }
  if (opts.onProgress) opts.onProgress(1);
}

// PD: 一个传输行带有两条亮度线和一套共享的 Cr/Cb。色度按两个相邻显示行
// 复制，这是 PD 的 4:2:0 采样格式，而不是 Robot 的逐行交替色度。
function decodeYuvPaired(freq, mode, firstScanStarts, lineOffsets, sr, pixels, width, height, opts) {
  const Y = new Float32Array(width * height);
  const Cr = new Float32Array(width * height);
  const Cb = new Float32Array(width * height);
  Cr.fill(128); Cb.fill(128);
  const layout = segmentLayoutFromFirstScan(mode, sr);

  for (let line = 0; line < mode.dataLines; line++) {
    const lineStart = firstScanStarts[line];
    if (lineStart == null) continue;
    const row0 = line * 2, row1 = row0 + 1;
    const frequencyOffset = lineOffsets[line] || 0;
    for (const { segment: seg, startSamples, endSamples } of layout) {
      if (seg.type === SegType.SCAN) {
        const segmentStart = lineStart + startSamples;
        const perPixel = (endSamples - startSamples) / width;
        for (let x = 0; x < width; x++) {
          const pxStart = Math.round(segmentStart + x * perPixel);
          const pxEnd = Math.round(segmentStart + (x + 1) * perPixel);
          const value = averageFreqToPixel(freq, pxStart, pxEnd, mode, frequencyOffset);
          if (seg.channel === 'YODD') Y[row0 * width + x] = value;
          else if (seg.channel === 'YEVEN') Y[row1 * width + x] = value;
          else {
            const target = seg.channel === 'Cr' ? Cr : Cb;
            target[row0 * width + x] = value;
            target[row1 * width + x] = value;
          }
        }
      }
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

// Robot YUV: Robot36 alternates chroma; Robot72 carries complete Y/Cr/Cb.
function decodeYuvLines(freq, mode, firstScanStarts, lineOffsets, sr, pixels, width, height, opts) {
  const Y = new Float32Array(width * height);
  const Cr = new Float32Array(width * height);
  const Cb = new Float32Array(width * height);
  Cr.fill(128); Cb.fill(128); Y.fill(0);

  const layout = segmentLayoutFromFirstScan(mode, sr);
  const markerLayout = layout.find(item => item.segment.role === 'chromaMarker');
  const lineChroma = new Array(height).fill(null);
  let lastMarkerChannel = 'Cb';

  for (let y = 0; y < height; y++) {
    const lineStart = firstScanStarts[y];
    if (lineStart == null) continue;
    const frequencyOffset = lineOffsets[y] || 0;

    if (mode.separatorAware && markerLayout) {
      const markerFrequency = averageFrequency(
        freq,
        lineStart + markerLayout.startSamples,
        lineStart + markerLayout.endSamples
      ) - frequencyOffset;
      if (Math.abs(markerFrequency - FREQ.BLACK) <= 180) lineChroma[y] = 'Cr';
      else if (Math.abs(markerFrequency - FREQ.WHITE) <= 180) lineChroma[y] = 'Cb';
      else lineChroma[y] = lastMarkerChannel === 'Cr' ? 'Cb' : 'Cr';
      lastMarkerChannel = lineChroma[y];
    } else if (mode.chromaAlternate) {
      lineChroma[y] = y % 2 === 0 ? 'Cr' : 'Cb';
    }

    for (const { segment: seg, startSamples, endSamples } of layout) {
      if (seg.type === SegType.SCAN) {
        const guard = mode.robot36Legacy
          ? Math.min(Math.floor(1.5 * sr / 1000), (endSamples - startSamples) >> 1)
          : 0;
        const segmentStart = lineStart + startSamples + guard;
        const perPixel = (endSamples - startSamples - guard) / width;
        const wantCr = seg.channel === 'Cr'
          || (seg.channel === 'CHROMA' && lineChroma[y] === 'Cr');
        const target = seg.channel === 'Y' ? Y : (wantCr ? Cr : Cb);
        for (let x = 0; x < width; x++) {
          const pxStart = mode.robot36Legacy
            ? Math.floor(segmentStart + x * perPixel)
            : Math.round(segmentStart + x * perPixel);
          const pxEnd = mode.robot36Legacy
            ? Math.floor(segmentStart + (x + 1) * perPixel)
            : Math.round(segmentStart + (x + 1) * perPixel);
          const v = averageFreqToPixel(freq, pxStart, pxEnd, mode, frequencyOffset);
          target[y * width + x] = v;
        }
      }
    }
    if (opts.onProgress && (y % 16 === 0)) opts.onProgress(y / height);
  }

  if (mode.chromaAlternate) {
    for (let y = 0; y < height; y++) {
      if (lineChroma[y] === 'Cr') {
        const src = mode.robot36Legacy
          ? (y + 1 < height ? y + 1 : (y - 1 >= 0 ? y - 1 : y))
          : nearestChromaRow(lineChroma, y, 'Cb');
        for (let x = 0; x < width; x++) Cb[y * width + x] = Cb[src * width + x];
      } else {
        const src = mode.robot36Legacy
          ? (y - 1 >= 0 ? y - 1 : (y + 1 < height ? y + 1 : y))
          : nearestChromaRow(lineChroma, y, 'Cr');
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
function averageFreqToPixel(freq, s, e, mode, frequencyOffset = 0) {
  return freqToPixel(averageFrequency(freq, s, e) - frequencyOffset, mode);
}

function averageFrequency(freq, s, e) {
  const s0 = Math.max(0, Math.floor(s));
  const e0 = Math.min(freq.length, Math.ceil(e));
  if (e0 <= s0) return FREQ.BLACK;
  let sum = 0;
  for (let i = s0; i < e0; i++) sum += freq[i];
  return sum / (e0 - s0);
}

function nearestChromaRow(lineChroma, row, wanted) {
  for (let distance = 1; distance < lineChroma.length; distance++) {
    const before = row - distance;
    const after = row + distance;
    if (before >= 0 && lineChroma[before] === wanted) return before;
    if (after < lineChroma.length && lineChroma[after] === wanted) return after;
  }
  return row;
}

export function estimateLineFrequencyOffsets(freq, mode, firstScanStarts, sr, fallbackHz = 0) {
  const segments = mode.lineSegments || [];
  const firstScanIdx = segments.findIndex(segment => segment.type === SegType.SCAN);
  const syncIdx = segments.findIndex(segment => segment.type === SegType.SYNC);
  const count = firstScanStarts.length;
  const raw = new Array(count).fill(null);
  if (firstScanIdx < 0 || syncIdx < 0) {
    return { offsets: new Float32Array(count).fill(fallbackHz), validCount: 0, meanHz: 0 };
  }

  const beforeMs = index => segments.slice(0, index)
    .reduce((sum, segment) => sum + segment.durationMs, 0);
  const firstScanMs = beforeMs(firstScanIdx);
  const syncStartMs = beforeMs(syncIdx);
  const syncDurationMs = segments[syncIdx].durationMs;
  const expectedHz = mode.syncFreq ?? FREQ.SYNC;

  for (let line = 0; line < count; line++) {
    const firstScanStart = firstScanStarts[line];
    if (firstScanStart == null) continue;
    const syncStart = firstScanStart + (syncStartMs - firstScanMs) * sr / 1000;
    const innerStart = Math.round(syncStart + syncDurationMs * 0.2 * sr / 1000);
    const innerEnd = Math.round(syncStart + syncDurationMs * 0.8 * sr / 1000);
    const start = Math.max(0, innerStart);
    const end = Math.min(freq.length, innerEnd);
    if (end - start < 3) continue;
    const values = Array.from(freq.subarray(start, end)).sort((a, b) => a - b);
    const measured = medianSorted(values);
    const deviations = values.map(value => Math.abs(value - measured)).sort((a, b) => a - b);
    const mad = medianSorted(deviations);
    const offset = measured - expectedHz;
    if (Math.abs(offset) <= 250 && mad <= 80) raw[line] = offset;
  }

  const smoothed = raw.map((value, line) => {
    if (value == null) return null;
    const neighbors = [];
    for (let index = Math.max(0, line - 1); index <= Math.min(count - 1, line + 1); index++) {
      if (raw[index] != null) neighbors.push(raw[index]);
    }
    neighbors.sort((a, b) => a - b);
    return medianSorted(neighbors);
  });

  const valid = smoothed.filter(value => value != null);
  const offsets = new Float32Array(count);
  for (let line = 0; line < count; line++) {
    if (smoothed[line] != null) {
      offsets[line] = smoothed[line];
      continue;
    }
    let replacement = null;
    for (let distance = 1; distance < count; distance++) {
      const before = line - distance;
      const after = line + distance;
      if (before >= 0 && smoothed[before] != null) { replacement = smoothed[before]; break; }
      if (after < count && smoothed[after] != null) { replacement = smoothed[after]; break; }
    }
    offsets[line] = replacement ?? fallbackHz;
  }

  return {
    offsets,
    validCount: valid.length,
    meanHz: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0,
  };
}

function medianSorted(values) {
  if (!values.length) return 0;
  const middle = values.length >> 1;
  return values.length & 1 ? values[middle] : (values[middle - 1] + values[middle]) * 0.5;
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * Causal clock for Robot 36 remote-start recordings without a VIS header.
 * A fixed early seed resolves the integer-row phase against the acquisition
 * detector. Pulses after that seed are excluded from the fit, so they cannot
 * rewrite rows that have already been returned by an earlier stream prefix.
 */
function trackSyncOnlyRobotClock(pulses, acquisitionStart, mode, sr) {
  const height = mode.height;
  const protocolPeriod = (mode.syncPeriodMs || mode.lineDurationMs) * sr / 1000;
  if (pulses.length < SYNC_ONLY_ROBOT_LOCK_PULSES) {
    return autoSlant(pulses, mode, sr).lineStarts;
  }

  // The first 32 strong observations are still in the clean part of the
  // recordings which motivated this path.  Once they are present, later
  // prefixes produce the exact same fit and therefore cannot repaint rows
  // that have already been displayed.
  const seed = autoSlant(pulses.slice(0, SYNC_ONLY_ROBOT_LOCK_PULSES), mode, sr);
  const T = seed.lineSamples || protocolPeriod;
  let phase = seed.lineStarts[0] ?? acquisitionStart;
  // A sync-only detector may acquire on line 1 while the robust regression
  // labels it line 0.  Normalize only the integer row number; retain the
  // fitted sub-line phase.  This prevents a one-line shift from swapping the
  // fixed Robot36 Cr/Cb parity when the detector confidence changes.
  phase -= Math.round((phase - acquisitionStart) / T) * T;

  return Array.from({ length: height }, (_, row) => Math.round(phase + row * T));
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
function trackLineStartsPLL(pulses, imgStart, mode, sr, freq, protocolClock = false) {
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
  let T = protocolClock
    ? (mode.syncPeriodMs || mode.lineDurationMs) * sr / 1000
    : (gaps.length ? gaps[gaps.length >> 1] : (mode.lineDurationMs * sr / 1000));

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
  let row0FromRow1Frozen = null;

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
      if (row1Locked === null) {
        row1Locked = usePos;
        // A protocol-anchored stream must not let later EMA updates move row
        // zero after it has already been rendered in an earlier partial frame.
        if (protocolClock) row0FromRow1Frozen = usePos - T;
      }
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
  const row0FromRow1 = row0FromRow1Frozen
    ?? ((row1Locked !== null) ? row1Locked - T : null);
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
function expectedFirstSyncPulse(acquisition, mode, sr) {
  if (!acquisition || (acquisition.source !== 'vis' && acquisition.source !== 'fsk')) return null;
  const segments = mode.lineSegments || [];
  const syncIdx = segments.findIndex(segment => segment.type === SegType.SYNC);
  const firstScanIdx = segments.findIndex(segment => segment.type === SegType.SCAN);
  if (syncIdx < 0 || firstScanIdx < 0) return null;
  if (mode.syncAtLineStart) {
    // The line-zero pulse touches the VIS stop bit, so the first independent
    // candidate is the pulse at the start of line one.
    return acquisition.sampleOffset + (mode.syncPeriodMs || mode.lineDurationMs) * sr / 1000;
  }
  const before = index => segments.slice(0, index)
    .reduce((sum, segment) => sum + segment.durationMs, 0);
  const relativeMs = (mode.firstScanAfterVisMs || 0) + before(syncIdx) - before(firstScanIdx);
  return acquisition.sampleOffset + relativeMs * sr / 1000;
}

function filterFalsePulses(pulses, mode, sr, expectedFirst = null) {
  if (pulses.length < 2) return pulses;
  const period = (mode.syncPeriodMs || mode.lineDurationMs) * sr / 1000;

  // A sync-only Robot recording has no VIS-derived absolute phase. Preserve
  // the legacy robust regression in that case, but estimate its de-duplication
  // period from plausible gaps near the start and ignore candidates beyond
  // the picture horizon. Neither decision may depend on a noisy trailer.
  if (mode.robot36Legacy && !Number.isFinite(expectedFirst)) {
    const horizon = pulses[0] + ((mode.height || 240) + 12) * period;
    const scoped = pulses.filter(pulse => pulse <= horizon);
    const earlyEnd = pulses[0] + 48 * period;
    const observedPeriods = [];
    for (let i = 1; i < scoped.length && scoped[i] <= earlyEnd; i++) {
      const gap = scoped[i] - scoped[i - 1];
      const step = Math.round(gap / period);
      if (step < 1 || step > 3) continue;
      const normalized = gap / step;
      if (Math.abs(normalized - period) <= 0.08 * period) observedPeriods.push(normalized);
    }
    observedPeriods.sort((a, b) => a - b);
    const stablePeriod = observedPeriods.length ? medianSorted(observedPeriods) : period;
    const filtered = [scoped[0]];
    for (let i = 1; i < scoped.length; i++) {
      if (scoped[i] - filtered[filtered.length - 1] >= 0.6 * stablePeriod) filtered.push(scoped[i]);
    }
    return filtered;
  }

  const anchor = Number.isFinite(expectedFirst) ? expectedFirst : pulses[0];
  const tolerance = 0.20 * period;
  const lastOrdinal = (mode.dataLines || mode.height || 1) + 4;
  const byLine = new Map();

  // Project candidates onto the theoretical line clock before fitting its
  // actual slope. In particular, Robot 36 must use its 150-ms syncPeriodMs,
  // not a median of every candidate gap: low-SNR noise after the picture can
  // otherwise shorten that median and make the final slant fit rewrite all
  // previously decoded rows. Missing sync pulses create empty ordinals and do
  // not shift the following rows.
  for (const pulse of pulses) {
    const ordinal = Math.round((pulse - anchor) / period);
    if (ordinal < 0 || ordinal > lastOrdinal) continue;
    const error = Math.abs(pulse - (anchor + ordinal * period));
    if (error > tolerance) continue;
    const previous = byLine.get(ordinal);
    if (!previous || error < previous.error) byLine.set(ordinal, { pulse, error });
  }
  const filtered = [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, candidate]) => candidate.pulse);
  return filtered.length >= 2 ? filtered : pulses;
}
