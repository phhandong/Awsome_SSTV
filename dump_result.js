// dump_result.js — 解码 MP3 并导出 PPM 图像(肉眼核对)
import { readFileSync, writeFileSync } from 'fs';
import { MPEGDecoder } from 'mpg123-decoder';
import { decode } from './js/decoder.js';
import { sliceFromStart } from './js/audiodecode.js';

const dec = new MPEGDecoder(); await dec.ready;
const { channelData, sampleRate } = dec.decode(readFileSync('./asset/ROBOT36_test.mp3'));
try { dec.free && dec.free(); } catch (_) {}
const len = channelData[0].length;
const mono = new Float32Array(len);
for (let i = 0; i < len; i++) { let s = 0; for (let c = 0; c < channelData.length; c++) s += channelData[c][i]; mono[i] = s / channelData.length; }

// 从 1.5s 开始解码(跳过前导杂讯)
const sr = 44100;
import('./js/demod.js').then(async ({ resample }) => {
  const pcm44 = resample(mono, sampleRate, sr);
  const sliced = sliceFromStart(pcm44, sr, 1.5);
  const result = decode(sliced, sr);
  console.log('解码:', result.mode.name, result.width + 'x' + result.height);

  // 写 PPM
  const { width: w, height: h, pixels } = result;
  let ppm = `P3\n${w} ${h}\n255\n`;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      ppm += `${pixels[i]} ${pixels[i+1]} ${pixels[i+2]} `;
    }
    ppm += '\n';
  }
  writeFileSync('./asset/robot36_decoded.ppm', ppm);
  console.log('已写出 asset/robot36_decoded.ppm');

  // 也写一份缩略统计:每 20 行的像素均值
  for (let y = 0; y < h; y += 20) {
    let r = 0, g = 0, b = 0, c = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      r += pixels[i]; g += pixels[i+1]; b += pixels[i+2]; c++;
    }
    console.log(`  行${y}: R${(r/c).toFixed(0)} G${(g/c).toFixed(0)} B${(b/c).toFixed(0)}`);
  }
});
