import { encode } from './js/encoder.js';
import { getMode } from './js/modes.js';
import { MMSSTVCPLL, StreamingResampler } from './js/mmsstv-dsp.js';
import { SSTVReceiver } from './js/receiver.js';
import { detectSyncMode } from './js/sync-acquisition.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sourceRate = 48000;
const tone = new Float32Array(sourceRate);
for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2 * Math.PI * 1900 * i / sourceRate);
const wholeResampler = new StreamingResampler();
const whole = wholeResampler.process(tone, sourceRate);
const chunkedResampler = new StreamingResampler();
const chunks = [];
for (let i = 0; i < tone.length; i += 733) chunks.push(chunkedResampler.process(tone.subarray(i, i + 733), sourceRate));
const joined = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
let joinedOffset = 0;
for (const chunk of chunks) { joined.set(chunk, joinedOffset); joinedOffset += chunk.length; }
assert(Math.abs(whole.length - joined.length) <= 1, 'streaming resampler changed output length');
for (let i = 0; i < Math.min(whole.length, joined.length); i++) {
  assert(Math.abs(whole[i] - joined[i]) < 1e-5, `streaming resampler discontinuity at ${i}`);
}

for (const frequency of [1200, 1500, 1900, 2100, 2300]) {
  const pll = new MMSSTVCPLL(11025);
  let sum = 0, count = 0;
  for (let i = 0; i < 11025; i++) {
    const value = pll.process(Math.sin(2 * Math.PI * frequency * i / 11025));
    if (i > 6000) { sum += 1900 - (value / 32768) * 800; count++; }
  }
  assert(Math.abs(sum / count - frequency) < 3, `CPLL failed to lock ${frequency} Hz`);
}

function image(mode) {
  const rgba = new Uint8ClampedArray(mode.width * mode.height * 4);
  for (let y = 0; y < mode.height; y++) for (let x = 0; x < mode.width; x++) {
    const i = (y * mode.width + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.round(255 * x / mode.width);
    rgba[i + 3] = 255;
  }
  return { rgba };
}

for (const key of [2, 0x1022d]) {
  const mode = getMode(key);
  const pcm = encode(image(mode), mode, { sampleRate: 11025 });
  const receiver = new SSTVReceiver({ dsp: { engine: 'legacy', bpf: true }, emitFrames: false });
  let locked = false, rows = 0;
  receiver.on('locked', event => { locked = event.mode === mode; });
  receiver.on('row', event => { rows = event.rows; });
  for (let i = 0; i < pcm.length; i += 997) receiver.push(pcm.subarray(i, i + 997), 11025);
  const result = receiver.end();
  assert(locked, `${mode.name} did not emit locked`);
  assert(rows >= mode.height * 0.95, `${mode.name} emitted too few rows: ${rows}`);
  assert(result.mode === mode, `${mode.name} stream decoded as ${result.mode.name}`);
  assert(result.dsp.demodulator === 'phase', `${mode.name} stream did not use native phase demodulation`);
}

// MMSSTV remote start: identify a mode from sync intervals even when one
// pulse is missing.
const syncMode = getMode(8);
const syncFreq = new Float32Array(Math.ceil(6 * syncMode.lineDurationMs * 11025 / 1000)).fill(1500);
const syncPeriod = syncMode.lineDurationMs * 11025 / 1000;
for (const line of [0, 1, 3, 4, 5]) {
  const start = Math.round(200 + line * syncPeriod);
  syncFreq.fill(1200, start, Math.min(syncFreq.length, start + Math.ceil(10 * 11025 / 1000)));
}
const syncLock = detectSyncMode(syncFreq, 11025);
assert(syncLock?.mode === syncMode, `sync intervals detected ${syncLock?.mode?.name || 'nothing'} instead of Robot 36`);

// Remove the complete VIS header and enter during the image. Automatic sync
// start and a manually selected mode must both remain usable.
const noVisMode = getMode(2);
const noVisPcm = encode(image(noVisMode), noVisMode, { sampleRate: 11025 }).subarray(11025);
for (const options of [{}, { mode: noVisMode.visCode }]) {
  const receiver = new SSTVReceiver({ ...options, dsp: { engine: 'legacy', bpf: true }, emitFrames: false });
  let source = null;
  receiver.on('locked', event => { source = event.source; });
  for (let i = 0; i < noVisPcm.length; i += 613) receiver.push(noVisPcm.subarray(i, i + 613), 11025);
  const result = receiver.end();
  const expectedSource = options.mode ? 'manual' : 'sync';
  assert(source === expectedSource, `no-VIS ${expectedSource} receiver locked via ${source}`);
  assert(result.mode === noVisMode, `no-VIS ${expectedSource} decode selected ${result.mode.name}`);
}

const changingRateReceiver = new SSTVReceiver({ emitFrames: false });
changingRateReceiver.push(new Float32Array(32), 48000);
let rateChangeRejected = false;
try {
  changingRateReceiver.push(new Float32Array(32), 44100);
} catch (error) {
  rateChangeRejected = /Sample rate changed/.test(error.message);
}
assert(rateChangeRejected, 'streaming receiver accepted a mid-session sample-rate change');

// Acquisition must keep scanning a bounded rolling window. A signal that
// begins after the old seven-second prefix limit must still lock live.
const lateMode = getMode(2);
const lateFrame = encode(image(lateMode), lateMode, { sampleRate: 11025 });
const latePcm = new Float32Array(8 * 11025 + lateFrame.length);
latePcm.set(lateFrame, 8 * 11025);
const lateReceiver = new SSTVReceiver({ dsp: { engine: 'legacy', bpf: true }, emitFrames: false });
let lateLocked = false;
lateReceiver.on('locked', event => { lateLocked ||= event.mode === lateMode; });
for (let i = 0; i < latePcm.length; i += 997) {
  lateReceiver.push(latePcm.subarray(i, i + 997), 11025);
}
assert(lateLocked, 'rolling acquisition did not lock a frame after eight seconds of silence');
assert(lateReceiver.acquisitionLength <= 8 * 11025,
  `rolling acquisition grew without bound: ${lateReceiver.acquisitionLength}`);
assert(lateReceiver.searchNativeLength <= 9 * 11025,
  `rolling native search buffer grew without bound: ${lateReceiver.searchNativeLength}`);
const lateResult = lateReceiver.end();
assert(lateResult.mode === lateMode, `late rolling frame decoded as ${lateResult.mode.name}`);

// A completed frame must return the receiver to acquisition without dropping
// a following header that arrived in the same input chunk.
const firstLiveFrame = encode(image(lateMode), lateMode, { sampleRate: 11025 });
const secondLiveFrame = encode(image(lateMode), lateMode, { sampleRate: 11025 });
const consecutive = new Float32Array(firstLiveFrame.length + secondLiveFrame.length);
consecutive.set(firstLiveFrame);
consecutive.set(secondLiveFrame, firstLiveFrame.length);
const consecutiveReceiver = new SSTVReceiver({
  dsp: { engine: 'legacy', bpf: true },
  emitFrames: true,
});
let consecutiveLocks = 0;
let consecutiveFrames = 0;
let firstTransmissionEndedAfterSecondLock = false;
consecutiveReceiver.on('locked', event => {
  if (event.mode === lateMode) consecutiveLocks++;
});
consecutiveReceiver.on('frame', event => {
  if (event.result.mode === lateMode) consecutiveFrames++;
});
consecutiveReceiver.on('transmission-ended', () => {
  if (consecutiveLocks >= 2 && consecutiveFrames === 1) firstTransmissionEndedAfterSecondLock = true;
});
for (let i = 0; i < consecutive.length; i += 997) {
  consecutiveReceiver.push(consecutive.subarray(i, i + 997), 11025);
}
const consecutiveResult = consecutiveReceiver.end();
assert(consecutiveLocks >= 2, `continuous input locked only ${consecutiveLocks} frame(s)`);
assert(consecutiveFrames >= 2, `continuous input emitted only ${consecutiveFrames} frame(s)`);
assert(!firstTransmissionEndedAfterSecondLock,
  'first transmission ended event was emitted after the following frame locked');
assert(consecutiveResult.mode === lateMode, `continuous input ended as ${consecutiveResult.mode.name}`);

// Once a complete live frame has already been emitted, end() returns that
// result without decoding or emitting the same frame a second time.
const completedLivePcm = new Float32Array(firstLiveFrame.length + Math.ceil(1.5 * 11025));
completedLivePcm.set(firstLiveFrame);
const completedLiveReceiver = new SSTVReceiver({
  dsp: { engine: 'legacy', bpf: true },
  autoSync: false,
  mode: lateMode.visCode,
  emitFrames: false,
});
let completedLiveEvents = 0;
let completedNaturalEnds = 0;
let completedFinalEvent = null;
let completedEndEvent = null;
const completedNaturalOrder = [];
completedLiveReceiver.on('frame', event => {
  completedLiveEvents++;
  completedFinalEvent = event;
  completedNaturalOrder.push('frame');
});
completedLiveReceiver.on('searching', () => { completedNaturalOrder.push('searching'); });
completedLiveReceiver.on('transmission-ended', event => {
  completedNaturalEnds++;
  completedEndEvent = event;
  completedNaturalOrder.push('transmission-ended');
});
for (let i = 0; i < completedLivePcm.length; i += 997) {
  completedLiveReceiver.push(completedLivePcm.subarray(i, i + 997), 11025);
}
assert(completedLiveEvents === 1,
  `completed live frame emitted ${completedLiveEvents} time(s) before end()`);
assert(completedNaturalEnds === 1,
  `completed live transmission ended ${completedNaturalEnds} time(s)`);
assert(completedNaturalOrder.slice(0, 3).join(',') === 'frame,searching,transmission-ended',
  `natural completion event order is invalid: ${completedNaturalOrder.join(', ')}`);
assert(Number.isSafeInteger(completedFinalEvent?.frameId) &&
  completedEndEvent?.frameId === completedFinalEvent.frameId,
`natural completion frame ID mismatch: ${completedFinalEvent?.frameId} / ${completedEndEvent?.frameId}`);
assert(completedEndEvent.mode === lateMode && completedEndEvent.rows === lateMode.height &&
  completedEndEvent.complete === true && completedEndEvent.completionRatio === 1 &&
  completedEndEvent.reason === 'nominal-tail',
'natural completion event metadata is invalid');
assert(completedLiveReceiver.mode == null,
  'manual receive relocked on ambient audio after a completed frame');
assert(completedLiveReceiver.rearm() === true && completedLiveReceiver.nextFrameAcquisitionFloor === 0,
  'manual receiver did not re-arm after the operator chose to continue');
const rearmSilence = new Float32Array(Math.ceil(1.1 * 11025));
for (let i = 0; i < rearmSilence.length; i += 997) {
  completedLiveReceiver.push(rearmSilence.subarray(i, i + 997), 11025);
}
assert(completedLiveReceiver.mode === lateMode,
  'manual receiver did not resume acquisition after re-arming');
const completedLiveResult = completedLiveReceiver.end();
assert(completedLiveEvents === 2, 'end() did not finalize the re-armed manual frame exactly once');
assert(completedNaturalEnds === 1, 'end() repeated a natural transmission-ended event');
assert(completedLiveResult.mode === lateMode,
  `completed live result ended as ${completedLiveResult.mode.name}`);

// An explicit end() is a finalization boundary, but finalization and image
// completeness are independent: a complete image is final+complete, while a
// stopped/truncated image is final+incomplete with its real row coverage.
const finalizingReceiver = new SSTVReceiver({
  dsp: { engine: 'legacy', bpf: true },
  emitFrames: false,
});
let finalizedEvent = null;
let finalizedNaturalEnds = 0;
finalizingReceiver.on('frame', event => { finalizedEvent = event; });
finalizingReceiver.on('transmission-ended', () => { finalizedNaturalEnds++; });
for (let i = 0; i < firstLiveFrame.length; i += 997) {
  finalizingReceiver.push(firstLiveFrame.subarray(i, i + 997), 11025);
}
const finalizedResult = finalizingReceiver.end();
assert(finalizedResult.mode === lateMode, 'explicit end did not decode the active frame');
assert(finalizedEvent?.partial === false, 'explicit end emitted a successfully decoded frame as partial');
assert(finalizedEvent.complete === true && finalizedEvent.rows === lateMode.height &&
  finalizedEvent.completionRatio === 1,
'explicit end did not report a complete reconstructed frame');
assert(Number.isSafeInteger(finalizedEvent.frameId), 'explicit final frame has no frame ID');
assert(finalizedNaturalEnds === 0, 'explicit end was reported as a natural transmission end');

const truncatedReceiver = new SSTVReceiver({
  dsp: { engine: 'legacy', bpf: true },
  emitFrames: false,
});
let truncatedEvent = null;
let truncatedNaturalEnds = 0;
truncatedReceiver.on('frame', event => { truncatedEvent = event; });
truncatedReceiver.on('transmission-ended', () => { truncatedNaturalEnds++; });
const truncatedLength = Math.floor(firstLiveFrame.length * 0.5);
for (let i = 0; i < truncatedLength; i += 997) {
  truncatedReceiver.push(firstLiveFrame.subarray(i, Math.min(truncatedLength, i + 997)), 11025);
}
const truncatedResult = truncatedReceiver.end();
assert(truncatedResult.mode === lateMode, 'truncated explicit end lost the active frame');
assert(truncatedEvent?.partial === false && truncatedEvent.complete === false,
  'truncated explicit end was presented as a complete image');
assert(truncatedNaturalEnds === 0, 'truncated explicit end emitted transmission-ended');
assert(truncatedEvent.rows > 0 && truncatedEvent.rows < lateMode.height &&
  truncatedEvent.completionRatio === truncatedEvent.rows / lateMode.height,
`truncated final coverage is invalid: ${truncatedEvent?.rows} / ${lateMode.height}`);

// AudioWorklet-sized chunks must be merged into fixed pages for the
// authoritative final-frame PCM. Reassembly remains sample-exact while the
// number of retained objects scales with frame duration, not push count.
{
  const mode = getMode(2);
  const pcm = encode(image(mode), mode, { sampleRate: 11025 });
  const receiver = new SSTVReceiver({
    dsp: { engine: 'legacy', bpf: true },
    emitFrames: false,
  });
  const workletChunkSize = 128;
  for (let offset = 0; offset < pcm.length; offset += workletChunkSize) {
    receiver.push(pcm.subarray(offset, Math.min(pcm.length, offset + workletChunkSize)), 11025);
  }
  const retainedSegments = receiver.frameNativePages.length +
    (receiver.frameNativePageLength ? 1 : 0);
  const pageSize = Math.ceil(11025 * 0.5);
  assert(retainedSegments <= Math.ceil(receiver.frameNativeLength / pageSize),
    `authoritative frame retained ${retainedSegments} segments for ${receiver.frameNativeLength} samples`);
  assert(retainedSegments * 10 < Math.ceil(pcm.length / workletChunkSize),
    `authoritative frame PCM was not meaningfully coalesced: ${retainedSegments} segments`);
  const rebuilt = receiver.copyFrameNativePcm();
  const expected = pcm.subarray(
    receiver.frameNativeStart,
    receiver.frameNativeStart + receiver.frameNativeLength
  );
  assert(rebuilt.length === expected.length, 'paged frame PCM changed length');
  for (let index = 0; index < rebuilt.length; index++) {
    assert(rebuilt[index] === expected[index], `paged frame PCM changed sample ${index}`);
  }
  assert(receiver.end().mode === mode, 'paged authoritative frame did not decode');
}

// Live reconstruction must emit small dirty strips often enough to look
// progressive without turning the authoritative final frame into a patch.
// B/W exercises one display row per transmission line; PD50 exercises paired
// YUV rows.
for (const key of [2, 93]) {
  const mode = getMode(key);
  const encoded = encode(image(mode), mode, { sampleRate: 11025 });
  // Deliberately omit trailer padding. end() must drain a complete final
  // transmission line even though the per-line preview normally asks for an
  // 8-ms demodulator post-roll.
  const pcm = encoded;
  const receiver = new SSTVReceiver({
    dsp: { engine: 'mmsstv', bpf: true },
    emitFrames: true,
    renderEveryRows: 8,
  });
  const frameStarts = [];
  const patches = [];
  const finalFrames = [];
  const eventOrder = [];
  receiver.on('locked', event => {
    if (event.mode === mode) eventOrder.push('locked');
  });
  receiver.on('frame-start', event => {
    if (event.mode === mode) {
      eventOrder.push('frame-start');
      frameStarts.push(event);
    }
  });
  receiver.on('frame-patch', event => {
    patches.push(event);
  });
  receiver.on('frame', event => {
    if (event.result.mode !== mode) return;
    assert(event.partial === false, `${mode.name} emitted a legacy partial frame`);
    finalFrames.push(event);
  });
  const chunkSize = Math.floor(11025 / 4);
  for (let offset = 0; offset < pcm.length; offset += chunkSize) {
    receiver.push(pcm.subarray(offset, Math.min(pcm.length, offset + chunkSize)), 11025);
  }
  assert(frameStarts.length === 1,
    `${mode.name} emitted ${frameStarts.length} frame-start event(s)`);
  assert(eventOrder.indexOf('locked') >= 0 &&
    eventOrder.indexOf('locked') < eventOrder.indexOf('frame-start'),
  `${mode.name} emitted frame-start before locked: ${eventOrder.join(', ')}`);
  assert(frameStarts[0].width === mode.width && frameStarts[0].height === mode.height,
    `${mode.name} frame-start dimensions are invalid`);
  assert(patches.length > 4,
    `${mode.name} emitted only ${patches.length} frame patch(es) before end()`);
  assert(patches.every((patch, index) => {
    const expectedLength = mode.width * patch.rowCount * 4;
    const previousRows = index ? patches[index - 1].rows : 0;
    return patch.frameId === frameStarts[0].frameId &&
      Number.isSafeInteger(patch.y) && patch.y >= 0 &&
      Number.isSafeInteger(patch.rowCount) && patch.rowCount > 0 &&
      patch.y + patch.rowCount <= mode.height &&
      patch.rows >= patch.y + patch.rowCount && patch.rows >= previousRows &&
      patch.totalRows === mode.height &&
      patch.pixels instanceof Uint8ClampedArray &&
      patch.pixels.length === expectedLength &&
      patch.pixels.some((value, offset) => offset % 4 !== 3 && value !== 0);
  }), `${mode.name} emitted an invalid, black, or out-of-order frame patch`);
  assert(patches[0].rows < mode.height * 0.2,
    `${mode.name} first frame patch was too late: ${patches[0].rows} / ${mode.height}`);
  const result = receiver.end();
  assert(patches.at(-1)?.rows === mode.height,
    `${mode.name} did not flush its last progressive row: ${patches.at(-1)?.rows} / ${mode.height}`);
  assert(finalFrames.length === 1,
    `${mode.name} emitted ${finalFrames.length} final frame(s)`);
  assert(result === finalFrames[0].result, `${mode.name} end() did not return its sole final frame`);
  assert(finalFrames[0].complete === true && finalFrames[0].completionRatio === 1 &&
    finalFrames[0].rows === mode.height,
  `${mode.name} final event did not report complete reconstruction`);
  let coloredSamples = 0;
  for (let i = 0; i < result.pixels.length; i += 4) {
    if (result.pixels[i] || result.pixels[i + 1] || result.pixels[i + 2]) coloredSamples++;
  }
  assert(coloredSamples > mode.width * mode.height * 0.25,
    `${mode.name} final frame is blank or mostly black: ${coloredSamples} colored pixels`);
}

// A failed authoritative decode must explicitly retire its provisional page
// before returning to acquisition; otherwise the UI retains an unsavable live
// frame forever. The frame identifier binds the failure to that page.
{
  const mode = getMode(2);
  const encoded = encode(image(mode), mode, { sampleRate: 11025 });
  const pcm = new Float32Array(encoded.length + Math.ceil(0.2 * 11025));
  pcm.set(encoded);
  const receiver = new SSTVReceiver({
    dsp: { engine: 'mmsstv', bpf: true },
    emitFrames: true,
  });
  const order = [];
  let frameId = null;
  let failedFrameId = null;
  let failedNaturalEnds = 0;
  receiver.on('locked', () => {
    order.push('locked');
    receiver.decodeCurrentFrame = () => { throw new Error('synthetic final failure'); };
  });
  receiver.on('frame-start', event => {
    order.push('frame-start');
    frameId = event.frameId;
  });
  receiver.on('frame-error', event => {
    order.push('frame-error');
    failedFrameId = event.frameId;
  });
  receiver.on('transmission-ended', () => { failedNaturalEnds++; });
  receiver.on('searching', () => { order.push('searching'); });
  for (let offset = 0; offset < pcm.length; offset += 997) {
    receiver.push(pcm.subarray(offset, Math.min(pcm.length, offset + 997)), 11025);
  }
  assert(frameId != null && failedFrameId === frameId,
    `failed final did not retire provisional frame ${frameId}: ${failedFrameId}`);
  assert(failedNaturalEnds === 0,
    'failed authoritative decode emitted transmission-ended');
  assert(order.indexOf('locked') < order.indexOf('frame-start') &&
    order.indexOf('frame-start') < order.indexOf('frame-error') &&
    order.indexOf('frame-error') < order.indexOf('searching'),
  `failed final event order is invalid: ${order.join(', ')}`);
}

console.log('Streaming checks passed: native PCM, bounded rolling acquisition, progressive updates, consecutive frames, resampler, CPLL, VIS/FSK, sync/manual start and fixed sample rate');
