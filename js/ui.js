// ui.js — DOM/Canvas 渲染辅助

export function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.add('hidden');
    setTimeout(() => { el.hidden = true; }, 300);
  }, 2800);
}

export function setProgress(id, p) {
  const wrap = document.getElementById(id);
  if (p >= 1) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const bar = wrap.querySelector('.bar');
  // 使用 requestAnimationFrame 优化性能
  requestAnimationFrame(() => {
    bar.style.width = (p * 100).toFixed(1) + '%';
  });
}

export function renderToCanvas(canvas, pixels, width, height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false }); // 性能优化
  const imgData = new ImageData(new Uint8ClampedArray(pixels), width, height);
  ctx.putImageData(imgData, 0, 0);
}

// 把任意图片元素画到目标 canvas(用于显示原图)
export function drawImageToCanvas(canvas, image, width, height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false }); // 性能优化
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
}

// 波形绘制（优化版本）
let waveformCache = null;
export function drawWaveform(canvas, samples) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const w = canvas.width = canvas.clientWidth;
  const h = canvas.height = canvas.clientHeight || 80;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  // 绘制网格线
  ctx.strokeStyle = 'rgba(79, 209, 197, 0.1)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // 绘制波形填充
  ctx.fillStyle = 'rgba(79, 209, 197, 0.15)';
  ctx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / w));

  ctx.moveTo(0, h / 2);
  for (let x = 0; x < w; x++) {
    let max = 0;
    const startIdx = x * step;
    const endIdx = Math.min(startIdx + step, samples.length);

    for (let i = startIdx; i < endIdx; i++) {
      const v = Math.abs(samples[i] || 0);
      if (v > max) max = v;
    }

    const y = h / 2 - max * h / 2;
    ctx.lineTo(x, y);
  }
  for (let x = w - 1; x >= 0; x--) {
    let max = 0;
    const startIdx = x * step;
    const endIdx = Math.min(startIdx + step, samples.length);

    for (let i = startIdx; i < endIdx; i++) {
      const v = Math.abs(samples[i] || 0);
      if (v > max) max = v;
    }

    const y = h / 2 + max * h / 2;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  // 绘制波形线
  ctx.strokeStyle = '#4fd1c5';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    let max = 0;
    const startIdx = x * step;
    const endIdx = Math.min(startIdx + step, samples.length);

    for (let i = startIdx; i < endIdx; i++) {
      const v = Math.abs(samples[i] || 0);
      if (v > max) max = v;
    }

    const y = h / 2 - max * h / 2;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 绘制中心线
  ctx.strokeStyle = 'rgba(79, 209, 197, 0.3)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

// 计算两幅 RGBA 图的 PSNR
export function computePSNR(a, b) {
  if (a.length !== b.length) return null;
  let mse = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      mse += d * d;
      n++;
    }
  }
  mse /= n;
  if (mse === 0) return 99;
  return 10 * Math.log10(255 * 255 / mse);
}

// 绑定拖放区
export function bindDropZone(el, fileInput, onFile) {
  el.addEventListener('click', () => fileInput.click());

  el.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('dragover');
  });

  el.addEventListener('dragleave', e => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('dragover');
  });

  el.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) {
      onFile(file);
    }
  });

  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) {
      onFile(file);
      // 重置 input 以允许重新选择同一文件
      e.target.value = '';
    }
  });
}

// 节流函数（用于优化频繁触发的事件）
export function throttle(func, delay) {
  let lastCall = 0;
  return function(...args) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      return func.apply(this, args);
    }
  };
}

// 防抖函数（用于延迟执行）
export function debounce(func, delay) {
  let timeoutId;
  return function(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
}
