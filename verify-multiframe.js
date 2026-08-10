// Deterministic offline multi-frame decode regressions.
import fs from 'node:fs';
import { encode } from './js/encoder.js';
import { decodeAll } from './js/decoder.js';
import { getMode } from './js/modes.js';
import { decodeVISHeader, visParity } from './js/vis.js';
import { decodeWAV } from './js/wav.js';

function solidImage(mode, value, color = false) {
  const rgba = new Uint8ClampedArray(mode.width * mode.height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = color ? value : value;
    rgba[i + 1] = color ? Math.min(255, value + 35) : value;
    rgba[i + 2] = color ? Math.max(0, value - 25) : value;
    rgba[i + 3] = 255;
  }
  return { rgba };
}

function join(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function meanLuma(pixels) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    count++;
  }
  return sum / count;
}

function close(actual, expected, tolerance = 0.1) {
  return Math.abs(actual - expected) <= tolerance;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dsp = {
  engine: 'mmsstv',
  demodulator: 'phase',
  afc: true,
  lms: true,
  bpf: false,
};

function testLongGapAndOrder() {
  const sampleRate = 44100;
  const mode = getMode(2);
  const first = encode(solidImage(mode, 32), mode, { sampleRate });
  const second = encode(solidImage(mode, 224), mode, { sampleRate });
  const gap = new Float32Array(sampleRate * 6);
  const pcm = join(first, gap, second);
  const progress = [];
  const output = decodeAll(pcm, sampleRate, { dsp, onProgress: value => progress.push(value) });

  assert(output.frames.length === 2, `long-gap count: ${output.frames.length}`);
  assert(meanLuma(output.frames[0].result.pixels) < meanLuma(output.frames[1].result.pixels), 'frame order');
  assert(close(output.frames[0].audioRange.startSample / sampleRate, 0), 'first start time');
  assert(close(output.frames[1].audioRange.startSample / sampleRate, (first.length + gap.length) / sampleRate), 'second start time');
  assert(output.frames.every(frame => frame.complete && frame.completionRatio === 1), 'complete frames');
  assert(progress.length > 1 && progress.at(-1) === 1, 'progress reaches 100%');
  assert(progress.every((value, index) => index === 0 || value >= progress[index - 1]), 'progress is monotonic');
}

function testNoGapAndTruncatedTail() {
  const sampleRate = 48000;
  const mode = getMode(2);
  const complete = encode(solidImage(mode, 70), mode, { sampleRate });
  const sourceTail = encode(solidImage(mode, 190), mode, { sampleRate });
  const truncated = sourceTail.slice(0, Math.floor(sourceTail.length * 0.62));
  const pcm = join(complete, truncated);
  const output = decodeAll(pcm, sampleRate, { dsp });

  assert(output.frames.length === 2, `no-gap count: ${output.frames.length}`);
  assert(output.frames[0].complete, 'first no-gap frame complete');
  assert(!output.frames[1].complete, 'truncated frame retained');
  assert(output.frames[1].completionRatio > 0.45 && output.frames[1].completionRatio < 0.75, 'partial ratio');
  assert(output.frames[1].audioRange.endSample === pcm.length, 'partial end uses available audio');
  const bottom = (mode.height - 1) * mode.width * 4;
  assert(output.frames[1].result.pixels[bottom] < 8, 'missing rows stay black');
}

function testPairedLines() {
  const sampleRate = 44100;
  const mode = getMode(93);
  const frame = encode(solidImage(mode, 105, true), mode, { sampleRate });
  const output = decodeAll(join(frame, frame), sampleRate, { dsp });

  assert(output.frames.length === 2, `PD paired-line count: ${output.frames.length}`);
  assert(output.frames.every(item => item.result.mode.visCode === mode.visCode), 'PD mode lock');
  assert(close(output.frames[1].audioRange.startSample / sampleRate, frame.length / sampleRate), 'PD second start');
}

function testHeaderFamilies() {
  const sampleRate = 11025;
  for (const code of [0x2523, 0x1022d, 56, 68]) {
    const mode = getMode(code);
    const pcm = encode(solidImage(mode, 95, true), mode, { sampleRate });
    const output = decodeAll(pcm, sampleRate, { dsp });
    assert(output.frames.length === 1, `${mode.name} frame count`);
    assert(output.frames[0].result.mode.visCode === mode.visCode, `${mode.name} mode`);
    assert(output.frames[0].complete, `${mode.name} complete`);
    assert(close(output.frames[0].audioRange.startSample / sampleRate, 0), `${mode.name} header start`);
  }
}

function makeVisFrequency({ doubleLeader = false, delayedStopMs = 0, badParity = false, stop = true } = {}) {
  const sampleRate = 11025;
  const segments = [];
  const push = (frequency, durationMs) => {
    const count = Math.floor(durationMs * sampleRate / 1000);
    for (let i = 0; i < count; i++) segments.push(frequency);
  };
  push(1900, 300);
  if (doubleLeader) {
    push(1200, 10);
    push(1900, 300);
  }
  push(1200, 40);
  const code = 8;
  let byte = code | (visParity(code) << 7);
  if (badParity) byte ^= 0x80;
  for (let bit = 0; bit < 8; bit++) push(byte & (1 << bit) ? 1100 : 1300, 30);
  if (delayedStopMs) push(1300, delayedStopMs);
  push(stop ? 1200 : 1500, 30);
  push(1500, 100);
  return { frequency: Float32Array.from(segments), sampleRate };
}

function testDelayedVisStopRecovery() {
  const delayed = makeVisFrequency({ doubleLeader: true, delayedStopMs: 40 });
  const recovered = decodeVISHeader(delayed.frequency, delayed.sampleRate);
  assert(recovered?.visCode7 === 8, 'delayed double-leader VIS mode');
  assert(recovered.recoveredStop === true, 'delayed stop recovery metadata');
  assert(close(recovered.stopDelaySamples / delayed.sampleRate, 0.04, 0.005), 'delayed stop timing');

  const standard = makeVisFrequency();
  const strict = decodeVISHeader(standard.frequency, standard.sampleRate);
  assert(strict?.visCode7 === 8 && strict.recoveredStop === false, 'standard VIS remains strict');
  assert(decodeVISHeader(
    makeVisFrequency({ delayedStopMs: 40 }).frequency,
    standard.sampleRate
  ) === null, 'single-leader delayed stop rejected');
  assert(decodeVISHeader(
    makeVisFrequency({ doubleLeader: true, delayedStopMs: 40, badParity: true }).frequency,
    standard.sampleRate
  ) === null, 'bad parity delayed stop rejected');
  assert(decodeVISHeader(
    makeVisFrequency({ doubleLeader: true, stop: false }).frequency,
    standard.sampleRate
  ) === null, 'missing stop rejected');
}

function testHeaderlessSyncFamilies() {
  const sampleRate = 11025;
  const headerSamples = Math.round(0.610 * sampleRate);
  for (const code of [8, 44, 56, 93, 2]) {
    const mode = getMode(code);
    const encoded = encode(solidImage(mode, 110, true), mode, { sampleRate });
    const payload = encoded.slice(headerSamples);
    const output = decodeAll(join(payload, payload), sampleRate, { mode: code, dsp });
    assert(output.frames.length === 2, `${mode.name} headerless consecutive count`);
    assert(output.frames.every(frame => frame.result.mode.visCode === mode.visCode), `${mode.name} mode lock`);
  }
}

function testHeaderlessNoisyGap() {
  const sampleRate = 11025;
  const mode = getMode(8);
  const encoded = encode(solidImage(mode, 115, true), mode, { sampleRate });
  const payload = encoded.slice(Math.round(0.610 * sampleRate));
  const noise = new Float32Array(sampleRate * 2);
  let state = 12345;
  for (let i = 0; i < noise.length; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    noise[i] = (state / 0x100000000 * 2 - 1) * 0.04;
  }
  const output = decodeAll(join(payload, noise, payload), sampleRate, { mode: mode.visCode, dsp });
  assert(output.frames.length === 2, `headerless noisy-gap count: ${output.frames.length}`);
  assert(close(
    output.frames[1].audioRange.imageStartSample / sampleRate,
    (payload.length + noise.length) / sampleRate
  ), 'headerless noisy-gap boundary');
}

function testHeaderlessPartialThreshold() {
  const sampleRate = 11025;
  const mode = getMode(8);
  const encoded = encode(solidImage(mode, 120, true), mode, { sampleRate });
  const payload = encoded.slice(Math.round(0.610 * sampleRate));
  const encodedLineSamples = payload.length / mode.height;
  let rejected = false;
  try {
    decodeAll(payload.slice(0, Math.round(encodedLineSamples * 48)), sampleRate, { mode: mode.visCode, dsp });
  } catch (_) {
    rejected = true;
  }
  assert(rejected, 'headerless fragment below 20% rejected');
  const accepted = decodeAll(
    payload.slice(0, Math.round(encodedLineSamples * 49)),
    sampleRate,
    { mode: mode.visCode, dsp }
  );
  assert(accepted.frames.length === 1, 'headerless 20% boundary retained');
  assert(close(accepted.frames[0].completionRatio, 0.20, 0.001), 'headerless 20% ratio');
  assert(!accepted.frames[0].complete, 'headerless boundary marked incomplete');
}

function imageCorrelation(first, second) {
  let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0, count = 0;
  for (let i = 0; i < first.length && i < second.length; i += 64) {
    const x = first[i];
    const y = second[i];
    sumX += x; sumY += y; sumXX += x * x; sumYY += y * y; sumXY += x * y; count++;
  }
  const covariance = count * sumXY - sumX * sumY;
  const scale = Math.sqrt((count * sumXX - sumX * sumX) * (count * sumYY - sumY * sumY));
  return scale > 0 ? covariance / scale : 1;
}

function testRealRobot36Pair() {
  const path = new URL('./asset/voicerecord/processed/ROBOT36_2files.wav', import.meta.url);
  const buffer = fs.readFileSync(path);
  const wav = decodeWAV(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const output = decodeAll(wav.samples, wav.sampleRate, { dsp });
  assert(output.frames.length === 2, `real Robot36 count: ${output.frames.length}`);
  assert(output.frames.every(frame => frame.result.mode.visCode === 8), 'real Robot36 mode');
  assert(output.frames.every(frame => frame.result.reconstruction.completedRows === 240), 'real Robot36 rows');
  assert(close(output.frames[0].audioRange.imageStartSample / wav.sampleRate, 1.8288), 'real first timing');
  assert(close(output.frames[1].audioRange.imageStartSample / wav.sampleRate, 50.6294), 'real second timing');
  assert(imageCorrelation(output.frames[0].result.pixels, output.frames[1].result.pixels) < 0.9, 'real images differ');
}

const tests = [
  ['long gap, order, ranges and monotonic progress', testLongGapAndOrder],
  ['no gap and truncated final frame', testNoGapAndTruncatedTail],
  ['PD paired-line consecutive frames', testPairedLines],
  ['extended VIS, narrow FSK, Scottie and AVT headers', testHeaderFamilies],
  ['strict and delayed VIS stop handling', testDelayedVisStopRecovery],
  ['headerless consecutive sync families', testHeaderlessSyncFamilies],
  ['headerless noisy-gap recovery', testHeaderlessNoisyGap],
  ['headerless partial 20% threshold', testHeaderlessPartialThreshold],
  ['real two-frame Robot36 recording', testRealRobot36Pair],
];

let failed = false;
for (const [name, test] of tests) {
  try {
    test();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
if (failed) process.exit(1);
