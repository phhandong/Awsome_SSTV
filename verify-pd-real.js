// Native-rate PD120 real-recording regression against bundled BMP references.
import { readFileSync } from 'node:fs';
import { MPEGDecoder } from 'mpg123-decoder';
import { decode } from './js/decoder.js';
import { SSTVReceiver } from './js/receiver.js';

const CASES = [
  ['PD120_10041455.mp3', 'PD12010041455.bmp'],
  ['PD120_10060829.mp3', 'PD12010060829.bmp'],
];
const VIS_CASES = [
  'PD120_10041145.mp3',
  'PD120_10061007.mp3',
];
const ROOT = './asset/voicerecord/processed';
const BLOCK = 16;

function monoFromChannels(channels) {
  const mono = new Float32Array(channels[0].length);
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    mono[i] = sum / channels.length;
  }
  return mono;
}

async function loadMp3Mono(audioName) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  const audio = decoder.decode(readFileSync(`${ROOT}/${audioName}`));
  try { decoder.free?.(); } catch (_) {}
  return { samples: monoFromChannels(audio.channelData), sampleRate: audio.sampleRate };
}

function decodeBmp24(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint16(0, true) !== 0x4d42) throw new Error('not a BMP file');
  const dataOffset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const height = Math.abs(signedHeight);
  const bits = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (bits !== 24 || compression !== 0 || width <= 0 || height <= 0) {
    throw new Error(`unsupported BMP: ${width}x${signedHeight} ${bits}bpp compression=${compression}`);
  }
  const stride = (width * 3 + 3) & ~3;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = signedHeight > 0 ? height - 1 - y : y;
    const row = dataOffset + sourceY * stride;
    for (let x = 0; x < width; x++) {
      const source = row + x * 3;
      const target = (y * width + x) * 4;
      data[target] = buffer[source + 2];
      data[target + 1] = buffer[source + 1];
      data[target + 2] = buffer[source];
      data[target + 3] = 255;
    }
  }
  return { width, height, data };
}

function luminance(data, offset) {
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
}

function blockCorrelation(reference, actual, dy) {
  const actualData = actual.pixels ?? actual.data;
  const refValues = [];
  const actualValues = [];
  for (let y = 0; y < reference.height; y += BLOCK) {
    const actualY = y + dy;
    if (actualY < 0 || actualY + BLOCK > actual.height) continue;
    for (let x = 0; x < reference.width; x += BLOCK) {
      let refSum = 0, actualSum = 0, count = 0;
      for (let by = 0; by < BLOCK && y + by < reference.height; by++) {
        for (let bx = 0; bx < BLOCK && x + bx < reference.width; bx++) {
          refSum += luminance(reference.data, ((y + by) * reference.width + x + bx) * 4);
          actualSum += luminance(actualData, ((actualY + by) * actual.width + x + bx) * 4);
          count++;
        }
      }
      refValues.push(refSum / count);
      actualValues.push(actualSum / count);
    }
  }
  const refMean = refValues.reduce((sum, value) => sum + value, 0) / refValues.length;
  const actualMean = actualValues.reduce((sum, value) => sum + value, 0) / actualValues.length;
  let covariance = 0, refVariance = 0, actualVariance = 0;
  for (let i = 0; i < refValues.length; i++) {
    const x = refValues[i] - refMean;
    const y = actualValues[i] - actualMean;
    covariance += x * y;
    refVariance += x * x;
    actualVariance += y * y;
  }
  return covariance / Math.sqrt(refVariance * actualVariance);
}

let ok = true;
for (const [audioName, bmpName] of CASES) {
  const audio = await loadMp3Mono(audioName);
  const result = decode(audio.samples, audio.sampleRate);
  const reference = decodeBmp24(readFileSync(`${ROOT}/${bmpName}`));
  if (result.mode.name !== 'PD120' || result.width !== reference.width || result.height !== reference.height ||
      result.dsp.demodulator !== 'phase' || result.acquisition.source !== 'vis' ||
      result.acquisition.visCode7 !== 95) {
    throw new Error(`${audioName}: unexpected ${result.mode.name} ${result.width}x${result.height}`);
  }
  let best = { correlation: -1, dy: 0 };
  for (let dy = -16; dy <= 16; dy++) {
    const correlation = blockCorrelation(reference, result, dy);
    if (correlation > best.correlation) best = { correlation, dy };
  }
  const passed = best.correlation >= 0.70;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${audioName}: luma=${best.correlation.toFixed(3)} dy=${best.dy} ` +
    `lineOffset=${result.dsp.lineOffsetMeanHz.toFixed(1)}Hz/${result.dsp.lineOffsetValid}`);
  ok &&= passed;
}

// These recordings contain two short, leader-like 1900-Hz plateaus before
// their real double VIS leader. The receiver must reject those candidates and
// keep searching instead of waiting for a late line-sync fallback. Seven
// seconds mirrors the bounded real-time acquisition probe.
for (const audioName of VIS_CASES) {
  const audio = await loadMp3Mono(audioName);
  const firstSevenSeconds = audio.samples.subarray(0, Math.round(7 * audio.sampleRate));
  for (const bpf of [false, true]) {
    const receiver = new SSTVReceiver({
      autoSync: true,
      dsp: { engine: 'mmsstv', bpf, afc: false, lms: false },
      emitFrames: false,
    });
    const chunkSize = Math.round(audio.sampleRate / 4);
    let receivedSamples = 0;
    for (let offset = 0; offset < firstSevenSeconds.length && !receiver.mode; offset += chunkSize) {
      const chunk = firstSevenSeconds.subarray(offset, Math.min(offset + chunkSize, firstSevenSeconds.length));
      receiver.push(chunk, audio.sampleRate);
      receivedSamples += chunk.length;
    }
    const lockSeconds = receivedSamples / audio.sampleRate;
    const passed = receiver.mode?.name === 'PD120' && receiver.header?.source === 'vis' &&
      receiver.header?.visCode7 === 95 && lockSeconds <= 5;
    console.log(`${passed ? 'PASS' : 'FAIL'} ${audioName}: ` +
      `VIS ${bpf ? 'BPF' : 'no-BPF'} source=${receiver.header?.source || 'none'} ` +
      `offset=${receiver.header ? (receiver.header.sampleOffset / 11025).toFixed(3) + 's' : 'n/a'} ` +
      `lock=${lockSeconds.toFixed(2)}s`);
    ok &&= passed;
  }
}

process.exit(ok ? 0 : 1);
