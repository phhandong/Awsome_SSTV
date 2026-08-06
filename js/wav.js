// wav.js — 纯 JS WAV 读写,无依赖
// 编码:44100Hz / 16-bit / mono(最小实现)
// 解码:支持 8/16/24/32-bit、单/立体声(取左声道),返回原始采样率由调用方重采样

export function encodeWAV(samples, sampleRate = 44100) {
  // samples: Float32Array,范围 -1..1
  const numSamples = samples.length;
  const dataLen = numSamples * 2;  // 16-bit
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, dataLen, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    view.setInt16(offset, s * 32767, true);
    offset += 2;
  }
  return buffer;
}

export function decodeWAV(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 12) {
    throw new Error('WAV 文件过短');
  }
  const view = new DataView(buf);
  if (readString(view, 0) !== 'RIFF' || readString(view, 8) !== 'WAVE') {
    throw new Error('不是有效的 WAV/RIFF 文件');
  }

  // 遍历 chunks,找 fmt 与 data
  let audioFormat = 0, sampleRate = 0, channels = 0, bitsPerSample = 0;
  let fmtFound = false;
  let dataOffset = -1, dataLen = 0;
  let offset = 12;
  while (offset + 8 <= buf.byteLength) {
    const id = readString(view, offset);
    const size = view.getUint32(offset + 4, true);
    const chunkEnd = offset + 8 + size;
    if (chunkEnd > buf.byteLength) throw new Error(`WAV ${id} chunk 越界`);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV fmt chunk 过短');
      // 字段相对 chunk 数据起始(offset+8):audioFormat=0, channels=2, sampleRate=4, bits=14
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 8 + 2, true);
      sampleRate = view.getUint32(offset + 8 + 4, true);
      bitsPerSample = view.getUint16(offset + 8 + 14, true);
      fmtFound = true;
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLen = size;
    }
    offset += 8 + size + (size & 1);  // 偶对齐
  }
  if (!fmtFound) throw new Error('WAV 无 fmt chunk');
  if (dataOffset < 0) throw new Error('WAV 无 data chunk');
  if (channels < 1 || sampleRate < 1) throw new Error('WAV 声道数或采样率无效');
  const pcmBits = [8, 16, 24, 32];
  const supported = (audioFormat === 1 && pcmBits.includes(bitsPerSample)) ||
    (audioFormat === 3 && bitsPerSample === 32);
  if (!supported) throw new Error(`不支持的 WAV 格式: format=${audioFormat}, bits=${bitsPerSample}`);

  const bytesPerSample = bitsPerSample / 8;
  const frameLen = bytesPerSample * channels;
  const numFrames = Math.floor(dataLen / frameLen);
  const samples = new Float32Array(numFrames);

  for (let i = 0; i < numFrames; i++) {
    const base = dataOffset + i * frameLen;
    let value = 0;
    for (let channel = 0; channel < channels; channel++) {
      value += readSample(view, base + channel * bytesPerSample, bitsPerSample, audioFormat);
    }
    samples[i] = value / channels;
  }
  return { sampleRate, channelCount: channels, bitsPerSample, samples };
}

function readSample(view, offset, bits, format = 1) {
  if (format === 3) return view.getFloat32(offset, true);
  switch (bits) {
    case 8:
      // 8-bit WAV 是无符号(0..255),中心 128
      return (view.getUint8(offset) - 128) / 128;
    case 16:
      return view.getInt16(offset, true) / 32768;
    case 24: {
      const b0 = view.getUint8(offset), b1 = view.getUint8(offset + 1), b2 = view.getUint8(offset + 2);
      let v = (b2 << 16) | (b1 << 8) | b0;
      if (v & 0x800000) v |= 0xff000000;  // 符号扩展
      return v / 8388608;
    }
    case 32:
      return view.getInt32(offset, true) / 2147483648;
    default:
      throw new Error('不支持的位深度: ' + bits);
  }
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
function readString(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}
