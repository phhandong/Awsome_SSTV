// DSP option checks: AFC lock, CLMS noise reduction, BPF response and switches.
import {
  applyAFC, demodulate, demodulatePhase, lmsAdaptiveLineEnhance,
  makeBandpass, makeBasebandLowpass,
} from './js/demod.js';
import { decode, estimateLineFrequencyOffsets } from './js/decoder.js';
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

// The complex-baseband LPF must preserve the translated carrier and reject
// energy well outside the selected half-bandwidth.
const basebandFir = makeBasebandLowpass(sr, 900);
const basebandMid = (basebandFir.length - 1) / 2;
const basebandResponse = frequency => Math.hypot(
  basebandFir.reduce((sum, value, n) =>
    sum + value * Math.cos(2 * Math.PI * frequency * (n - basebandMid) / sr), 0),
  basebandFir.reduce((sum, value, n) =>
    sum - value * Math.sin(2 * Math.PI * frequency * (n - basebandMid) / sr), 0),
);
assert(basebandResponse(0) > basebandResponse(3000) * 30,
  'complex-baseband LPF does not reject out-of-band energy');

// Native-rate complex phase demodulation must preserve all protocol anchors.
for (const phaseSr of [44100, 48000, 96000]) {
  for (const toneHz of [1200, 1500, 1900, 2300]) {
    const tone = new Float32Array(Math.round(phaseSr * 0.08));
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2 * Math.PI * toneHz * i / phaseSr);
    const phase = demodulatePhase(tone, phaseSr);
    let mean = 0, count = 0;
    for (let i = Math.round(phaseSr * 0.03); i < phase.freq.length; i++) {
      mean += phase.freq[i]; count++;
    }
    mean /= count;
    assert(Math.abs(mean - toneHz) < 2, `phase demod ${phaseSr}/${toneHz}Hz -> ${mean.toFixed(2)}Hz`);
  }
}
const customTone = new Float32Array(Math.round(sr * 0.08));
for (let i = 0; i < customTone.length; i++) customTone[i] = Math.sin(2 * Math.PI * 2100 * i / sr);
const customPhase = demodulatePhase(customTone, sr, { baseband: { lowHz: 1100, highHz: 2500 } });
assert(customPhase.centerHz === 1800 && customPhase.lowHz === 1100 && customPhase.highHz === 2500,
  'custom baseband range was not applied');
const fadedTone = Float32Array.from(customTone, sample => sample * 0.01);
const fadedPhase = demodulatePhase(fadedTone, sr, { baseband: { lowHz: 1100, highHz: 2500 } });
let fadedMean = 0;
for (let i = Math.round(sr * 0.03); i < fadedPhase.freq.length; i++) fadedMean += fadedPhase.freq[i];
fadedMean /= fadedPhase.freq.length - Math.round(sr * 0.03);
assert(Math.abs(fadedMean - 2100) < 2, `phase demod failed amplitude fade: ${fadedMean.toFixed(2)}Hz`);

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
const defaultResult = decode(pcm, sr);
assert(defaultResult.dsp.bpf === false && defaultResult.dsp.demodulator === 'phase' &&
  defaultResult.dsp.baseband.lowHz === 1000 && defaultResult.dsp.baseband.highHz === 2800,
  'decoder DSP defaults are not phase/1000-2800/BPF-off');
const legacyResult = decode(pcm, sr, { dsp: { demodulator: 'legacy', engine: 'mmsstv', bpf: false } });
assert(legacyResult.mode.visCode === mode.visCode && legacyResult.dsp.demodulator === 'legacy',
  'hidden legacy demodulator fallback failed');
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

// Per-line sync calibration: reject one outlier, smooth valid neighbors and
// fill the invalid line from the nearest calibrated line.
const robot = getMode(8);
const offsetSr = 11025;
const firstScanStarts = [0, 1, 2, 3, 4].map(line =>
  Math.round((12 + line * robot.lineDurationMs) * offsetSr / 1000));
const offsetFreq = new Float32Array(Math.ceil(5 * robot.lineDurationMs * offsetSr / 1000)).fill(1500);
const injectedOffsets = [100, 110, 500, 120, 130];
for (let line = 0; line < firstScanStarts.length; line++) {
  const syncStart = firstScanStarts[line] - Math.round(12 * offsetSr / 1000);
  const syncEnd = syncStart + Math.round(9 * offsetSr / 1000);
  offsetFreq.fill(1200 + injectedOffsets[line], Math.max(0, syncStart), Math.min(offsetFreq.length, syncEnd));
}
const lineCalibration = estimateLineFrequencyOffsets(offsetFreq, robot, firstScanStarts, offsetSr, 0);
assert(lineCalibration.validCount === 4 && Math.abs(lineCalibration.offsets[2] - 105) < 1,
  'per-line frequency offset rejection/fallback failed');

console.log(`DSP checks passed: BPF ${h.length} taps, AFC ${afc.offsetHz.toFixed(1)} Hz, ` +
  `phase 3 rates, line offsets ${lineCalibration.validCount}/5, ` +
  `CLMS improvement ${improvementDb.toFixed(2)} dB, switches ${combinations.length}/4`);
