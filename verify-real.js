// verify-real.js - RXSSTV real-signal compatibility check.
// Decodes the bundled Robot 36 MP3 and compares its block-level image structure
// with a reference image produced by the original RXSSTV application.

import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { MPEGDecoder } from 'mpg123-decoder';
import { PNG } from 'pngjs';
import { decode } from './js/decoder.js';
import { SSTVReceiver } from './js/receiver.js';
import { sliceFromStart } from './js/audiodecode.js';

const BLOCK_SIZE = 16;
const CASES = [
  {
    name: 'ROBOT36_test.mp3',
    audioPath: './asset/ROBOT36_test.mp3',
    referencePath: './asset/robot36_decoded_standard.jpg',
    referenceType: 'jpeg',
    startSeconds: 1.5,
    dsp: { engine: 'mmsstv', bpf: false, afc: true },
    minimumLuma: 0.90,
    minimumRgb: 0.74,
  },
  {
    name: 'ROBOT36_11052142.mp3 (AFC+BPF)',
    audioPath: './asset/voicerecord/processed/ROBOT36_11052142.mp3',
    referencePath: './asset/sstv_Robot_36_1786281618189.png',
    referenceType: 'png',
    startSeconds: 0,
    dsp: { engine: 'mmsstv', bpf: true, afc: true },
    minimumLuma: 0.99,
    minimumRgb: 0.99,
  },
  {
    name: 'ROBOT36_11052142.mp3 (AFC, no BPF)',
    audioPath: './asset/voicerecord/processed/ROBOT36_11052142.mp3',
    referencePath: './asset/sstv_Robot_36_1786281618189.png',
    referenceType: 'png',
    startSeconds: 0,
    dsp: { engine: 'mmsstv', bpf: false, afc: true },
    minimumLuma: 0.995,
    minimumRgb: 0.995,
  },
];

function monoFromChannels(channelData) {
  const mono = new Float32Array(channelData[0].length);
  for (let i = 0; i < mono.length; i++) {
    let value = 0;
    for (const channel of channelData) value += channel[i];
    mono[i] = value / channelData.length;
  }
  return mono;
}

async function decodeMp3Mono(path) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  const { channelData, sampleRate } = decoder.decode(readFileSync(path));
  try { decoder.free?.(); } catch (_) {}
  return { samples: monoFromChannels(channelData), sampleRate };
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

console.log('RXSSTV real-signal compatibility');
let allOk = true;
for (const testCase of CASES) {
  const { samples: mono, sampleRate } = await decodeMp3Mono(testCase.audioPath);
  const work = testCase.startSeconds
    ? sliceFromStart(mono, sampleRate, testCase.startSeconds)
    : mono;
  const decoded = decode(work, sampleRate, { dsp: testCase.dsp });
  const reference = testCase.referenceType === 'png'
    ? PNG.sync.read(readFileSync(testCase.referencePath))
    : jpeg.decode(readFileSync(testCase.referencePath), { useTArray: true });

  if (decoded.mode.name !== 'Robot 36' || decoded.width !== 320 || decoded.height !== 240) {
    throw new Error(`${testCase.name}: unexpected decode ${decoded.mode.name} ${decoded.width}x${decoded.height}`);
  }
  if (decoded.dsp.demodulator !== 'legacy') {
    throw new Error(`${testCase.name}: compatibility demodulator changed to ${decoded.dsp.demodulator}`);
  }
  if (reference.width !== decoded.width || reference.height !== decoded.height) {
    throw new Error(`${testCase.name}: reference dimensions differ ${reference.width}x${reference.height}`);
  }

  const actual = { width: decoded.width, height: decoded.height, data: decoded.pixels };
  const luma = blockCorrelation(reference, actual, -1, BLOCK_SIZE);
  const rgb = [0, 1, 2].map(channel => blockCorrelation(reference, actual, channel, BLOCK_SIZE));
  const passed = luma >= testCase.minimumLuma && rgb.every(value => value >= testCase.minimumRgb);
  console.log(`  ${passed ? 'PASS' : 'FAIL'} ${testCase.name}: ` +
    `luma=${luma.toFixed(6)} rgb=${rgb.map(value => value.toFixed(6)).join('/')}`);
  allOk &&= passed;
}

// The final low-SNR seconds used to inject hundreds of false 1200-Hz pulse
// candidates. A global Robot clock refit then rewrote even the already-good
// top of the image when the complete file replaced the 38.3-second partial
// frame. Completed rows must be byte-identical, not merely similar after
// block averaging, while the receiver continues through the noisy tail.
{
  const { samples, sampleRate } = await decodeMp3Mono('./asset/ROBOT36_test.mp3');
  const dsp = { engine: 'mmsstv', afc: true, lms: true, bpf: true };
  const prefix = decode(samples.subarray(0, Math.round(38.3 * sampleRate)), sampleRate, { dsp });
  const complete = decode(samples, sampleRate, { dsp });
  const reference = jpeg.decode(readFileSync('./asset/robot36_decoded_standard.jpg'), { useTArray: true });
  const stableHeight = 236;
  const prefixView = { width: prefix.width, height: stableHeight, data: prefix.pixels };
  const completeView = { width: complete.width, height: stableHeight, data: complete.pixels };
  const stableLuma = blockCorrelation(prefixView, completeView, -1, BLOCK_SIZE);
  const stableRgb = [0, 1, 2].map(channel =>
    blockCorrelation(prefixView, completeView, channel, BLOCK_SIZE));
  const fullLuma = blockCorrelation(
    reference,
    { width: complete.width, height: complete.height, data: complete.pixels },
    -1,
    BLOCK_SIZE
  );
  let changedChannels = 0;
  let absoluteDifference = 0;
  const stableBytes = stableHeight * complete.width * 4;
  for (let offset = 0; offset < stableBytes; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(prefix.pixels[offset + channel] - complete.pixels[offset + channel]);
      absoluteDifference += difference;
      if (difference !== 0) changedChannels++;
    }
  }
  const stableMae = absoluteDifference / (stableHeight * complete.width * 3);
  const receiver = new SSTVReceiver({ dsp, emitFrames: true, renderEveryRows: 40 });
  const partialFrames = [];
  receiver.on('frame', event => {
    if (event.partial) partialFrames.push({ rows: event.rows, pixels: event.result.pixels.slice() });
  });
  const chunkSize = Math.floor(sampleRate / 2);
  for (let offset = 0; offset < samples.length; offset += chunkSize) {
    receiver.push(samples.subarray(offset, Math.min(samples.length, offset + chunkSize)), sampleRate);
  }
  const streamed = receiver.end();
  let streamChangedChannels = 0;
  for (const frame of partialFrames) {
    const completedRows = Math.max(0, Math.min(frame.rows - 2, streamed.height));
    const completedBytes = completedRows * streamed.width * 4;
    for (let offset = 0; offset < completedBytes; offset += 4) {
      for (let channel = 0; channel < 3; channel++) {
        if (frame.pixels[offset + channel] !== streamed.pixels[offset + channel]) streamChangedChannels++;
      }
    }
  }
  const passed = changedChannels === 0 && stableMae === 0 &&
    partialFrames.length >= 4 && streamChangedChannels === 0 &&
    stableLuma >= 0.99 && stableRgb.every(value => value >= 0.99) && fullLuma >= 0.90;
  console.log(`  ${passed ? 'PASS' : 'FAIL'} ROBOT36_test.mp3 tail stability (AFC+LMS+BPF): ` +
    `prefix=${stableLuma.toFixed(6)} rgb=${stableRgb.map(value => value.toFixed(6)).join('/')} ` +
    `changed=${changedChannels} mae=${stableMae.toFixed(6)} ` +
    `stream=${partialFrames.length}/${streamChangedChannels} full=${fullLuma.toFixed(6)}`);
  allOk &&= passed;
}

// This sync-only recording used to change the whole image hue near 34 s.
// At that point the strong detector crossed 216 observations and replaced
// the weak detector's row grid with one shifted by a full 150-ms Robot line,
// swapping the fixed Cr/Cb parity.  Once the early strong clock is locked,
// a later suffix must not alter any already-completed row.
{
  const { samples, sampleRate } = await decodeMp3Mono(
    './asset/voicerecord/processed/ROBOT36_11052142.mp3'
  );
  const dsp = { engine: 'mmsstv', afc: true, lms: false, bpf: false };
  const prefix = decode(samples.subarray(0, Math.round(33.5 * sampleRate)), sampleRate, { dsp });
  const complete = decode(samples, sampleRate, { dsp });
  const stableRows = 210;
  let changedChannels = 0;
  let absoluteDifference = 0;
  const stableBytes = stableRows * complete.width * 4;
  for (let offset = 0; offset < stableBytes; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(prefix.pixels[offset + channel] - complete.pixels[offset + channel]);
      absoluteDifference += difference;
      if (difference !== 0) changedChannels++;
    }
  }
  const stableMae = absoluteDifference / (stableRows * complete.width * 3);
  const stableLuma = blockCorrelation(
    { width: prefix.width, height: stableRows, data: prefix.pixels },
    { width: complete.width, height: stableRows, data: complete.pixels },
    -1,
    BLOCK_SIZE
  );
  const passed = prefix.acquisition.source === 'sync' && complete.acquisition.source === 'sync' &&
    changedChannels === 0 && stableMae === 0 && stableLuma >= 0.999999;
  console.log(`  ${passed ? 'PASS' : 'FAIL'} ROBOT36_11052142.mp3 no-BPF color stability: ` +
    `prefix=${stableLuma.toFixed(6)} changed=${changedChannels} mae=${stableMae.toFixed(6)}`);
  allOk &&= passed;
}

process.exit(allOk ? 0 : 1);
