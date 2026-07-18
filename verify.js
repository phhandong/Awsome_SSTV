// verify.js — Node 端闭环验证:encode → WAV 往返 → decode → PSNR
// 用法: node verify.js

import { MODES, getMode, DEFAULT_SAMPLE_RATE } from './js/modes.js';
import { encode } from './js/encoder.js';
import { decode } from './js/decoder.js';
import { encodeWAV, decodeWAV } from './js/wav.js';

function makeTestImage(width, height) {
  // 程序生成测试图:渐变 + 色块 + 灰阶
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // 渐变
      let r = Math.round(255 * x / width);
      let g = Math.round(255 * y / height);
      let b = Math.round(128 + 127 * Math.sin((x + y) / 30));
      // 左上角色块区
      if (y < height * 0.2) {
        const band = Math.floor(x / (width / 8));
        const hue = band * 45;
        r = Math.round(127 + 127 * Math.cos(hue * Math.PI / 180));
        g = Math.round(127 + 127 * Math.sin(hue * Math.PI / 180));
        b = Math.round(128);
      }
      // 底部灰阶
      if (y > height * 0.8) {
        const v = Math.round(255 * (x / width));
        r = g = b = v;
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return { rgba };
}

function psnr(a, b) {
  if (a.length !== b.length) return -1;
  let mse = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      mse += d * d; n++;
    }
  }
  mse /= n;
  if (mse === 0) return 99;
  return 10 * Math.log10(255 * 255 / mse);
}

async function testMode(visCode) {
  const mode = getMode(visCode);
  if (!mode) { console.log('  未知模式', visCode); return; }
  const { width, height } = mode;
  const img = makeTestImage(width, height);

  // 编码
  const t0 = Date.now();
  const pcm = encode(img, mode, { sampleRate: DEFAULT_SAMPLE_RATE });
  const encMs = Date.now() - t0;

  // WAV 往返
  const wav = encodeWAV(pcm, DEFAULT_SAMPLE_RATE);
  const { samples, sampleRate } = decodeWAV(wav);

  // 解码
  const t1 = Date.now();
  const result = decode(samples, sampleRate);
  const decMs = Date.now() - t1;

  const p = psnr(img.rgba, result.pixels);
  const ok = (mode.family === 'robot') ? p >= 20 : p >= 25;
  console.log(`  ${mode.name.padEnd(12)} ${width}×${height} ${mode.colorSpace}  ` +
    `音频 ${(pcm.length / DEFAULT_SAMPLE_RATE).toFixed(1)}s  ` +
    `编${encMs}ms 解${decMs}ms  PSNR=${p.toFixed(2)}dB ${ok ? '✓' : '⚠'}`);
  return { mode, p, ok };
}

console.log('Awesome SSTV 闭环验证');
console.log('采样率:', DEFAULT_SAMPLE_RATE, 'Hz');
console.log('-'.repeat(70));
let allOk = true;
for (const m of Object.values(MODES)) {
  if (typeof m.visCode !== 'number') continue;
  try {
    const r = await testMode(m.visCode);
    if (r && !r.ok) allOk = false;
  } catch (e) {
    console.log(`  ${m.name}: 失败 — ${e.message}`);
    allOk = false;
  }
}
console.log('-'.repeat(70));
console.log(allOk ? '全部通过 ✓' : '存在未达标项 ⚠');
process.exit(allOk ? 0 : 1);
