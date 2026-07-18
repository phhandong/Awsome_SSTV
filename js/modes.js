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
};

// 亮度 0..255 → 频率 1500(黑)..2300(白),线性
export function pixelToFreq(v) {
  return FREQ.BLACK + (v / 255) * (FREQ.WHITE - FREQ.BLACK);
}
// 频率 → 亮度(钳位)
export function freqToPixel(f) {
  if (f < FREQ.BLACK) f = FREQ.BLACK;
  if (f > FREQ.WHITE) f = FREQ.WHITE;
  return Math.round((f - FREQ.BLACK) / (FREQ.WHITE - FREQ.BLACK) * 255);
}

// 段类型
export const SegType = {
  SYNC: 'sync',            // 1200Hz 同步脉冲
  PORCH: 'porch',          // 1500Hz 黑电平(后沿/分隔)
  SYNC_PORCH: 'syncporch', // Scottie:同步后的短黑电平
  SCAN: 'scan',            // 图像扫描,频率随像素亮度变化
};

export const ColorSpace = { RGB: 'rgb', YUV: 'yuv' };

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
  };
}

// ---- Robot 族(YUV,隔行双场 + Cr/Cb 逐行交替)----
// Robot 36: 320x240,帧=2场(奇/偶行)。每行: SYNC(9) + porch(3) + Y(88) + sep porch(4.5) + 单色度(44)
// 色度 Cr/Cb 逐行交替(行0发Cr,行1发Cb,行2发Cr...),所以行周期 ~148.5ms ≈ 150ms(实测吻合)。
// 两行才传完一组 YCrCb。
const ROBOT36_LINE = [
  { type: SegType.SYNC,  durationMs: 9.0,  freq: FREQ.SYNC },
  { type: SegType.PORCH, durationMs: 3.0,  freq: FREQ.BLACK },
  { type: SegType.SCAN,  durationMs: 88.0, channel: 'Y' },
  { type: SegType.PORCH, durationMs: 4.5,  freq: FREQ.BLACK },  // separator porch
  { type: SegType.SCAN,  durationMs: 44.0, channel: 'CHROMA' },  // Cr 或 Cb,逐行交替
];

function robotMode(visCode, name, width, height, yMs, chromaMs) {
  const line = ROBOT36_LINE.map(s => {
    if (s.channel === 'Y') return { ...s, durationMs: yMs };
    if (s.channel)         return { ...s, durationMs: chromaMs };
    return s;
  });
  return {
    visCode, name, width, height,
    colorSpace: ColorSpace.YUV, family: 'robot',
    lineSegments: line,
    lineDurationMs: lineDuration(line),
    needsInitialSync: false,
    interlace: { fields: 2 },  // 奇场(y=0,2,4..) + 偶场(y=1,3,5..)
    syncAtLineStart: true,
    syncToFirstScanMs: 9.0 + 3.0,
    chromaAlternate: true,  // Cr/Cb 逐行交替(行偶数发Cr,奇数发Cb)
  };
}

// VIS 码(十进制)。来源:公开 SSTV 规范。
// Martin1=44(0x2C) Martin2=40(0x28)
// Scottie1=60(0x3C) Scottie2=56(0x38) ScottieDX=76(0x4C)
// Scottie S1 = Scottie 1 的别名(同 VIS 60,实际接收端按 Scottie1 解)
// Robot36=8(0x08) Robot72=12(0x0C)
export const MODES = {
  44: martinMode(44, 'Martin 1', 146.432),
  40: martinMode(40, 'Martin 2', 73.216),
  60: scottieMode(60, 'Scottie 1', 138.240),
  56: scottieMode(56, 'Scottie 2', 88.064),
  76: scottieMode(76, 'Scottie DX', 345.600),
  8:  robotMode(8,  'Robot 36', 320, 240, 88.0, 44.0),
  12: robotMode(12, 'Robot 72', 320, 240, 138.0, 69.0),
};

// Scottie S1 别名(指向 Scottie 1)
MODES['S1'] = { ...MODES[60], name: 'Scottie S1', aliasOf: 60 };

export function getMode(visCode) {
  return MODES[visCode] || null;
}

export function listModes() {
  // 返回 UI 列表(跳过别名键)
  return Object.values(MODES).filter(m => typeof m.visCode === 'number');
}

// 默认采样率(生成与解码统一)
export const DEFAULT_SAMPLE_RATE = 44100;
