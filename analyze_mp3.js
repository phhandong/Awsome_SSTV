// analyze_mp3.js — 用现有 pipeline 解码 ROBOT36_test.mp3,逐步打印诊断
//
// 这是诊断脚本(非项目运行时)。MP3 解码用 mpg123-decoder(WASM),仅此脚本用;
// 项目运行时 MP3 走浏览器 AudioContext.decodeAudioData(见 js/audiodecode.js)。
// 运行前需临时安装:npm install --no-save mpg123-decoder
//
// SSTV pipeline 完全复用 js/ 下的 decoder/demod/vis/modes
//
// 已知结论(见 PIPELINE_ANALYSIS.md):
//   - 该 MP3 起始有前导杂讯,真正 VIS 在 ~1.74s
//   - VIS 头是双 1900Hz leader 结构(237-490ms + 651-842ms,切片内)
//   - 解调相噪使单样本 leader 检测失败,需 ≥2ms 平滑
//   - VIS 码 = 8(Robot 36),与文件名吻合

import { readFileSync } from 'fs';
import { MPEGDecoder } from 'mpg123-decoder';
import { decode } from './js/decoder.js';
import { decodeAudioFile, sliceFromStart } from './js/audiodecode.js';
import { resample, demodulate, findSyncPulses } from './js/demod.js';
import { decodeVISHeader } from './js/vis.js';
import { getMode, DEFAULT_SAMPLE_RATE } from './js/modes.js';

const MP3_PATH = './asset/ROBOT36_test.mp3';

async function main() {
  console.log('=== 1. 读取 MP3 ===');
  const mp3Buf = readFileSync(MP3_PATH);
  console.log('文件:', MP3_PATH, '|', mp3Buf.length, '字节');

  console.log('\n=== 2. MP3 → PCM(mpg123-decoder WASM) ===');
  const dec = new MPEGDecoder();
  await dec.ready;
  const { channelData, sampleRate } = dec.decode(mp3Buf);
  try { dec.free && dec.free(); } catch (_) {}
  const ch = channelData.length;
  // 混单声道
  const len = channelData[0].length;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0; for (let c = 0; c < ch; c++) s += channelData[c][i];
    mono[i] = s / ch;
  }
  console.log('采样率:', sampleRate, 'Hz | 声道:', ch, '| 样本:', len,
    '| 时长:', (len / sampleRate).toFixed(2), 's');

  console.log('\n=== 3. 重采样到 44100Hz(pipeline 第1步) ===');
  const pcm = (sampleRate === DEFAULT_SAMPLE_RATE) ? mono : resample(mono, sampleRate, DEFAULT_SAMPLE_RATE);
  console.log('PCM 样本:', pcm.length, '| 时长:', (pcm.length / DEFAULT_SAMPLE_RATE).toFixed(2), 's');

  console.log('\n=== 4. FM 解调(pipeline 第2步:解析信号瞬时频率) ===');
  const freq = demodulate(pcm, DEFAULT_SAMPLE_RATE);

  // 信号在 ~1.7s 才有真正的 VIS leader,0~1.7s 是前导杂讯。
  // 用起始时间偏移跳到 1.5s(正是 UI 的"起始时间"功能)
  const START_SEC = 1.5;
  console.log(`应用起始时间偏移 ${START_SEC}s(跳过前导杂讯)`);
  const offsetSample = Math.floor(START_SEC * DEFAULT_SAMPLE_RATE);
  const pcmSlice = pcm.subarray(offsetSample);
  const freqSlice = freq.subarray(offsetSample);

  console.log('切片后前 700ms 频率(每 50ms):');
  for (let ms = 0; ms < 700; ms += 50) {
    const f = freqSlice[Math.floor(ms * DEFAULT_SAMPLE_RATE / 1000)];
    process.stdout.write(`  ${ms}ms:${f.toFixed(0)}Hz`);
  }
  console.log('');

  console.log('\n=== 5. VIS 头识别(pipeline 第3步) ===');
  const vis = decodeVISHeader(freqSlice, DEFAULT_SAMPLE_RATE, 0);
  if (!vis) {
    console.log('仍未检测到 VIS 头。');
    process.exit(1);
  }
  console.log('VIS 码(7位):', vis.visCode7, '->', getMode(vis.visCode7)?.name || '未知');
  console.log('图像起始样本:', vis.sampleOffset, '=', (vis.sampleOffset / DEFAULT_SAMPLE_RATE * 1000).toFixed(0), 'ms');

  const mode = getMode(vis.visCode7);
  console.log('模式:', mode.name, mode.width + 'x' + mode.height, mode.colorSpace);

  console.log('\n=== 6. 同步脉冲搜索(pipeline 第4步) ===');
  const minSync = mode.family === 'robot' ? 8.0 : 4.0;
  const pulses = findSyncPulses(freqSlice, DEFAULT_SAMPLE_RATE, minSync);
  const imgPulses = pulses.filter(p => p > vis.sampleOffset);
  console.log('总 1200Hz 脉冲:', pulses.length, '| VIS 后:', imgPulses.length,
    '(Robot36 期望 ~240 = 2场×120行)');
  if (imgPulses.length >= 2) {
    const gap = imgPulses[1] - imgPulses[0];
    console.log('首两个脉冲间距:', (gap / DEFAULT_SAMPLE_RATE * 1000).toFixed(2), 'ms',
      '(行周期期望', mode.lineDurationMs.toFixed(2), 'ms)');
  }

  console.log('\n=== 7. 完整解码(pipeline 第5-6步:逐行重建 + YUV合并) ===');
  const result = decode(pcmSlice, DEFAULT_SAMPLE_RATE);
  console.log('解码结果:', result.width + 'x' + result.height, '| 模式:', result.mode.name);

  // 统计像素分布(确认非全黑/全白)
  let nonBlack = 0, nonWhite = 0;
  for (let i = 0; i < result.pixels.length; i += 4) {
    const r = result.pixels[i], g = result.pixels[i + 1], b = result.pixels[i + 2];
    if (r + g + b > 30) nonBlack++;
    if (r + g + b < 720) nonWhite++;
  }
  const total = result.pixels.length / 4;
  console.log('像素统计:非黑', (nonBlack / total * 100).toFixed(1) + '%, 非白', (nonWhite / total * 100).toFixed(1) + '%');

  console.log('\n=== 结论:pipeline 跑通 ✓ ===');
}

main().catch(e => { console.error('分析失败:', e); process.exit(1); });
