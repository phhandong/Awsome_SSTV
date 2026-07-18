// ui.js — DOM/Canvas 渲染辅助

export function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2800);
}

export function setProgress(id, p) {
  const wrap = document.getElementById(id);
  if (p >= 1) { wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.querySelector('.bar').style.width = (p * 100).toFixed(0) + '%';
}

export function renderToCanvas(canvas, pixels, width, height) {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imgData = new ImageData(new Uint8ClampedArray(pixels), width, height);
  ctx.putImageData(imgData, 0, 0);
}

// 把任意图片元素画到目标 canvas(用于显示原图)
export function drawImageToCanvas(canvas, image, width, height) {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
}

// 波形绘制
export function drawWaveform(canvas, samples) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth;
  const h = canvas.height = canvas.clientHeight || 60;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#4fd1c5'; ctx.lineWidth = 1;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / w));
  for (let x = 0; x < w; x++) {
    let max = 0;
    for (let i = 0; i < step; i++) {
      const v = Math.abs(samples[x * step + i] || 0);
      if (v > max) max = v;
    }
    const y = h / 2 - max * h / 2;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// 计算两幅 RGBA 图的 PSNR
export function computePSNR(a, b) {
  if (a.length !== b.length) return null;
  let mse = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      mse += d * d; n++;
    }
  }
  mse /= n;
  if (mse === 0) return 99;
  return 10 * Math.log10(255 * 255 / mse);
}

// 绑定拖放区
export function bindDropZone(el, fileInput, onFile) {
  el.addEventListener('click', () => fileInput.click());
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', e => {
    e.preventDefault(); el.classList.remove('dragover');
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) onFile(e.target.files[0]);
  });
}
