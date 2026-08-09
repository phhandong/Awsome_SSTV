// SPDX-License-Identifier: LGPL-3.0-or-later
// Mode parameters adapted from MMSSTV, Copyright 2000-2013 Makoto Mori, Nobuyuki Oba.
// modes.js — SSTV 模式数据库(唯一时序真相源)
//
// 频率常量来源:逆向 SSTVENG.dll (MMSSTV v1.06, JE3HHT) 确认的标准 SSTV 频率。
// 模式名表来源:逆向所得 37 模式表(REVERSE_ENGINEERING.md §4)。
// 像素尺寸 / VIS 码 / ms 时序:公开 SSTV 协议规范(逆向未提取,运行时填充)。
//
// 设计:用"行段数组"描述一行扫描结构。新增模式只需加一条 ModeDescriptor。

export const FREQ = {
  SYNC: 1200,        // 同步脉冲
  BLACK: 1500,       // 黑电平 / porch
  WHITE: 2300,       // 白电平
  VIS_START: 1900,   // VIS leader 起始脉冲
  VIS_BREAK: 1200,   // VIS break / start / stop bit
  VIS_BIT_1: 1100,   // VIS 数据位 "1"
  VIS_BIT_0: 1300,   // VIS 数据位 "0"
  NARROW_SYNC: 1900,
  NARROW_BLACK: 2044,
  NARROW_WHITE: 2300,
  FSK_SPACE: 2100,
};

// 亮度 0..255 → 频率 1500(黑)..2300(白),线性
export function pixelToFreq(v, mode = null) {
  const low = mode?.frequencyLow ?? FREQ.BLACK;
  const high = mode?.frequencyHigh ?? FREQ.WHITE;
  return low + (v / 255) * (high - low);
}
// 频率 → 亮度(钳位)
export function freqToPixel(f, mode = null) {
  const low = mode?.frequencyLow ?? FREQ.BLACK;
  const high = mode?.frequencyHigh ?? FREQ.WHITE;
  if (f < low) f = low;
  if (f > high) f = high;
  return Math.round((f - low) / (high - low) * 255);
}

// 段类型
export const SegType = {
  SYNC: 'sync',            // 1200Hz 同步脉冲
  PORCH: 'porch',          // 1500Hz 黑电平(后沿/分隔)
  SYNC_PORCH: 'syncporch', // Scottie:同步后的短黑电平
  SEPARATOR: 'separator',  // Robot chroma marker/separator
  SCAN: 'scan',            // 图像扫描,频率随像素亮度变化
};

export const ColorSpace = { RGB: 'rgb', YUV: 'yuv', GRAY: 'gray' };

// RXSSTV/MMSSTV v1.06 的公共模式目录。数据由 32 位运行时直接调用
// mmsGetModeName / mmsGetModeSize / mmsGetModeLength 提取，而非按文档猜测。
// `implemented` 仅表示当前浏览器端已有完整的收发时序实现；目录本身保留全部
// 43 个 MMSSTV 模式，供逐族复刻时使用，并避免把内部类型索引误当作公共索引。
export const RXSSTV_MODE_CATALOG = [
  { engineIndex: 0, name: 'B/W 8', width: 160, height: 120, durationMs: 8027, implemented: true },
  { engineIndex: 1, name: 'B/W 12', width: 160, height: 120, durationMs: 12000, implemented: true },
  { engineIndex: 2, name: 'Robot 24', width: 160, height: 120, durationMs: 24000, implemented: true },
  { engineIndex: 3, name: 'Robot 36', width: 320, height: 240, durationMs: 36000, implemented: true },
  { engineIndex: 4, name: 'Robot 72', width: 320, height: 240, durationMs: 72000, implemented: true },
  { engineIndex: 5, name: 'AVT 90', width: 320, height: 240, durationMs: 90000, implemented: true },
  { engineIndex: 6, name: 'Scottie 1', width: 320, height: 256, durationMs: 109624, implemented: true },
  { engineIndex: 7, name: 'Scottie 2', width: 320, height: 256, durationMs: 71089, implemented: true },
  { engineIndex: 8, name: 'ScottieDX', width: 320, height: 256, durationMs: 268876, implemented: true },
  { engineIndex: 9, name: 'Martin 1', width: 320, height: 256, durationMs: 114290, implemented: true },
  { engineIndex: 10, name: 'Martin 2', width: 320, height: 256, durationMs: 58060, implemented: true },
  { engineIndex: 11, name: 'SC2 180', width: 320, height: 256, durationMs: 182027, implemented: true },
  { engineIndex: 12, name: 'SC2 120', width: 320, height: 256, durationMs: 121733, implemented: true },
  { engineIndex: 13, name: 'SC2 60', width: 320, height: 256, durationMs: 61538, implemented: true },
  { engineIndex: 14, name: 'PD50', width: 320, height: 256, durationMs: 49684, implemented: true },
  { engineIndex: 15, name: 'PD90', width: 320, height: 256, durationMs: 89989, implemented: true },
  { engineIndex: 16, name: 'PD120', width: 640, height: 496, durationMs: 126103, implemented: true },
  { engineIndex: 17, name: 'PD160', width: 512, height: 400, durationMs: 160883, implemented: true },
  { engineIndex: 18, name: 'PD180', width: 640, height: 496, durationMs: 187051, implemented: true },
  { engineIndex: 19, name: 'PD240', width: 640, height: 496, durationMs: 248000, implemented: true },
  { engineIndex: 20, name: 'PD290', width: 800, height: 616, durationMs: 288682, implemented: true },
  { engineIndex: 21, name: 'P3', width: 640, height: 496, durationMs: 203050, implemented: true },
  { engineIndex: 22, name: 'P5', width: 640, height: 496, durationMs: 304575, implemented: true },
  { engineIndex: 23, name: 'P7', width: 640, height: 496, durationMs: 406100, implemented: true },
  { engineIndex: 24, name: 'MP73', width: 320, height: 256, durationMs: 72960, implemented: true },
  { engineIndex: 25, name: 'MP115', width: 320, height: 256, durationMs: 115456, implemented: true },
  { engineIndex: 26, name: 'MP140', width: 320, height: 256, durationMs: 139520, implemented: true },
  { engineIndex: 27, name: 'MP175', width: 320, height: 256, durationMs: 175360, implemented: true },
  { engineIndex: 28, name: 'MR73', width: 320, height: 256, durationMs: 73292, implemented: true },
  { engineIndex: 29, name: 'MR90', width: 320, height: 256, durationMs: 90188, implemented: true },
  { engineIndex: 30, name: 'MR115', width: 320, height: 256, durationMs: 115276, implemented: true },
  { engineIndex: 31, name: 'MR140', width: 320, height: 256, durationMs: 140364, implemented: true },
  { engineIndex: 32, name: 'MR175', width: 320, height: 256, durationMs: 175180, implemented: true },
  { engineIndex: 33, name: 'ML180', width: 640, height: 496, durationMs: 180196, implemented: true },
  { engineIndex: 34, name: 'ML240', width: 640, height: 496, durationMs: 239716, implemented: true },
  { engineIndex: 35, name: 'ML280', width: 640, height: 496, durationMs: 280388, implemented: true },
  { engineIndex: 36, name: 'ML320', width: 640, height: 496, durationMs: 320068, implemented: true },
  { engineIndex: 37, name: 'MP73-N', width: 320, height: 256, durationMs: 72960, implemented: true },
  { engineIndex: 38, name: 'MP110-N', width: 320, height: 256, durationMs: 109824, implemented: true },
  { engineIndex: 39, name: 'MP140-N', width: 320, height: 256, durationMs: 139520, implemented: true },
  { engineIndex: 40, name: 'MC110-N', width: 320, height: 256, durationMs: 109696, implemented: true },
  { engineIndex: 41, name: 'MC140-N', width: 320, height: 256, durationMs: 140416, implemented: true },
  { engineIndex: 42, name: 'MC180-N', width: 320, height: 256, durationMs: 180352, implemented: true },
];

/**
 * @typedef {Object} Segment
 * @property {string} type        - SegType
 * @property {number} durationMs  - 段时长(毫秒)
 * @property {?string} channel    - 'R'|'G'|'B' | 'Y'|'Cr'|'Cb',仅 SCAN
 * @property {?number} freq       - 固定频率,SCAN 段为 null
 */

/**
 * 一行扫描线时长(ms)
 */
function lineDuration(segs) {
  return segs.reduce((s, seg) => s + seg.durationMs, 0);
}

// ---- Martin 族 ----
// 每行: SYNC(4.862ms) + sync porch(0.572ms) + G(146.432) + sep(0.572) + B(146.432) + sep(0.572) + R(146.432)
const MARTIN1_LINE = [
  { type: SegType.SYNC,      durationMs: 4.862,  freq: FREQ.SYNC },
  { type: SegType.PORCH,     durationMs: 0.572,  freq: FREQ.BLACK },
  { type: SegType.SCAN,      durationMs: 146.432, channel: 'G' },
  { type: SegType.PORCH,     durationMs: 0.572,  freq: FREQ.BLACK },
  { type: SegType.SCAN,      durationMs: 146.432, channel: 'B' },
  { type: SegType.PORCH,     durationMs: 0.572,  freq: FREQ.BLACK },
  { type: SegType.SCAN,      durationMs: 146.432, channel: 'R' },
];

function martinMode(visCode, name, scanMs) {
  // Martin2/DX: 仅 SCAN 段时长不同,porch/sync 相同
  const line = MARTIN1_LINE.map(s =>
    s.type === SegType.SCAN ? { ...s, durationMs: scanMs } : s
  );
  return {
    visCode, name, width: 320, height: 256,
    colorSpace: ColorSpace.RGB, family: 'martin',
    lineSegments: line,
    lineDurationMs: lineDuration(line),
    needsInitialSync: false,
    // SYNC 在行首(index 0),脉冲起点 = 行起点;到首个 SCAN 的偏移 = SYNC+porch
    syncAtLineStart: true,
    syncToFirstScanMs: 4.862 + 0.572,
  };
}

// ---- Scottie 族 ----
// 行结构(同步在行尾): G(138.240) + sep(1.522) + B(138.240) + sep(1.522) + R(138.240) + sync porch(1.522) + SYNC(9.0)
// Scottie 第一行前需一个起始同步脉冲(由 needsInitialSync 标记)
const SCOTTIE1_LINE = [
  { type: SegType.SCAN,        durationMs: 138.240, channel: 'G' },
  { type: SegType.PORCH,       durationMs: 1.522,   freq: FREQ.BLACK },
  { type: SegType.SCAN,        durationMs: 138.240, channel: 'B' },
  { type: SegType.PORCH,       durationMs: 1.522,   freq: FREQ.BLACK },
  { type: SegType.SCAN,        durationMs: 138.240, channel: 'R' },
  { type: SegType.SYNC_PORCH,  durationMs: 1.522,   freq: FREQ.BLACK },
  { type: SegType.SYNC,        durationMs: 9.0,     freq: FREQ.SYNC },
];

function scottieMode(visCode, name, scanMs) {
  const line = SCOTTIE1_LINE.map(s =>
    s.type === SegType.SCAN ? { ...s, durationMs: scanMs } : s
  );
  return {
    visCode, name, width: 320, height: 256,
    colorSpace: ColorSpace.RGB, family: 'scottie',
    lineSegments: line,
    lineDurationMs: lineDuration(line),
    needsInitialSync: true,  // Scottie 首行前需起始同步脉冲(9ms SYNC + 1.5ms porch)
    // SYNC 在行末。脉冲 i 是行 i 末尾的 SYNC;其后 9.0ms(SYNC 时长)是下一行 G 起点
    // (Scottie 行末 SYNC 后无 porch,直接接下一行 G)
    syncAtLineStart: false,
    syncToFirstScanMs: 9.0,
    firstScanAfterVisMs: 9.0 + 1.522,
  };
}

// ---- SC2 族 ----
// 与 Scottie 一样是 GBR 顺序、同步在行尾，但使用 5ms SYNC 与独立的
// front/back porch。时长来自 RXSSTV mmsGetModeLength 运行时探针。
function sc2Mode(visCode, name, imageDurationMs) {
  const syncMs = 5.0, frontPorchMs = 1.0, backPorchMs = 1.0, blankMs = 1.0;
  const scanMs = (imageDurationMs / 256 - syncMs - frontPorchMs - backPorchMs - 2 * blankMs) / 3;
  const line = [
    { type: SegType.SCAN,  durationMs: scanMs, channel: 'G' },
    { type: SegType.PORCH, durationMs: blankMs, freq: FREQ.BLACK },
    { type: SegType.SCAN,  durationMs: scanMs, channel: 'B' },
    { type: SegType.PORCH, durationMs: blankMs, freq: FREQ.BLACK },
    { type: SegType.SCAN,  durationMs: scanMs, channel: 'R' },
    { type: SegType.PORCH, durationMs: frontPorchMs, freq: FREQ.BLACK },
    { type: SegType.SYNC,  durationMs: syncMs, freq: FREQ.SYNC },
    { type: SegType.PORCH, durationMs: backPorchMs, freq: FREQ.BLACK },
  ];
  return {
    visCode, name, width: 320, height: 256,
    colorSpace: ColorSpace.RGB, family: 'sc2', lineSegments: line,
    lineDurationMs: lineDuration(line), needsInitialSync: false,
    syncAtLineStart: false,
    firstScanAfterVisMs: 0,
    syncToFirstScanMs: syncMs + backPorchMs,
  };
}

// ---- P 系列 ----
// P3/P5/P7 是逐行 RGB（R,G,B）格式，行尾同步；其时长与同步/空白参数来自
// RXSSTV 运行时目录及公开 SSTV 规范的交叉验证。
function pMode(visCode, name, syncMs, porchMs, imageDurationMs) {
  const lineMs = imageDurationMs / 496;
  const scanMs = (lineMs - syncMs - 4 * porchMs) / 3;
  const line = [
    { type: SegType.PORCH, durationMs: porchMs, freq: FREQ.BLACK },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'R' },
    { type: SegType.PORCH, durationMs: porchMs, freq: FREQ.BLACK },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'G' },
    { type: SegType.PORCH, durationMs: porchMs, freq: FREQ.BLACK },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'B' },
    { type: SegType.PORCH, durationMs: porchMs, freq: FREQ.BLACK },
    { type: SegType.SYNC, durationMs: syncMs, freq: FREQ.SYNC },
  ];
  return {
    visCode, name, width: 640, height: 496,
    colorSpace: ColorSpace.RGB, family: 'p', lineSegments: line,
    lineDurationMs: lineDuration(line), needsInitialSync: false,
    syncAtLineStart: false, firstScanAfterVisMs: porchMs,
    syncToFirstScanMs: syncMs + porchMs,
  };
}

// ---- AVT 90 ----
// AVT 没有可用于逐行锁定的同步脉冲，图像在 VIS 后按固定时钟连续扫描。
// 发送顺序为 G/B/R；行尾的 1200Hz 段仅供传统 AVT 发送端使用，接收端不锁定它。
function avt90Mode() {
  const lineMs = 90000 / 240;
  const syncMs = 5.0, blankMs = 0.5;
  const scanMs = (lineMs - syncMs - 2 * blankMs) / 3;
  const line = [
    { type: SegType.SCAN, durationMs: scanMs, channel: 'G' },
    { type: SegType.PORCH, durationMs: blankMs, freq: FREQ.BLACK },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'B' },
    { type: SegType.PORCH, durationMs: blankMs, freq: FREQ.BLACK },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'R' },
    { type: SegType.SYNC, durationMs: syncMs, freq: FREQ.SYNC },
  ];
  return {
    visCode: 68, name: 'AVT 90', width: 320, height: 240,
    colorSpace: ColorSpace.RGB, family: 'avt', lineSegments: line,
    lineDurationMs: lineDuration(line), needsInitialSync: false,
    noSync: true, firstScanAfterVisMs: 0,
  };
}

// ---- 黑白族 ----
// 单亮度扫描,每行 BP -> scan -> FP -> SYNC。VIS 高位为校验位,
// 因此 B/W 8/12 的 7 位码分别为 2/6。
function bwMode(visCode, name, imageDurationMs, frontPorchMs, backPorchMs) {
  const syncMs = 6.0;
  const scanMs = imageDurationMs / 120 - syncMs - frontPorchMs - backPorchMs;
  const line = [
    { type: SegType.PORCH, durationMs: backPorchMs, freq: FREQ.BLACK },
    { type: SegType.SCAN,  durationMs: scanMs, channel: 'Y' },
    { type: SegType.PORCH, durationMs: frontPorchMs, freq: FREQ.BLACK },
    { type: SegType.SYNC,  durationMs: syncMs, freq: FREQ.SYNC },
  ];
  return {
    visCode, name, width: 160, height: 120,
    colorSpace: ColorSpace.GRAY, family: 'bw', lineSegments: line,
    lineDurationMs: lineDuration(line), needsInitialSync: false,
    syncAtLineStart: false,
    firstScanAfterVisMs: backPorchMs,
    syncToFirstScanMs: syncMs + backPorchMs,
  };
}

// ---- Robot family ----
// Robot 36 compatibility path retained from the previous decoder. Its 1.5-ms
// chroma porch is represented by the decoder scan guard, while chroma type is
// selected by row parity rather than separator-marker detection.
const ROBOT36_LINE = [
  { type: SegType.SYNC,  durationMs: 9.0,  freq: FREQ.SYNC },
  { type: SegType.PORCH, durationMs: 3.0,  freq: FREQ.BLACK },
  { type: SegType.SCAN,  durationMs: 88.0, channel: 'Y' },
  { type: SegType.PORCH, durationMs: 4.5, freq: FREQ.BLACK },
  { type: SegType.SCAN,  durationMs: 44.0, channel: 'CHROMA' },
];

function robot36Mode() {
  return {
    visCode: 8, name: 'Robot 36', width: 320, height: 240,
    colorSpace: ColorSpace.YUV, family: 'robot',
    lineSegments: ROBOT36_LINE,
    lineDurationMs: lineDuration(ROBOT36_LINE),
    needsInitialSync: false,
    syncAtLineStart: true,
    syncToFirstScanMs: 9.0 + 3.0,
    linePll: true,
    interlace: { fields: 2 },
    chromaAlternate: true,
    robot36Legacy: true,
    syncPeriodMs: 150.0,
  };
}

// Robot 72: complete Y, V (R-Y) and U (B-Y) on every 300-ms line.
const ROBOT72_LINE = [
  { type: SegType.SYNC, durationMs: 9.0, freq: FREQ.SYNC },
  { type: SegType.PORCH, durationMs: 3.0, freq: FREQ.BLACK },
  { type: SegType.SCAN, durationMs: 138.0, channel: 'Y' },
  { type: SegType.SEPARATOR, durationMs: 4.5, freq: FREQ.BLACK },
  { type: SegType.PORCH, durationMs: 1.5, freq: FREQ.VIS_START },
  { type: SegType.SCAN, durationMs: 69.0, channel: 'Cr' },
  { type: SegType.SEPARATOR, durationMs: 4.5, freq: FREQ.BLACK },
  { type: SegType.PORCH, durationMs: 1.5, freq: FREQ.VIS_START },
  { type: SegType.SCAN, durationMs: 69.0, channel: 'Cb' },
];

function robot72Mode() {
  return {
    visCode: 12, name: 'Robot 72', width: 320, height: 240,
    colorSpace: ColorSpace.YUV, family: 'robot', lineYuv: true,
    lineSegments: ROBOT72_LINE,
    lineDurationMs: lineDuration(ROBOT72_LINE),
    needsInitialSync: false,
    syncAtLineStart: true,
    syncToFirstScanMs: 9.0 + 3.0,
    linePll: true,
  };
}

// Robot 24 使用每行完整的 Y、Cr、Cb，而不是 Robot 36/72 的逐行交替色度。
// 一个亮度段是单个色度段的两倍，因而总行时长恰为四个色度单位。
function robot24Mode() {
  const syncMs = 6.0, backPorchMs = 1.2, blankMs = 3.8, frontPorchMs = 0;
  const lineMs = 24000 / 120;
  const chromaMs = (lineMs - syncMs - backPorchMs - frontPorchMs - 2 * blankMs) / 4;
  const line = [
    { type: SegType.PORCH, durationMs: backPorchMs, freq: FREQ.BLACK },
    { type: SegType.SCAN,  durationMs: chromaMs * 2, channel: 'Y' },
    { type: SegType.PORCH, durationMs: blankMs, freq: FREQ.BLACK },
    { type: SegType.SCAN,  durationMs: chromaMs, channel: 'Cr' },
    { type: SegType.PORCH, durationMs: blankMs, freq: FREQ.BLACK },
    { type: SegType.SCAN,  durationMs: chromaMs, channel: 'Cb' },
    { type: SegType.PORCH, durationMs: frontPorchMs, freq: FREQ.BLACK },
    { type: SegType.SYNC,  durationMs: syncMs, freq: FREQ.SYNC },
  ];
  return {
    visCode: 4, name: 'Robot 24', width: 160, height: 120,
    colorSpace: ColorSpace.YUV, family: 'robot', lineYuv: true,
    lineSegments: line, lineDurationMs: lineDuration(line), needsInitialSync: false,
    syncAtLineStart: false, firstScanAfterVisMs: backPorchMs,
    syncToFirstScanMs: syncMs + backPorchMs,
  };
}

// MMSSTV MR 家族使用 Robot 24 式的每行 Y/Cr/Cb，但采用扩展 VIS 和 9ms 同步。
function mrMode(visCode, name, width, height, imageDurationMs) {
  const syncMs = 9.0, backPorchMs = 1.0;
  const lineMs = imageDurationMs / height;
  const chromaMs = (lineMs - syncMs - backPorchMs) / 4;
  const line = [
    { type: SegType.PORCH, durationMs: backPorchMs, freq: FREQ.BLACK },
    { type: SegType.SCAN, durationMs: chromaMs * 2, channel: 'Y' },
    { type: SegType.SCAN, durationMs: chromaMs, channel: 'Cr' },
    { type: SegType.SCAN, durationMs: chromaMs, channel: 'Cb' },
    { type: SegType.SYNC, durationMs: syncMs, freq: FREQ.SYNC },
  ];
  return {
    visCode, name, width, height,
    colorSpace: ColorSpace.YUV, family: 'mr', lineYuv: true,
    lineSegments: line, lineDurationMs: lineDuration(line), needsInitialSync: false,
    syncAtLineStart: false, firstScanAfterVisMs: backPorchMs,
    syncToFirstScanMs: syncMs + backPorchMs,
  };
}

// ---- PD 时序 ----
// 每个数据行承载两条显示行：Y(偶数)、Cr、Cb、Y(奇数)。Cr/Cb 在这一对
// 亮度行之间共享，因此属于 4:2:0 采样。20ms 同步脉冲位于行尾。
function pdMode(visCode, name, width, height, dataLines, imageDurationMs, backPorchMs, frontPorchMs = 0) {
  const syncMs = 20.0;
  const scanMs = (imageDurationMs / dataLines - syncMs - backPorchMs - frontPorchMs) / 4;
  const line = [
    { type: SegType.PORCH, durationMs: backPorchMs, freq: FREQ.BLACK },
    { type: SegType.SCAN,  durationMs: scanMs, channel: 'YODD' },
    { type: SegType.SCAN,  durationMs: scanMs, channel: 'Cr' },
    { type: SegType.SCAN,  durationMs: scanMs, channel: 'Cb' },
    { type: SegType.SCAN,  durationMs: scanMs, channel: 'YEVEN' },
    { type: SegType.PORCH, durationMs: frontPorchMs, freq: FREQ.BLACK },
    { type: SegType.SYNC,  durationMs: syncMs, freq: FREQ.SYNC },
  ];
  return {
    visCode, name, width, height, dataLines,
    colorSpace: ColorSpace.YUV, family: 'pd', lineSegments: line,
    lineDurationMs: lineDuration(line), needsInitialSync: false,
    syncAtLineStart: false, firstScanAfterVisMs: backPorchMs,
    syncToFirstScanMs: syncMs + backPorchMs, pairedLines: true,
  };
}

// MMSSTV MP 家族沿用 PD 的双亮度行/共享色度结构，但使用扩展 VIS 和 9ms 同步。
function mpMode(visCode, name, imageDurationMs) {
  const syncMs = 9.0, backPorchMs = 1.0;
  const scanMs = (imageDurationMs / 128 - syncMs - backPorchMs) / 4;
  const line = [
    { type: SegType.PORCH, durationMs: backPorchMs, freq: FREQ.BLACK },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'YODD' },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'Cr' },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'Cb' },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'YEVEN' },
    { type: SegType.SYNC, durationMs: syncMs, freq: FREQ.SYNC },
  ];
  return {
    visCode, name, width: 320, height: 256, dataLines: 128,
    colorSpace: ColorSpace.YUV, family: 'mp', lineSegments: line,
    lineDurationMs: lineDuration(line), needsInitialSync: false,
    syncAtLineStart: false, firstScanAfterVisMs: backPorchMs,
    syncToFirstScanMs: syncMs + backPorchMs, pairedLines: true,
  };
}

// MMSSTV narrow modes use FSK mode identification, 1900-Hz line sync and a
// compressed 2044..2300-Hz image deviation.
function narrowMpMode(key, fskCode, name, scanMs, bpfLow, bpfHigh) {
  const syncMs = 10;
  const line = [
    { type: SegType.SCAN, durationMs: scanMs, channel: 'YODD' },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'Cr' },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'Cb' },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'YEVEN' },
    { type: SegType.SYNC, durationMs: syncMs, freq: FREQ.NARROW_SYNC },
  ];
  return {
    visCode: key, fskCode, name, width: 320, height: 256, dataLines: 128,
    colorSpace: ColorSpace.YUV, family: 'mn', lineSegments: line,
    lineDurationMs: lineDuration(line), needsInitialSync: false,
    syncAtLineStart: false, firstScanAfterVisMs: 0,
    syncToFirstScanMs: syncMs, pairedLines: true, narrow: true,
    syncFreq: FREQ.NARROW_SYNC, frequencyLow: FREQ.NARROW_BLACK,
    frequencyHigh: FREQ.NARROW_WHITE, bpfLow, bpfHigh,
  };
}

function narrowMcMode(key, fskCode, name, scanMs, bpfLow, bpfHigh) {
  const syncMs = 8, porchMs = 0.5;
  const line = [
    { type: SegType.SCAN, durationMs: scanMs, channel: 'R' },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'G' },
    { type: SegType.SCAN, durationMs: scanMs, channel: 'B' },
    { type: SegType.SYNC, durationMs: syncMs, freq: FREQ.NARROW_SYNC },
    { type: SegType.PORCH, durationMs: porchMs, freq: FREQ.NARROW_BLACK },
  ];
  return {
    visCode: key, fskCode, name, width: 320, height: 256,
    colorSpace: ColorSpace.RGB, family: 'mc', lineSegments: line,
    lineDurationMs: lineDuration(line), needsInitialSync: false,
    syncAtLineStart: false, firstScanAfterVisMs: 0,
    syncToFirstScanMs: syncMs + porchMs, narrow: true,
    syncFreq: FREQ.NARROW_SYNC, frequencyLow: FREQ.NARROW_BLACK,
    frequencyHigh: FREQ.NARROW_WHITE, bpfLow, bpfHigh,
  };
}

// VIS 码(十进制)。来源:公开 SSTV 规范。
// Martin1=44(0x2C) Martin2=40(0x28)
// Scottie1=60(0x3C) Scottie2=56(0x38) ScottieDX=76(0x4C)
// Scottie S1 = Scottie 1 的别名(同 VIS 60,实际接收端按 Scottie1 解)
// Robot36=8(0x08) Robot72=12(0x0C)
export const MODES = {
  2:  bwMode(2,  'B/W 8', 8027, 0.5, 0.5),
  4:  robot24Mode(),
  6:  bwMode(6,  'B/W 12', 12000, 1.5, 0.5),
  55: sc2Mode(55, 'SC2 180', 182027),
  59: sc2Mode(59, 'SC2 60', 61538),
  63: sc2Mode(63, 'SC2 120', 121733),
  68: avt90Mode(),
  113: pMode(113, 'P3', 5.2, 1.04, 203050),
  114: pMode(114, 'P5', 7.8, 1.6, 304575),
  115: pMode(115, 'P7', 10.4, 2.1, 406100),
  44: martinMode(44, 'Martin 1', 146.432),
  40: martinMode(40, 'Martin 2', 73.216),
  60: scottieMode(60, 'Scottie 1', 138.240),
  56: scottieMode(56, 'Scottie 2', 88.064),
  76: scottieMode(76, 'Scottie DX', 345.600),
  8:  robot36Mode(),
  12: robot72Mode(),
  93: pdMode(93, 'PD50', 320, 256, 128, 49684, 2.30),
  99: pdMode(99, 'PD90', 320, 256, 128, 89989, 2.30),
  95: pdMode(95, 'PD120', 640, 496, 248, 126103, 2.30),
  98: pdMode(98, 'PD160', 512, 400, 200, 160883, 2.30),
  96: pdMode(96, 'PD180', 640, 496, 248, 187051, 2.30),
  97: pdMode(97, 'PD240', 640, 496, 248, 248000, 2.30, 2.00),
  94: pdMode(94, 'PD290', 800, 616, 308, 288682, 2.30),
  0x2523: mpMode(0x2523, 'MP73', 72960),
  0x2923: mpMode(0x2923, 'MP115', 115456),
  0x2a23: mpMode(0x2a23, 'MP140', 139520),
  0x2c23: mpMode(0x2c23, 'MP175', 175360),
  0x4523: mrMode(0x4523, 'MR73', 320, 256, 73292),
  0x4623: mrMode(0x4623, 'MR90', 320, 256, 90188),
  0x4923: mrMode(0x4923, 'MR115', 320, 256, 115276),
  0x4a23: mrMode(0x4a23, 'MR140', 320, 256, 140364),
  0x4c23: mrMode(0x4c23, 'MR175', 320, 256, 175180),
  0x8523: mrMode(0x8523, 'ML180', 640, 496, 180196),
  0x8623: mrMode(0x8623, 'ML240', 640, 496, 239716),
  0x8923: mrMode(0x8923, 'ML280', 640, 496, 280388),
  0x8a23: mrMode(0x8a23, 'ML320', 640, 496, 320068),
  0x1022d: narrowMpMode(0x1022d, 0x02, 'MP73-N', 140, 1600, 2500),
  0x1042d: narrowMpMode(0x1042d, 0x04, 'MP110-N', 212, 1600, 2500),
  0x1052d: narrowMpMode(0x1052d, 0x05, 'MP140-N', 270, 1700, 2400),
  0x1142d: narrowMcMode(0x1142d, 0x14, 'MC110-N', 140, 1600, 2500),
  0x1152d: narrowMcMode(0x1152d, 0x15, 'MC140-N', 180, 1650, 2500),
  0x1162d: narrowMcMode(0x1162d, 0x16, 'MC180-N', 232, 1700, 2400),
};

// Scottie S1 别名(指向 Scottie 1)
MODES['S1'] = { ...MODES[60], name: 'Scottie S1', aliasOf: 60 };

export function getMode(visCode) {
  return MODES[visCode] || null;
}

export function listModes() {
  return Object.values(MODES).filter(m => typeof m.visCode === 'number' && !m.aliasOf);
}

// 默认采样率(生成与解码统一)
export const DEFAULT_SAMPLE_RATE = 44100;
