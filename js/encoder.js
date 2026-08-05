// encoder.js — SSTV 生成器:图片 → PCM 样本
//
// 流程:
//   1. 把图片缩放到 mode.width × mode.height,取 ImageData
//   2. (YUV 模式)RGB→YUV 4:2:2
//   3. 生成 VIS 头
//   4. 逐行:按 lineSegments 顺序合成 SYNC/PORCH(定频)与 SCAN(逐像素调频)
//   5. 相位连续(每样本累加 phase += 2π f/sr),避免边界爆音

import { FREQ, pixelToFreq, SegType, ColorSpace, DEFAULT_SAMPLE_RATE } from './modes.js';
import { visHeaderSegments } from './vis.js';

// 2048 点正弦查表,加速合成
const SIN_LUT = new Float32Array(2048);
for (let i = 0; i < 2048; i++) SIN_LUT[i] = Math.sin(i / 2048 * Math.PI * 2);

// 默认像素获取:DOM/OffscreenCanvas(浏览器)
function defaultImageToRgba(image, width, height) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;  // Uint8ClampedArray RGBA
}

/**
 * @param {ImageBitmap|HTMLImageElement|{rgba:Uint8ClampedArray}} image
 *   若 image 已含 .rgba(width*height*4),则直接用(便于 Node 测试)
 * @param {ModeDescriptor} mode
 * @param {{sampleRate?:number, onProgress?:(p:number)=>void, imageToRgba?:(img,w,h)=>Uint8ClampedArray}} opts
 * @returns {Float32Array} PCM,范围 -1..1
 */
export function encode(image, mode, opts = {}) {
  const sr = opts.sampleRate || DEFAULT_SAMPLE_RATE;

  // 1. 取像素数据(缩放到模式尺寸)
  const { width, height } = mode;
  const rgba = image.rgba
    ? image.rgba
    : (opts.imageToRgba || defaultImageToRgba)(image, width, height);

  // 2. 预估总样本数,分配缓冲
  const visMs = 610;  // VIS 头总时长
  const lineCount = mode.dataLines || height;
  const totalMs = visMs + mode.lineDurationMs * lineCount * (mode.interlace ? mode.interlace.fields : 1);
  const totalSamples = Math.ceil(totalMs * sr / 1000) + sr;  // +1s 余量
  const samples = new Float32Array(totalSamples);

  // 相位累加器(连续)
  const phaseRef = { phase: 0 };

  let n = 0;  // 已写入样本数

  // 3. VIS 头
  for (const seg of visHeaderSegments(mode.visCode)) {
    n = appendTone(samples, n, seg.freq, seg.durationMs, sr, phaseRef);
  }

  // 4. Scottie 首行前置同步(needsInitialSync)
  if (mode.needsInitialSync) {
    n = appendTone(samples, n, FREQ.SYNC, 9.0, sr, phaseRef);
    n = appendTone(samples, n, FREQ.BLACK, 1.5, sr, phaseRef);
  }

  // 5. 逐行
  if (mode.colorSpace === ColorSpace.YUV && mode.interlace) {
    // Robot 36/72:实测真实 MMSSTV 信号为逐行顺序发送(脉冲 i → 图像行 i),
    // 非奇偶分场。encoder 与 decoder 均按逐行,与真实信号对齐。
    for (let y = 0; y < height; y++) {
      n = appendLine(samples, n, mode, rgba, y, sr, phaseRef);
      if (opts.onProgress && (y % 16 === 0)) opts.onProgress(y / height);
    }
  } else {
    for (let y = 0; y < lineCount; y++) {
      n = appendLine(samples, n, mode, rgba, y, sr, phaseRef);
      if (opts.onProgress && (y % 16 === 0)) opts.onProgress(y / lineCount);
    }
  }

  if (opts.onProgress) opts.onProgress(1);

  // 裁剪到实际写入长度
  return samples.subarray(0, n);
}

// 合成一整行
function appendLine(samples, n, mode, rgba, y, sr, phaseRef) {
  const { width } = mode;
  for (const seg of mode.lineSegments) {
    if (seg.type === SegType.SCAN) {
      // 取该行该通道的像素值数组(0..255)
      const chanPixels = extractChannel(rgba, mode, y, seg.channel, width);
      n = appendScan(samples, n, chanPixels, seg.durationMs, sr, phaseRef);
    } else {
      // SYNC / PORCH / SYNC_PORCH:定频
      n = appendTone(samples, n, seg.freq, seg.durationMs, sr, phaseRef);
    }
  }
  return n;
}

// 从 RGBA 提取一行某通道的像素值
function extractChannel(rgba, mode, y, channel, width) {
  const out = new Float32Array(width);
  if (mode.colorSpace === ColorSpace.GRAY) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      out[x] = yuvY(rgba[off], rgba[off + 1], rgba[off + 2]);
    }
    return out;
  }
  if (mode.colorSpace === ColorSpace.RGB) {
    const off = channel === 'R' ? 0 : channel === 'G' ? 1 : 2;
    for (let x = 0; x < width; x++) out[x] = rgba[(y * width + x) * 4 + off];
    return out;
  }
  // YUV:Y 全分辨率;Cr/Cb 水平 2:1 下采样后映射回 width
  // Robot 系 Cr/Cb 逐行交替(channel='CHROMA'):行 y 偶发 Cr,奇发 Cb
  if (channel === 'Y' || channel === 'YODD' || channel === 'YEVEN') {
    const sourceY = channel === 'YODD' ? y * 2 : channel === 'YEVEN' ? y * 2 + 1 : y;
    for (let x = 0; x < width; x++) {
      const r = rgba[(sourceY * width + x) * 4], g = rgba[(sourceY * width + x) * 4 + 1], b = rgba[(sourceY * width + x) * 4 + 2];
      out[x] = yuvY(r, g, b);  // 0..255
    }
  } else {
    const wantCr = channel === 'Cr' || (channel === 'CHROMA' && (y % 2 === 0));
    for (let x = 0; x < width; x++) {
      const sourceY = mode.pairedLines ? y * 2 : y;
      const off0 = (sourceY * width + x) * 4;
      const off1 = mode.pairedLines ? ((sourceY + 1) * width + x) * 4 : off0;
      const value0 = wantCr ? yuvCr(rgba[off0], rgba[off0 + 1], rgba[off0 + 2]) : yuvCb(rgba[off0], rgba[off0 + 1], rgba[off0 + 2]);
      const value1 = wantCr ? yuvCr(rgba[off1], rgba[off1 + 1], rgba[off1 + 2]) : yuvCb(rgba[off1], rgba[off1 + 1], rgba[off1 + 2]);
      out[x] = (value0 + value1) / 2;
    }
  }
  return out;
}

// BT.601 YUV,范围 Y:0..255,Cr/Cb:0..255(中心128)
function yuvY(r, g, b)  { return  0.299 * r + 0.587 * g + 0.114 * b; }
function yuvCr(r, g, b) { return 128 + 0.5 * (r - (0.299 * r + 0.587 * g + 0.114 * b)); }
function yuvCb(r, g, b) { return 128 + 0.5 * (b - (0.299 * r + 0.587 * g + 0.114 * b)); }

// 追加定频音调
function appendTone(samples, n, freq, durationMs, sr, phaseRef) {
  const num = Math.floor(durationMs * sr / 1000);
  const phaseInc = 2 * Math.PI * freq / sr;
  for (let i = 0; i < num; i++) {
    samples[n++] = sinLut(phaseRef.phase);
    phaseRef.phase += phaseInc;
    if (phaseRef.phase >= 2 * Math.PI) phaseRef.phase -= 2 * Math.PI;
  }
  return n;
}

// 追加扫描段:逐像素调频,相位连续
function appendScan(samples, n, pixels, durationMs, sr, phaseRef) {
  const count = pixels.length;
  const totalSamples = Math.floor(durationMs * sr / 1000);
  // 每像素占的样本数(浮点,均分)
  const perPixel = totalSamples / count;
  for (let x = 0; x < count; x++) {
    const freq = pixelToFreq(pixels[x]);
    const start = n + x * perPixel;
    const end = (x === count - 1) ? n + totalSamples : n + (x + 1) * perPixel;
    const sStart = Math.floor(start), sEnd = Math.floor(end);
    const phaseInc = 2 * Math.PI * freq / sr;
    for (let i = sStart; i < sEnd; i++) {
      samples[i] = sinLut(phaseRef.phase);
      phaseRef.phase += phaseInc;
      if (phaseRef.phase >= 2 * Math.PI) phaseRef.phase -= 2 * Math.PI;
    }
  }
  return n + totalSamples;
}

function sinLut(phase) {
  const idx = (phase / (2 * Math.PI)) * 2048;
  return SIN_LUT[((idx | 0) & 2047)];
}
