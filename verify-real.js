// verify-real.js - RXSSTV real-signal compatibility check.
// Decodes the bundled Robot 36 MP3 and compares its block-level image structure
// with a reference image produced by the original RXSSTV application.

import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { MPEGDecoder } from 'mpg123-decoder';
import { decode } from './js/decoder.js';
import { resample } from './js/demod.js';
import { sliceFromStart } from './js/audiodecode.js';
import { DEFAULT_SAMPLE_RATE } from './js/modes.js';

const MP3_PATH = './asset/ROBOT36_test.mp3';
const REFERENCE_PATH = './asset/robot36_decoded_standard.jpg';
const START_OFFSET_SECONDS = 1.5;
const BLOCK_SIZE = 16;

function monoFromChannels(channelData) {
  const mono = new Float32Array(channelData[0].length);
  for (let i = 0; i < mono.length; i++) {
    let value = 0;
    for (const channel of channelData) value += channel[i];
    mono[i] = value / channelData.length;
  }
  return mono;
}

function channelValue(data, offset, channel) {
  if (channel >= 0) return data[offset + channel];
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
}

function blockCorrelation(reference, actual, channel, blockSize) {
  const refValues = [];
  const actualValues = [];
  for (let y = 0; y < reference.height; y += blockSize) {
    for (let x = 0; x < reference.width; x += blockSize) {
      let refSum = 0;
      let actualSum = 0;
      let count = 0;
      for (let by = y; by < Math.min(y + blockSize, reference.height); by++) {
        for (let bx = x; bx < Math.min(x + blockSize, reference.width); bx++) {
          const offset = (by * reference.width + bx) * 4;
          refSum += channelValue(reference.data, offset, channel);
          actualSum += channelValue(actual.data, offset, channel);
          count++;
        }
      }
      refValues.push(refSum / count);
      actualValues.push(actualSum / count);
    }
  }

  const refMean = refValues.reduce((sum, value) => sum + value, 0) / refValues.length;
  const actualMean = actualValues.reduce((sum, value) => sum + value, 0) / actualValues.length;
  let covariance = 0;
  let refVariance = 0;
  let actualVariance = 0;
  for (let i = 0; i < refValues.length; i++) {
    const refDelta = refValues[i] - refMean;
    const actualDelta = actualValues[i] - actualMean;
    covariance += refDelta * actualDelta;
    refVariance += refDelta * refDelta;
    actualVariance += actualDelta * actualDelta;
  }
  return covariance / Math.sqrt(refVariance * actualVariance);
}

const decoder = new MPEGDecoder();
await decoder.ready;
const { channelData, sampleRate } = decoder.decode(readFileSync(MP3_PATH));
try { decoder.free?.(); } catch (_) {}

const mono = monoFromChannels(channelData);
const pcm = resample(mono, sampleRate, DEFAULT_SAMPLE_RATE);
const decoded = decode(sliceFromStart(pcm, DEFAULT_SAMPLE_RATE, START_OFFSET_SECONDS), DEFAULT_SAMPLE_RATE, {
  dsp: { engine: 'mmsstv', bpf: true, afc: true },
});
const referenceJpeg = jpeg.decode(readFileSync(REFERENCE_PATH), { useTArray: true });

if (decoded.mode.name !== 'Robot 36' || decoded.width !== 320 || decoded.height !== 240) {
  throw new Error(`unexpected decode: ${decoded.mode.name} ${decoded.width}x${decoded.height}`);
}
if (referenceJpeg.width !== decoded.width || referenceJpeg.height !== decoded.height) {
  throw new Error(`reference dimensions differ: ${referenceJpeg.width}x${referenceJpeg.height}`);
}

const reference = { width: referenceJpeg.width, height: referenceJpeg.height, data: referenceJpeg.data };
const actual = { width: decoded.width, height: decoded.height, data: decoded.pixels };
const luma = blockCorrelation(reference, actual, -1, BLOCK_SIZE);
const rgb = [0, 1, 2].map(channel => blockCorrelation(reference, actual, channel, BLOCK_SIZE));
const meanRgb = rgb.reduce((sum, value) => sum + value, 0) / rgb.length;

console.log('RXSSTV real-signal compatibility');
console.log(`  mode: ${decoded.mode.name} ${decoded.width}x${decoded.height}`);
console.log(`  ${BLOCK_SIZE}x${BLOCK_SIZE} block correlation: luma=${luma.toFixed(3)} rgb=${rgb.map(value => value.toFixed(3)).join('/')}`);

const ok = luma >= 0.90 && meanRgb >= 0.80 && rgb.every(value => value >= 0.75);
console.log(ok ? '  reference structure matches' : '  reference structure mismatch');
process.exit(ok ? 0 : 1);
