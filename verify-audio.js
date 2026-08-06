// Audio container checks: PCM round-trip, float WAV and malformed chunks.
import { decodeWAV, encodeWAV } from './js/wav.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = new Float32Array([-1, -0.5, 0, 0.5, 1]);
const pcm = decodeWAV(encodeWAV(source, 22050));
assert(pcm.sampleRate === 22050 && pcm.samples.length === source.length, 'PCM WAV metadata differs');
for (let i = 0; i < source.length; i++) {
  assert(Math.abs(pcm.samples[i] - source[i]) < 1 / 32767 + 1e-6, `PCM sample ${i} differs`);
}

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

// Two-frame, stereo, IEEE-float WAV. Decoder should average the channels.
const floatBuffer = new ArrayBuffer(44 + 2 * 2 * 4);
const view = new DataView(floatBuffer);
writeString(view, 0, 'RIFF'); view.setUint32(4, floatBuffer.byteLength - 8, true);
writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt '); view.setUint32(16, 16, true);
view.setUint16(20, 3, true); view.setUint16(22, 2, true); view.setUint32(24, 48000, true);
view.setUint32(28, 48000 * 8, true); view.setUint16(32, 8, true); view.setUint16(34, 32, true);
writeString(view, 36, 'data'); view.setUint32(40, 16, true);
view.setFloat32(44, 0.5, true); view.setFloat32(48, -0.5, true);
view.setFloat32(52, 1.0, true); view.setFloat32(56, 0.0, true);
const floatWav = decodeWAV(floatBuffer);
assert(floatWav.channelCount === 2 && floatWav.bitsPerSample === 32, 'float WAV metadata differs');
assert(Math.abs(floatWav.samples[0]) < 1e-6 && Math.abs(floatWav.samples[1] - 0.5) < 1e-6,
  'float WAV channel averaging failed');

const malformed = new ArrayBuffer(20);
const malformedView = new DataView(malformed);
writeString(malformedView, 0, 'RIFF'); writeString(malformedView, 8, 'WAVE');
writeString(malformedView, 12, 'data'); malformedView.setUint32(16, 1000, true);
let rejected = false;
try { decodeWAV(malformed); } catch (_) { rejected = true; }
assert(rejected, 'malformed WAV chunk was accepted');

console.log('Audio checks passed: PCM16, float32 stereo, malformed chunk rejection');
