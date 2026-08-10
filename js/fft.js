// fft.js — 轻量基-2 FFT + 瀑布图渲染
// 用于解码时的频谱可视化(700-2700Hz 范围,逆向 FFTLow/FFTWidth 确认)

// 原地基-2 FFT,长度必须为 2 的幂
export function fftRadix2(re, im) {
  const n = re.length;
  // 位反转
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Cooley-Tukey
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k], aIm = im[i + k];
        const bRe = re[i + k + len / 2], bIm = im[i + k + len / 2];
        const tRe = bRe * curRe - bIm * curIm;
        const tIm = bRe * curIm + bIm * curRe;
        re[i + k] = aRe + tRe; im[i + k] = aIm + tIm;
        re[i + k + len / 2] = aRe - tRe; im[i + k + len / 2] = aIm - tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

// 计算一段样本的幅度谱(用于瀑布图)
export function magnitudeSpectrum(samples, start, fftSize, sr) {
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  // Hann 窗
  for (let i = 0; i < fftSize; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    re[i] = (start + i < samples.length ? samples[start + i] : 0) * w;
  }
  fftRadix2(re, im);
  const mag = new Float32Array(fftSize / 2);
  for (let i = 0; i < fftSize / 2; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

const MIN_SNR_DB = -10;
const MAX_SNR_DB = 40;
const SNR_SILENCE_POWER = 1e-12;

/**
 * Estimate audio-band SNR without coupling the metric to the SSTV decoder.
 * Adjacent-band noise PSD is projected onto the selected signal bandwidth.
 */
export class StreamingSnrEstimator {
  constructor(sampleRate, {
    lowHz = 1000,
    highHz = 2800,
    fftSize = 2048,
    hopSize = 1024,
    smoothing = 0.25,
  } = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('sampleRate must be a positive finite number');
    }
    if (!Number.isFinite(lowHz) || !Number.isFinite(highHz)
        || lowHz <= 0 || highHz <= lowHz || highHz >= sampleRate / 2) {
      throw new RangeError('lowHz and highHz must satisfy 0 < lowHz < highHz < Nyquist');
    }
    if (!Number.isInteger(fftSize) || fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) {
      throw new RangeError('fftSize must be a power of two');
    }
    if (!Number.isInteger(hopSize) || hopSize < 1 || hopSize > fftSize) {
      throw new RangeError('hopSize must be an integer between 1 and fftSize');
    }
    if (!Number.isFinite(smoothing) || smoothing < 0 || smoothing > 1) {
      throw new RangeError('smoothing must be between 0 and 1');
    }

    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.hopSize = hopSize;
    this.smoothing = smoothing;
    this._window = new Float32Array(fftSize);
    this._windowEnergy = 0;
    for (let i = 0; i < fftSize; i++) {
      const value = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
      this._window[i] = value;
      this._windowEnergy += value * value;
    }

    const binHz = sampleRate / fftSize;
    const halfBandWidth = (highHz - lowHz) / 2;
    const noiseLowHz = Math.max(100, lowHz - halfBandWidth);
    const noiseHighHz = Math.min(sampleRate / 2, highHz + halfBandWidth);
    this._signalBins = [];
    this._noiseBins = [];
    for (let bin = 0; bin <= fftSize / 2; bin++) {
      const frequency = bin * binHz;
      if (frequency >= lowHz && frequency <= highHz) {
        this._signalBins.push(bin);
      } else if ((frequency >= noiseLowHz && frequency < lowHz)
                 || (frequency > highHz && frequency <= noiseHighHz)) {
        this._noiseBins.push(bin);
      }
    }
    if (!this._signalBins.length || !this._noiseBins.length) {
      throw new RangeError('FFT resolution is too low for the requested signal and noise bands');
    }

    this._binHz = binHz;
    this.reset();
  }

  push(samples) {
    if (!(samples instanceof Float32Array)) throw new TypeError('samples must be a Float32Array');
    let offset = 0;
    let latest = null;
    while (offset < samples.length) {
      const count = Math.min(this.fftSize - this._buffered, samples.length - offset);
      this._buffer.set(samples.subarray(offset, offset + count), this._buffered);
      this._buffered += count;
      offset += count;
      if (this._buffered === this.fftSize) {
        latest = this._analyze(this._buffer);
        this._buffer.copyWithin(0, this.hopSize);
        this._buffered = this.fftSize - this.hopSize;
      }
    }
    return latest;
  }

  reset() {
    this._buffer = new Float32Array(this.fftSize);
    this._buffered = 0;
    this._smoothedSnrDb = null;
  }

  _analyze(samples) {
    let timePower = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = Number.isFinite(samples[i]) ? samples[i] : 0;
      timePower += sample * sample;
    }
    timePower /= samples.length;
    if (timePower <= SNR_SILENCE_POWER) {
      this._smoothedSnrDb = null;
      return { snrDb: null, signalPower: 0, noisePower: 0 };
    }

    const re = new Float32Array(this.fftSize);
    const im = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      re[i] = (Number.isFinite(samples[i]) ? samples[i] : 0) * this._window[i];
    }
    fftRadix2(re, im);

    const psdScale = 1 / (this.sampleRate * this._windowEnergy);
    const psdAt = bin => {
      const oneSided = (bin === 0 || bin === this.fftSize / 2) ? 1 : 2;
      return (re[bin] * re[bin] + im[bin] * im[bin]) * psdScale * oneSided;
    };
    let bandPsd = 0;
    for (const bin of this._signalBins) bandPsd += psdAt(bin);
    bandPsd /= this._signalBins.length;
    let noisePsd = 0;
    for (const bin of this._noiseBins) noisePsd += psdAt(bin);
    noisePsd /= this._noiseBins.length;

    const effectiveBandWidth = this._signalBins.length * this._binHz;
    const noisePower = Math.max(0, noisePsd * effectiveBandWidth);
    const signalPower = Math.max(0, (bandPsd - noisePsd) * effectiveBandWidth);
    let instantaneousSnrDb = MIN_SNR_DB;
    if (signalPower > 0 && noisePower <= 0) instantaneousSnrDb = MAX_SNR_DB;
    else if (signalPower > 0) {
      instantaneousSnrDb = Math.max(
        MIN_SNR_DB,
        Math.min(MAX_SNR_DB, 10 * Math.log10(signalPower / noisePower)),
      );
    }
    this._smoothedSnrDb = this._smoothedSnrDb === null
      ? instantaneousSnrDb
      : this._smoothedSnrDb + this.smoothing * (instantaneousSnrDb - this._smoothedSnrDb);
    return { snrDb: this._smoothedSnrDb, signalPower, noisePower };
  }
}

// 把一个时间片绘制成频谱图的一列：横轴时间向右，纵轴频率由低到高。
// 画布坐标向下递增，所以高频在上、低频在下。
export function drawSpectrumColumn(specCtx, mag, column, sr, fftSize, fLow, fHigh, height) {
  const imgData = specCtx.createImageData(1, height);
  for (let y = 0; y < height; y++) {
    const ratio = height > 1 ? 1 - y / (height - 1) : 0;
    const f = fLow + ratio * (fHigh - fLow);
    const bin = Math.round(f * fftSize / sr);
    const m = bin < mag.length ? mag[bin] : 0;
    // 对数缩放 + 颜色映射(蓝→青→绿→黄→红)
    const v = Math.min(1, Math.log10(1 + m * 1e4) / 4);
    const [r, g, b] = heatColor(v);
    imgData.data[y * 4] = r;
    imgData.data[y * 4 + 1] = g;
    imgData.data[y * 4 + 2] = b;
    imgData.data[y * 4 + 3] = 255;
  }
  specCtx.putImageData(imgData, column, 0);
}

function heatColor(v) {
  v = Math.max(0, Math.min(1, v));
  // 简易热力图
  if (v < 0.25) return [0, v * 4 * 255, 255];
  if (v < 0.5)  return [0, 255, (0.5 - v) * 4 * 255];
  if (v < 0.75) return [(v - 0.5) * 4 * 255, 255, 0];
  return [255, (1 - v) * 4 * 255, 0];
}
