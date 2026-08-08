// MIT License

export function encodeBmp(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const rowSize = Math.ceil(width * 3 / 4) * 4;
  const pixelBytes = rowSize * height;
  const offset = 54;
  const out = new ArrayBuffer(offset + pixelBytes);
  const view = new DataView(out);
  view.setUint8(0, 0x42); view.setUint8(1, 0x4d);
  view.setUint32(2, out.byteLength, true);
  view.setUint32(10, offset, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = offset + row + x * 3;
      view.setUint8(dst, rgba[src + 2]);
      view.setUint8(dst + 1, rgba[src + 1]);
      view.setUint8(dst + 2, rgba[src]);
    }
  }
  return new Blob([out], { type: 'image/bmp' });
}

export function canvasBlob(canvas, format) {
  if (format === 'bmp') return Promise.resolve(encodeBmp(canvas));
  return new Promise((resolve, reject) => {
    const fallback = () => {
      try { resolve(dataUrlBlob(canvas.toDataURL('image/png'))); } catch (error) { reject(error); }
    };
    if (canvas.toBlob) {
      try { canvas.toBlob(blob => blob ? resolve(blob) : fallback(), 'image/png'); } catch (_) { fallback(); }
    } else {
      fallback();
    }
  });
}

function dataUrlBlob(dataUrl) {
  const [meta, data] = dataUrl.split(',');
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: meta.match(/data:([^;]+)/)?.[1] || 'image/png' });
}
