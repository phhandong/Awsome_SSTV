// Receiver robustness smoke test: non-native sample rate plus deterministic noise.
import { getMode } from './js/modes.js';
import { encode } from './js/encoder.js';
import { decode } from './js/decoder.js';

const SAMPLE_RATE = 48000;
const CASES = [
  [4, 19],        // Robot 24: line YUV
  [56, 24],       // Scottie 2: standard VIS RGB
  [93, 17],       // PD50: paired-line YUV
  [0x2523, 17],   // MP73: extended VIS paired-line YUV
  [0x4523, 19],   // MR73: extended VIS line YUV
  [68, 20],       // AVT90: fixed-clock RGB
];

function image(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = Math.round(255 * x / width);
      rgba[i + 1] = Math.round(255 * y / height);
      rgba[i + 2] = Math.round(128 + 127 * Math.sin((x + y) / 30));
      rgba[i + 3] = 255;
    }
  }
  return { rgba };
}

function noisy(samples) {
  const out = new Float32Array(samples.length);
  let state = 0x12345678;
  for (let i = 0; i < samples.length; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    out[i] = samples[i] + (((state >>> 8) / 0x1000000) - 0.5) * 0.0002;
  }
  return out;
}

function psnr(expected, actual) {
  let error = 0, count = 0;
  for (let i = 0; i < expected.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = expected[i + c] - actual[i + c];
      error += d * d;
      count++;
    }
  }
  return 10 * Math.log10(255 * 255 / (error / count));
}

let ok = true;
for (const [vis, minimum] of CASES) {
  const mode = getMode(vis);
  const source = image(mode.width, mode.height);
  const result = decode(noisy(encode(source, mode, { sampleRate: SAMPLE_RATE })), SAMPLE_RATE);
  const score = psnr(source.rgba, result.pixels);
  const pass = score >= minimum;
  console.log(`${mode.name.padEnd(10)} ${score.toFixed(2)}dB ${pass ? 'OK' : 'FAIL'}`);
  ok &&= pass;
}
process.exit(ok ? 0 : 1);
