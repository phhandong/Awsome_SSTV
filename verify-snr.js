import assert from 'node:assert/strict';
import { StreamingSnrEstimator } from './js/fft.js';
import { WebSSTVDecoder } from './js/web-receiver.js';

const SAMPLE_RATE = 12000;
const SAMPLE_COUNT = SAMPLE_RATE * 2;

function deterministicNoise(length, amplitude, seed = 0x51f15e) {
  const samples = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    samples[i] = ((state >>> 0) / 0x100000000 * 2 - 1) * amplitude;
  }
  return samples;
}

function addTone(samples, frequency, amplitude) {
  const result = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    result[i] = samples[i] + amplitude * Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE);
  }
  return result;
}

function estimate(samples, chunks = [samples.length]) {
  const estimator = new StreamingSnrEstimator(SAMPLE_RATE);
  let result = null;
  let offset = 0;
  let chunkIndex = 0;
  while (offset < samples.length) {
    const requested = chunks[chunkIndex % chunks.length];
    const end = Math.min(samples.length, offset + requested);
    const next = estimator.push(samples.subarray(offset, end));
    if (next !== null) result = next;
    offset = end;
    chunkIndex++;
  }
  assert.notEqual(result, null, 'input should contain at least one complete FFT window');
  return result;
}

const silence = estimate(new Float32Array(SAMPLE_COUNT), [317, 29, 2048, 7]);
assert.equal(silence.snrDb, null, 'silence must not report a numeric SNR');
assert.equal(silence.signalPower, 0);
assert.equal(silence.noisePower, 0);

const noise = deterministicNoise(SAMPLE_COUNT, 0.08);
const noiseResult = estimate(noise, [noise.length]);
assert.ok(noiseResult.snrDb <= 0,
  `white noise should have low SNR, got ${noiseResult.snrDb.toFixed(2)} dB`);

const toneAndNoise = addTone(noise, 1900, 0.25);
const toneResult = estimate(toneAndNoise, [toneAndNoise.length]);
assert.ok(toneResult.snrDb >= noiseResult.snrDb + 10,
  `tone plus noise should be clearly stronger (${toneResult.snrDb.toFixed(2)} vs ${noiseResult.snrDb.toFixed(2)} dB)`);
const expectedSnrDb = 10 * Math.log10(
  (0.25 ** 2 / 2) /
  ((0.08 ** 2 / 3) * ((2800 - 1000) / (SAMPLE_RATE / 2))),
);
assert.ok(Math.abs(toneResult.snrDb - expectedSnrDb) < 1.5,
  `known SNR should be within 1.5 dB (${toneResult.snrDb.toFixed(2)} vs ${expectedSnrDb.toFixed(2)} dB)`);

const wholeResult = estimate(toneAndNoise, [toneAndNoise.length]);
const chunkedResult = estimate(toneAndNoise, [1, 13, 257, 64, 4096, 31, 777]);
assert.ok(Math.abs(wholeResult.snrDb - chunkedResult.snrDb) < 1e-9,
  'SNR must not depend on input chunk boundaries');
assert.ok(Math.abs(wholeResult.signalPower - chunkedResult.signalPower) < 1e-12,
  'signal power must not depend on input chunk boundaries');
assert.ok(Math.abs(wholeResult.noisePower - chunkedResult.noisePower) < 1e-12,
  'noise power must not depend on input chunk boundaries');

class FakeWorker {
  constructor() {
    this.messages = [];
    FakeWorker.instance = this;
  }
  postMessage(message) { this.messages.push(message); }
  terminate() {}
}
globalThis.Worker = FakeWorker;
const receiver = new WebSSTVDecoder();
let receiverSnr = null;
receiver.addEventListener('snr', event => { receiverSnr = event.detail.snrDb; });
receiver.reset({ emitSnr: true, emitFrames: true });
for (let offset = 0; offset < toneAndNoise.length; offset += 317) {
  receiver.push(toneAndNoise.subarray(offset, Math.min(toneAndNoise.length, offset + 317)), SAMPLE_RATE);
}
assert.ok(Number.isFinite(receiverSnr) && receiverSnr > 10,
  `web receiver sidecar must emit a usable SNR event, got ${receiverSnr}`);
const resetMessage = FakeWorker.instance.messages.find(message => message.type === 'reset');
assert.ok(resetMessage && !('emitSnr' in resetMessage.options),
  'display-only emitSnr option must not enter the decoder Worker');
assert.equal(
  FakeWorker.instance.messages.filter(message => message.type === 'push').length,
  Math.ceil(toneAndNoise.length / 317),
  'every audio chunk must still be delivered to the decoder Worker',
);
receiver.destroy();

console.log('SNR estimator verification passed');
console.log(`  silence:  ${silence.snrDb}`);
console.log(`  noise:    ${noiseResult.snrDb.toFixed(2)} dB`);
console.log(`  tone:     ${toneResult.snrDb.toFixed(2)} dB`);
console.log(`  chunked:  ${chunkedResult.snrDb.toFixed(2)} dB`);
