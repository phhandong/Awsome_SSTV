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
