import { encode } from './js/encoder.js';
import { getMode } from './js/modes.js';
import { MMSSTVCPLL, StreamingResampler } from './js/mmsstv-dsp.js';
import { SSTVReceiver } from './js/receiver.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sourceRate = 48000;
const tone = new Float32Array(sourceRate);
for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2 * Math.PI * 1900 * i / sourceRate);
const wholeResampler = new StreamingResampler();
const whole = wholeResampler.process(tone, sourceRate);
const chunkedResampler = new StreamingResampler();
const chunks = [];
for (let i = 0; i < tone.length; i += 733) chunks.push(chunkedResampler.process(tone.subarray(i, i + 733), sourceRate));
const joined = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
let joinedOffset = 0;
for (const chunk of chunks) { joined.set(chunk, joinedOffset); joinedOffset += chunk.length; }
assert(Math.abs(whole.length - joined.length) <= 1, 'streaming resampler changed output length');
for (let i = 0; i < Math.min(whole.length, joined.length); i++) {
  assert(Math.abs(whole[i] - joined[i]) < 1e-5, `streaming resampler discontinuity at ${i}`);
}

for (const frequency of [1200, 1500, 1900, 2100, 2300]) {
  const pll = new MMSSTVCPLL(11025);
  let sum = 0, count = 0;
  for (let i = 0; i < 11025; i++) {
    const value = pll.process(Math.sin(2 * Math.PI * frequency * i / 11025));
    if (i > 6000) { sum += 1900 - (value / 32768) * 800; count++; }
  }
  assert(Math.abs(sum / count - frequency) < 3, `CPLL failed to lock ${frequency} Hz`);
}

function image(mode) {
  const rgba = new Uint8ClampedArray(mode.width * mode.height * 4);
  for (let y = 0; y < mode.height; y++) for (let x = 0; x < mode.width; x++) {
    const i = (y * mode.width + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.round(255 * x / mode.width);
    rgba[i + 3] = 255;
  }
  return { rgba };
}

for (const key of [2, 0x1022d]) {
  const mode = getMode(key);
  const pcm = encode(image(mode), mode, { sampleRate: 11025 });
  const receiver = new SSTVReceiver({ dsp: { engine: 'legacy', bpf: true }, emitFrames: false });
  let locked = false, rows = 0;
  receiver.on('locked', event => { locked = event.mode === mode; });
  receiver.on('row', event => { rows = event.rows; });
  for (let i = 0; i < pcm.length; i += 997) receiver.push(pcm.subarray(i, i + 997), 11025);
  const result = receiver.end();
  assert(locked, `${mode.name} did not emit locked`);
  assert(rows >= mode.height * 0.95, `${mode.name} emitted too few rows: ${rows}`);
  assert(result.mode === mode, `${mode.name} stream decoded as ${result.mode.name}`);
}

console.log('Streaming checks passed: resampler continuity, CPLL tones, standard and narrow receivers');
