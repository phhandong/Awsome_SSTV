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
import { resample, demodulate, findSyncPulses, autoSlant } from './demod.js';
import { decodeVISHeader } from './vis.js';

/**
 * @param {Float32Array} samples  PCM
 * @param {number} sampleRate
 * @param {{onProgress?:(p:number)=>void}} opts
 * @returns {{width,height,pixels:Uint8ClampedArray,mode,psnr?:number}|null}
 */
export function decode(samples, sampleRate, opts = {}) {
  // 1. 重采样
  const sr = DEFAULT_SAMPLE_RATE;
  let pcm = (sampleRate === sr) ? samples : resample(samples, sampleRate, sr);

  // 2. 解调
  const freq = demodulate(pcm, sr);

  // 3. VIS 识别
  const vis = decodeVISHeader(freq, sr, 0);
  if (!vis) throw new Error('未检测到 VIS 头(可能是非 SSTV 信号或信噪比过低)');
  const mode = getMode(vis.visCode7);
  if (!mode) throw new Error('未知 VIS 码: ' + vis.visCode7);
  const { width, height } = mode;

  // 4. 同步脉冲搜索 + 斜率校正
  //    自适应阈值:先用高阈值(0.25,避免假阳性);若脉冲数明显不足(漏检),
  //    降到 0.12 重检(MP3 相噪下后半场 SYNC 单样本落容差比例低)。
  //    再用行周期过滤假阳性(间隔 < 0.6 行周期的相邻脉冲合并)。
  const need = mode.interlace ? height : (mode.syncAtLineStart ? height - 1 : height);
  let rawPulses = findSyncPulses(freq, sr, 4.0, 0.25);
  let imgPulses = rawPulses.filter(p => p > vis.sampleOffset).sort((a, b) => a - b);
  if (imgPulses.length < need * 0.9) {
    imgPulses = findSyncPulses(freq, sr, 4.0, 0.12)
      .filter(p => p > vis.sampleOffset).sort((a, b) => a - b);
  }
  if (imgPulses.length === 0) throw new Error('未找到同步脉冲');
  imgPulses = filterFalsePulses(imgPulses, mode, sr);
  const { lineStarts, slope } = autoSlant(imgPulses, mode, sr);

  // 5. 把脉冲位置转换成"每行首个 SCAN 段的绝对样本起点"
  //    - syncAtLineStart(Martin/Robot):脉冲 y 是行 y 行首 SYNC,首个 SCAN 在脉冲 + syncToFirstScanMs
  //    - 否则(Scottie):脉冲 i 是行 i 末尾 SYNC,其后 syncToFirstScanMs 是行 (i+1) 首个 SCAN
  const offsetSamples = Math.floor(mode.syncToFirstScanMs * sr / 1000);
  const firstScanStarts = new Array(height).fill(null);

  if (mode.interlace) {
    // Robot 36/72:实测真实 MMSSTV 信号为逐行顺序(脉冲 i → 图像行 i+1),
    // 非奇偶分场。行 0 SYNC 紧跟 VIS(imageStart),findSyncPulses 会把 VIS stop bit
    // (1200Hz@30ms)与行0 SYNC 合并检出,导致首个图像脉冲实为行1。故行0 起点用 imageStart,
    // 脉冲序列从行1起。Cr/Cb 仍逐行交替(行 y 偶发 Cr、奇发 Cb)。
    //
    // 用 PLL 跟踪逐行起点(鲁棒于 SYNC 漏检/假阳性):行0=imageStart,每行期望 pos+=T,
    // 在期望位置±窗口找最近脉冲,严格容差(<15ms)内才采纳并修正相位,否则自由运行(漏检)。
    // T 仅在前段(信号好)用 EMA 锁定,避免后段坏脉冲污染周期估计。
    const lineSyncPos = trackLineStartsPLL(lineStarts, vis.sampleOffset, mode, sr, freq);
    for (let y = 0; y < height; y++) {
      firstScanStarts[y] = (lineSyncPos[y] != null) ? lineSyncPos[y] + offsetSamples : null;
    }
  } else if (mode.syncAtLineStart) {
    // Martin:行 0 SYNC 紧跟 VIS(imageStart),脉冲[0] 是行 1 SYNC,脉冲[y-1] 是行 y SYNC
    firstScanStarts[0] = vis.sampleOffset + offsetSamples;
    for (let y = 1; y < height; y++) {
      firstScanStarts[y] = (lineStarts[y - 1] !== undefined) ? lineStarts[y - 1] + offsetSamples : null;
    }
  } else {
    // Scottie:脉冲 i 是行 i 末尾 SYNC,其后 9.0ms(SYNC 时长)是行 (i+1) 的 G 起点
    // 行 0 的 G 起点 = imageStart + 初始 SYNC(9.0) + porch(1.522)(needsInitialSync 产生)
    const initSyncSamples = Math.floor((9.0 + 1.522) * sr / 1000);
    firstScanStarts[0] = vis.sampleOffset + initSyncSamples;
    for (let y = 1; y < height; y++) {
      const p = lineStarts[y - 1];
      firstScanStarts[y] = (p !== undefined) ? p + offsetSamples : null;
    }
  }

  const pixels = new Uint8ClampedArray(width * height * 4);  // RGBA

  if (mode.colorSpace === ColorSpace.YUV && mode.interlace) {
    decodeYuvInterlaced(freq, mode, firstScanStarts, sr, pixels, width, height, opts);
  } else {
    decodeRgb(freq, mode, firstScanStarts, sr, pixels, width, height, opts);
  }

  return { width, height, pixels, mode };
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
          const lum = averageFreqToPixel(freq, pxStart, pxEnd);
          pixels[(y * width + x) * 4 + channelOff] = lum;
          pixels[(y * width + x) * 4 + 3] = 255;  // alpha
        }
      }
      segOffsetSamples += segSamples;
    }
    if (opts.onProgress && (y % 16 === 0)) opts.onProgress(y / height);
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
          const v = averageFreqToPixel(freq, pxStart, pxEnd);
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
function averageFreqToPixel(freq, s, e) {
  const s0 = Math.max(0, Math.floor(s));
  const e0 = Math.min(freq.length - 1, Math.ceil(e));
  if (e0 <= s0) return 0;
  let sum = 0;
  for (let i = s0; i <= e0; i++) sum += freq[i];
  return freqToPixel(sum / (e0 - s0 + 1));
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
function refineSync(freq, center, searchMs, syncMs, sr) {
  const c = Math.floor(center);
  const search = Math.floor(searchMs * sr / 1000);
  const winLen = Math.floor(syncMs * sr / 1000);
  const lo = 1140, hi = 1260;
  let bestPos = c, bestCnt = -1;
  for (let off = -search; off <= search; off++) {
    const s0 = c + off;
    let cnt = 0;
    for (let k = 0; k < winLen; k++) {
      const i = s0 + k;
      if (i >= 0 && i < freq.length && freq[i] >= lo && freq[i] <= hi) cnt++;
    }
    if (cnt > bestCnt) { bestCnt = cnt; bestPos = s0; }
  }
  // 信号太差(SYNC 段 1200Hz 不足 20%):不信任精化,保留 center
  if (bestCnt < winLen * 0.2) return c;
  return bestPos;
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
