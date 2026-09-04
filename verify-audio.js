// Audio container checks: PCM round-trip, float WAV and malformed chunks.
import { decodeWAV, encodeWAV } from './js/wav.js';
import { AUDIO_FILE_LIMITS, decodeAudioFile } from './js/audiodecode.js';
import { resample } from './js/demod.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, message) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error, message);
  return error;
}

async function assertRejects(promise, message) {
  let error = null;
  try { await promise; } catch (caught) { error = caught; }
  assert(error instanceof Error, message);
  return error;
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

await assertRejects(
  decodeAudioFile(floatBuffer, { maxChannels: 1 }),
  'decodeAudioFile accepted more decoded channels than its custom limit',
);
await assertRejects(
  decodeAudioFile(encodeWAV(source, 22050), { maxDurationSeconds: 1 / 22050 }),
  'decodeAudioFile accepted audio longer than its custom duration limit',
);

let oversizedFileRead = false;
await assertRejects(
  decodeAudioFile({
    size: 9,
    async arrayBuffer() {
      oversizedFileRead = true;
      return new ArrayBuffer(9);
    },
  }, { maxFileBytes: 8 }),
  'decodeAudioFile accepted a file over its custom byte limit',
);
assert(!oversizedFileRead, 'oversized audio file was read before its size was rejected');

await assertRejects(
  decodeAudioFile({ size: 1, async arrayBuffer() { return new ArrayBuffer(9); } }, {
    ...AUDIO_FILE_LIMITS,
    maxFileBytes: 8,
  }),
  'decodeAudioFile trusted stale file metadata after reading',
);

const originalAudio = globalThis.Audio;
const originalAudioContext = globalThis.AudioContext;
let compressedDecodeStarted = false;
try {
  globalThis.Audio = class {
    constructor() { this.duration = 120; }
    load() {
      if (this.src) queueMicrotask(() => this.onloadedmetadata?.());
    }
    removeAttribute() { this.src = ''; }
  };
  globalThis.AudioContext = class {
    constructor() { this.state = 'running'; }
    async decodeAudioData() {
      compressedDecodeStarted = true;
      throw new Error('decodeAudioData should not run');
    }
  };
  await assertRejects(
    decodeAudioFile(new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }), {
      maxDurationSeconds: 60,
    }),
    'compressed audio duration was not rejected during metadata preflight',
  );
  assert(!compressedDecodeStarted, 'compressed audio reached decodeAudioData before duration rejection');
} finally {
  if (originalAudio === undefined) delete globalThis.Audio;
  else globalThis.Audio = originalAudio;
  if (originalAudioContext === undefined) delete globalThis.AudioContext;
  else globalThis.AudioContext = originalAudioContext;
}

const oneHz = encodeWAV(source, 22050);
const oneHzView = new DataView(oneHz);
oneHzView.setUint32(24, 1, true);
oneHzView.setUint32(28, 2, true);
assertThrows(() => decodeWAV(oneHz), '1 Hz WAV was accepted');
assertThrows(
  () => decodeWAV(floatBuffer, { maxFrames: 1 }),
  'WAV frame allocation ignored its custom limit',
);
assertThrows(
  () => decodeWAV(floatBuffer, { maxDurationSeconds: 1 / 48000 }),
  'WAV duration allocation ignored its custom limit',
);

const malformed = new ArrayBuffer(20);
const malformedView = new DataView(malformed);
writeString(malformedView, 0, 'RIFF'); writeString(malformedView, 8, 'WAVE');
writeString(malformedView, 12, 'data'); malformedView.setUint32(16, 1000, true);
let rejected = false;
try { decodeWAV(malformed); } catch (_) { rejected = true; }
assert(rejected, 'malformed WAV chunk was accepted');

assertThrows(
  () => encodeWAV({ length: 0x80000000 }, 22050),
  'WAV encoder accepted a byte length that cannot fit its RIFF fields',
);
assertThrows(
  () => resample(new Float32Array([0, 1]), 8000, 1_000_000_000_000),
  'resampler attempted an allocation above its output limit',
);

console.log('Audio checks passed: formats, malformed input, decode and allocation limits');
