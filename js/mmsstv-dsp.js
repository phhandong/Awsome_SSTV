// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright 2000-2013 Makoto Mori, Nobuyuki Oba
// JavaScript adaptation copyright 2026 Awesome SSTV contributors
//
// Behavioral port of the receiver DSP in MMSSTV sstv.cpp/fir.cpp.

export const MMSSTV_SAMPLE_RATE = 11025;

export class StreamingResampler {
  constructor(outputRate = MMSSTV_SAMPLE_RATE) {
    this.outputRate = outputRate;
    this.reset();
  }

  reset() {
    this.inputRate = 0;
    this.position = 0;
    this.previous = 0;
    this.hasPrevious = false;
  }

  process(input, inputRate) {
    if (!(input instanceof Float32Array)) input = Float32Array.from(input || []);
    if (!input.length) return new Float32Array();
    if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('Invalid input sample rate');
    if (this.inputRate && this.inputRate !== inputRate) this.reset();
    this.inputRate = inputRate;
    if (inputRate === this.outputRate) return input.slice();

    const source = new Float32Array(input.length + (this.hasPrevious ? 1 : 0));
    let offset = 0;
    if (this.hasPrevious) { source[0] = this.previous; offset = 1; }
    source.set(input, offset);
    const step = inputRate / this.outputRate;
    const values = [];
    let p = this.position;
    while (p + 1 < source.length) {
      const i = Math.floor(p);
      const f = p - i;
      values.push(source[i] + (source[i + 1] - source[i]) * f);
      p += step;
    }
    this.previous = source[source.length - 1];
    this.hasPrevious = true;
    this.position = p - (source.length - 1);
    return Float32Array.from(values);
  }
}

class ButterworthLowPass {
  constructor(fc, fs, order) {
    this.order = order;
    this.sections = [];
    this.configure(fc, fs, order);
  }

  configure(fc, fs, order = this.order) {
    this.order = order;
    this.sections = [];
    const wa = Math.tan(Math.PI * fc / fs);
    let n = (order & 1) + 1;
    for (let j = 1; j <= Math.floor(order / 2); j++, n += 2) {
      const zeta = Math.cos(n * Math.PI / (2 * order));
      const a0 = 1 + 2 * wa * zeta + wa * wa;
      this.sections.push({
        a1: -2 * (wa * wa - 1) / a0,
        a2: -(1 - 2 * wa * zeta + wa * wa) / a0,
        b0: wa * wa / a0,
        b1: 2 * wa * wa / a0,
        z0: 0,
        z1: 0,
      });
    }
    if (order & 1) {
      const a0 = 1 + wa;
      this.sections.push({ a1: -(wa - 1) / a0, a2: 0, b0: wa / a0, b1: wa / a0, z0: 0, z1: 0, first: true });
    }
  }

  process(value) {
    let d = value;
    for (const s of this.sections) {
      d += s.z0 * s.a1 + (s.first ? 0 : s.z1 * s.a2);
      const out = d * s.b0 + s.z0 * s.b1 + (s.first ? 0 : s.z1 * s.b0);
      if (!s.first) s.z1 = s.z0;
      s.z0 = Math.abs(d) < 1e-37 ? 0 : d;
      d = out;
    }
    return d;
  }
}

class VCO {
  constructor(sampleRate, freeFrequency = 1900) {
    this.sampleRate = sampleRate;
    this.freeFrequency = freeFrequency;
    this.gain = -800;
    this.phase = 0;
  }

  process(control) {
    this.phase += 2 * Math.PI * (this.freeFrequency + control * this.gain) / this.sampleRate;
    this.phase %= 2 * Math.PI;
    if (this.phase < 0) this.phase += 2 * Math.PI;
    return Math.sin(this.phase);
  }
}

export class MMSSTVCPLL {
  constructor(sampleRate = MMSSTV_SAMPLE_RATE, options = {}) {
    this.sampleRate = sampleRate;
    this.vcoGain = options.vcoGain ?? 1;
    this.loopOrder = options.loopOrder ?? 1;
    this.loopFC = options.loopFC ?? 1500;
    this.outOrder = options.outOrder ?? 3;
    this.outFC = options.outFC ?? 900;
    this.narrow = options.narrow === true;
    this.reset();
  }

  reset() {
    this.error = 0;
    this.output = 0;
    this.max = 1;
    this.min = -1;
    this.last = 0;
    this.agc = 1;
    this.previousAgc = 0;
    const low = this.narrow ? 2044 : 1500;
    const high = this.narrow ? 2300 : 2300;
    this.center = (low + high) / 2;
    this.shift = high - low;
    this.vco = new VCO(this.sampleRate, this.center);
    this.vco.gain = -this.shift * this.vcoGain;
    this.loop = new ButterworthLowPass(this.loopFC, this.sampleRate, this.loopOrder);
    this.out = new ButterworthLowPass(this.outFC, this.sampleRate, this.outOrder);
  }

  process(sample) {
    if (sample > this.max) this.max = sample;
    if (sample < this.min) this.min = sample;
    if (sample >= 0 && this.last < 0) {
      const span = Math.max(1e-9, this.max - this.min);
      const next = 5 / span;
      this.agc = (this.previousAgc + next) * 0.5;
      this.previousAgc = next;
      this.max = 1;
      this.min = -1;
    }
    this.last = sample;
    const normalized = sample * this.agc;
    this.output = Math.max(-1.5, Math.min(1.5, this.loop.process(this.error)));
    const oscillator = this.vco.process(this.output);
    this.error = oscillator * normalized;
    return this.out.process(this.output) * 32768 * this.vcoGain;
  }

  processBlock(samples) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = this.process(samples[i]);
    return out;
  }
}

export class MMSSTVCLMS {
  constructor(sampleRate = MMSSTV_SAMPLE_RATE, mode = 'lms') {
    this.sampleRate = sampleRate;
    this.mode = mode;
    this.maxTaps = 192;
    this.reset();
  }

  reset() {
    const adaptiveNotch = this.mode === 'anf' || this.mode === 'ans';
    this.taps = Math.min(this.maxTaps, Math.round((adaptiveNotch ? 48 : 4) * this.sampleRate / 11025));
    this.delay = adaptiveNotch ? Math.min(this.maxTaps, Math.round(12 * this.sampleRate / 11025)) : 0;
    this.mu = adaptiveNotch ? (this.mode === 'anf' ? 0.00018 : 0.00005) : 0.003;
    this.leak = adaptiveNotch ? (this.mode === 'anf' ? 0.999998 : 0.9999985) : 0.9999;
    this.history = new Float64Array(this.taps + 1);
    this.coefficients = new Float64Array(this.taps + 1);
    this.delayed = new Float64Array(this.delay + 1);
    this.previous = 0;
  }

  process(value) {
    this.history.copyWithin(0, 1);
    this.history[this.taps] = this.mode === 'lms' ? this.previous : this.delayed[0];
    let predicted = 0;
    for (let i = 0; i <= this.taps; i++) predicted += this.history[i] * this.coefficients[i];
    const error = value - predicted;
    const scaled = error * this.mu;
    if (this.delay) {
      this.delayed.copyWithin(0, 1);
      this.delayed[this.delay] = value;
    }
    this.previous = value;
    let norm = 0;
    for (let i = 0; i <= this.taps; i++) {
      this.coefficients[i] = scaled * this.history[i] + this.coefficients[i] * this.leak;
      norm += Math.abs(this.coefficients[i]);
    }
    if (this.mode !== 'lms') return error;
    return norm > 0 ? predicted / norm : predicted;
  }

  processBlock(samples) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = this.process(samples[i]);
    return out;
  }
}

export function makeMmsstvBandpass(sampleRate = MMSSTV_SAMPLE_RATE, options = {}) {
  const quality = Math.max(0, Math.min(3, options.quality ?? 2));
  if (quality === 0) return Float64Array.of(1);
  const tap = Math.max(2, Math.round(([0, 24, 64, 96][quality] * sampleRate) / 11025));
  const low = options.low ?? (quality === 1 ? 1100 : quality === 2 ? 1200 : 1200);
  const high = options.high ?? (quality === 1 ? 2600 : quality === 2 ? 2500 : 2400);
  const h = new Float64Array(tap + 1);
  const mid = tap / 2;
  for (let n = 0; n <= tap; n++) {
    const k = n - mid;
    const ideal = k === 0
      ? 2 * (high - low) / sampleRate
      : (Math.sin(2 * Math.PI * high * k / sampleRate) - Math.sin(2 * Math.PI * low * k / sampleRate)) / (Math.PI * k);
    const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / tap);
    h[n] = ideal * window;
  }
  return h;
}

export class StreamingFIR {
  constructor(coefficients) {
    this.h = coefficients;
    this.z = new Float64Array(coefficients.length);
    this.index = 0;
  }

  process(value) {
    this.z[this.index] = value;
    let sum = 0;
    let p = this.index;
    for (let i = 0; i < this.h.length; i++) {
      sum += this.h[i] * this.z[p];
      if (--p < 0) p = this.z.length - 1;
    }
    this.index = (this.index + 1) % this.z.length;
    return sum;
  }

  processBlock(samples) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = this.process(samples[i]);
    return out;
  }
}
