// DSP option checks: AFC lock, CLMS noise reduction, BPF response and switches.
import { applyAFC, demodulate, lmsAdaptiveLineEnhance, makeBandpass } from './js/demod.js';
import { decode } from './js/decoder.js';
import { encode } from './js/encoder.js';
import { DEFAULT_SAMPLE_RATE, getMode } from './js/modes.js';

const sr = DEFAULT_SAMPLE_RATE;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// BPF must reject DC substantially while preserving the SSTV passband.
const h = makeBandpass(sr);
const mid = (h.length - 1) / 2;
const response = frequency => Math.abs(h.reduce(
  (sum, value, n) => sum + value * Math.cos(2 * Math.PI * frequency * (n - mid) / sr), 0
));
assert(response(1700) > response(0) * 100, 'BPF does not reject DC');

// AFC must recover a known leader offset.
const shiftedLeader = new Float32Array(sr).fill(1975);
const afc = applyAFC(shiftedLeader, sr);
assert(afc.locked && Math.abs(afc.offsetHz - 75) < 0.5, 'AFC failed to estimate +75 Hz');
assert(Math.abs(afc.freq[0] - 1900) < 0.5, 'AFC failed to correct leader');

// AFC demodulation must retain headroom before correction; otherwise a
// positive offset clips the 2300-Hz white level at the normal 2400-Hz clamp.
const offsetPcm = new Float32Array(sr * 2);
let phase = 0;
for (let i = 0; i < offsetPcm.length; i++) {
  const frequency = i < sr ? 2100 : 2500; // +200-Hz leader, then white
  offsetPcm[i] = Math.sin(phase);
  phase += 2 * Math.PI * frequency / sr;
}
const offsetTrack = demodulate(offsetPcm, sr, { afc: true, bpf: false });
const offsetCorrection = applyAFC(offsetTrack, sr);
let whiteMean = 0;
for (let i = sr + 1000; i < offsetCorrection.freq.length; i++) whiteMean += offsetCorrection.freq[i];
whiteMean /= offsetCorrection.freq.length - sr - 1000;
assert(Math.abs(whiteMean - 2300) < 2, `AFC clipped white level: ${whiteMean.toFixed(1)} Hz`);

// CLMS must improve a periodic carrier in deterministic broadband noise.
const clean = new Float32Array(sr * 2);
const noisy = new Float32Array(clean.length);
let randomState = 1;
for (let i = 0; i < clean.length; i++) {
  clean[i] = Math.sin(2 * Math.PI * 1900 * i / sr);
  randomState = (1664525 * randomState + 1013904223) >>> 0;
  noisy[i] = clean[i] + (((randomState >>> 8) / 0x1000000) - 0.5) * 0.8;
}
const enhanced = lmsAdaptiveLineEnhance(noisy, sr);
let before = 0, after = 0;
for (let i = 1000; i < clean.length; i++) {
  before += (noisy[i] - clean[i]) ** 2;
  after += (enhanced[i] - clean[i]) ** 2;
}
const improvementDb = 10 * Math.log10(before / after);
assert(improvementDb >= 6, `CLMS improvement too small: ${improvementDb.toFixed(2)} dB`);

// Exercise all switches through the public decoder API.
const mode = getMode(2); // short B/W 8 fixture
const rgba = new Uint8ClampedArray(mode.width * mode.height * 4);
for (let y = 0; y < mode.height; y++) {
  for (let x = 0; x < mode.width; x++) {
    const offset = (y * mode.width + x) * 4;
    const value = Math.round(255 * x / (mode.width - 1));
    rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
}
const pcm = encode({ rgba }, mode, { sampleRate: sr });
const combinations = [
  { afc: false, lms: false, bpf: false },
  { afc: true, lms: false, bpf: true },
  { afc: false, lms: true, bpf: true },
  { afc: true, lms: true, bpf: true },
];
for (const dsp of combinations) {
  const result = decode(pcm, sr, { dsp });
  assert(result.mode.visCode === mode.visCode, `switch combination failed: ${JSON.stringify(dsp)}`);
  assert(result.dsp.afc === dsp.afc && result.dsp.lms === dsp.lms && result.dsp.bpf === dsp.bpf,
    `reported DSP state differs: ${JSON.stringify(dsp)}`);
}

const dry = decode(pcm, sr, { dsp: { afc: false, lms: false, bpf: true } });
const zeroStrength = decode(pcm, sr, {
  dsp: { afc: false, lms: true, bpf: true, lmsOptions: { strength: 0 } },
});
assert(dry.pixels.every((value, i) => value === zeroStrength.pixels[i]),
  'decode() did not forward lmsOptions');

console.log(`DSP checks passed: BPF ${h.length} taps, AFC ${afc.offsetHz.toFixed(1)} Hz, ` +
  `CLMS improvement ${improvementDb.toFixed(2)} dB, switches ${combinations.length}/4`);
