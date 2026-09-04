import assert from 'node:assert/strict';
import { WebSSTVDecoder } from './js/web-receiver.js';

const DECODER_WORKER_PROTOCOL = 6;

class FakeWorker {
  static instances = [];

  constructor() {
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    if (this.terminated) return;
    this.messages.push(message);
    if (message.type === 'end') {
      queueMicrotask(() => this.emit({
        type: 'receiver-ended',
        sessionId: message.sessionId,
        requestId: message.requestId,
      }));
    }
  }

  emit(data) {
    this.onmessage?.({ data });
  }

  terminate() {
    this.terminated = true;
  }
}

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  writable: true,
  value: FakeWorker,
});

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 10));
}

function createMicrophoneEnvironment(failurePoint) {
  const state = {
    trackStopped: false,
    contextClosed: false,
    source: null,
    capture: null,
    muted: null,
  };
  const track = { stop() { state.trackStopped = true; } };
  const stream = { getTracks() { return [track]; } };

  class FakeNode {
    constructor(withPort = false) {
      this.disconnected = false;
      this.gain = { value: 1 };
      if (withPort) this.port = { onmessage: null };
    }

    connect(next) { return next; }
    disconnect() { this.disconnected = true; }
  }

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = new FakeNode();
      this.audioWorklet = {
        addModule: async () => {
          if (failurePoint === 'worklet') throw new Error('worklet initialization failed');
        },
      };
    }

    createMediaStreamSource() {
      state.source = new FakeNode();
      return state.source;
    }

    createGain() {
      state.muted = new FakeNode();
      return state.muted;
    }

    async resume() {
      if (failurePoint === 'resume') throw new Error('audio context resume failed');
    }

    async close() {
      state.contextClosed = true;
      this.state = 'closed';
    }
  }

  class FakeAudioWorkletNode extends FakeNode {
    constructor() {
      super(true);
      state.capture = this;
    }
  }

  return {
    state,
    navigator: { mediaDevices: { async getUserMedia() { return stream; } } },
    window: { isSecureContext: true, AudioContext: FakeAudioContext },
    AudioWorkletNode: FakeAudioWorkletNode,
  };
}

async function verifyMicrophoneFailureCleanup(failurePoint) {
  const environment = createMicrophoneEnvironment(failurePoint);
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: environment.navigator,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: environment.window,
  });
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    value: environment.AudioWorkletNode,
  });

  const decoder = new WebSSTVDecoder();
  try {
    await assert.rejects(decoder.startMicrophone(), new RegExp(failurePoint));
    assert.equal(environment.state.trackStopped, true,
      `${failurePoint} failure left a microphone track running`);
    assert.equal(environment.state.contextClosed, true,
      `${failurePoint} failure left an AudioContext open`);
    assert.equal(decoder.stream, null);
    assert.equal(decoder.audioContext, null);
    assert.equal(decoder.recordingBuffer, null);
    if (failurePoint === 'resume') {
      assert.equal(environment.state.source.disconnected, true);
      assert.equal(environment.state.capture.disconnected, true);
      assert.equal(environment.state.muted.disconnected, true);
      assert.equal(environment.state.capture.port.onmessage, null);
    }
  } finally {
    decoder.destroy();
    restoreGlobal('navigator', originalNavigator);
    restoreGlobal('window', originalWindow);
    restoreGlobal('AudioWorkletNode', originalAudioWorkletNode);
  }
}

try {
  await verifyMicrophoneFailureCleanup('worklet');
  await verifyMicrophoneFailureCleanup('resume');

  const recordingDecoder = new WebSSTVDecoder();
  let limitEvent = null;
  recordingDecoder.addEventListener('recording-limit', event => { limitEvent = event.detail; });
  recordingDecoder.beginMicrophoneRecording(8000, { maxSamples: 4, maxSeconds: 1 });
  recordingDecoder.appendMicrophoneRecording(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]));
  recordingDecoder.appendMicrophoneRecording(new Float32Array([0.6]));
  const recording = recordingDecoder.takeMicrophoneRecording();
  assert.equal(recording.samples.length, 4);
  assert.equal(recording.limitReached, true);
  assert.equal(recording.maxSamples, 4);
  assert.equal(limitEvent.samples, 4);
  assert.equal(limitEvent.durationSeconds, 4 / 8000);
  recordingDecoder.destroy();

  const immediateStopDecoder = new WebSSTVDecoder();
  immediateStopDecoder.capture = { port: { onmessage: () => {} }, disconnect() {} };
  immediateStopDecoder.beginMicrophoneRecording(8000, { maxSamples: 8000, maxSeconds: 1 });
  const immediateRecording = await immediateStopDecoder.stopMicrophone(true);
  assert.equal(immediateRecording.samples.length, 160,
    'Immediate microphone stop should retain a short bounded silence frame');
  immediateStopDecoder.destroy();

  const sessionDecoder = new WebSSTVDecoder();
  const sessionWorker = sessionDecoder.worker;
  const firstSession = sessionDecoder.reset({ emitFrames: true });
  let deliveredFrames = 0;
  sessionDecoder.addEventListener('frame', () => { deliveredFrames++; });
  const secondSession = sessionDecoder.reset({ emitFrames: true });
  assert.notEqual(firstSession, secondSession);
  sessionWorker.emit({
    type: 'frame',
    sessionId: firstSession,
    partial: false,
    result: { width: 1, height: 1, pixels: new Uint8ClampedArray(4) },
  });
  assert.equal(deliveredFrames, 0, 'A stale receiver session reached current UI listeners');
  sessionWorker.emit({
    type: 'frame',
    sessionId: secondSession,
    partial: false,
    result: { width: 1, height: 1, pixels: new Uint8ClampedArray(4) },
  });
  assert.equal(deliveredFrames, 1, 'The active receiver session was filtered out');

  const endPromise = sessionDecoder.end(secondSession);
  const endMessage = sessionWorker.messages.find(message =>
    message.type === 'end' && message.sessionId === secondSession
  );
  assert.ok(endMessage?.requestId, 'Receiver finalization omitted its completion request ID');
  await endPromise;
  assert.equal(sessionDecoder.receiverEndPending.size, 0,
    'Receiver completion barrier did not release its pending request');
  sessionDecoder.destroy();

  const failedEndDecoder = new WebSSTVDecoder();
  const failedEndWorker = failedEndDecoder.worker;
  const failedEndSession = failedEndDecoder.reset({ emitFrames: true });
  const failedEndPromise = failedEndDecoder.end(failedEndSession);
  const failedEndMessage = failedEndWorker.messages.find(message => message.type === 'end');
  failedEndWorker.emit({
    type: 'receiver-ended',
    sessionId: failedEndSession,
    requestId: failedEndMessage.requestId,
    error: 'no SSTV frame found',
  });
  await failedEndPromise;
  failedEndDecoder.destroy();

  const destroyEnvironment = createMicrophoneEnvironment(null);
  const originalNavigatorForDestroy = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalWindowForDestroy = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalAudioWorkletForDestroy = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: destroyEnvironment.navigator });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: destroyEnvironment.window });
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    value: destroyEnvironment.AudioWorkletNode,
  });
  const destroyDecoder = new WebSSTVDecoder();
  let unhandledDestroyError = null;
  const captureUnhandled = error => { unhandledDestroyError = error; };
  process.once('unhandledRejection', captureUnhandled);
  try {
    await destroyDecoder.startMicrophone();
    const stalePortHandler = destroyDecoder.capture.port.onmessage;
    const sessionBeforeDestroy = destroyDecoder.microphoneSessionId;
    const messagesBeforeDestroy = destroyDecoder.worker.messages.length;
    destroyDecoder.destroy();
    stalePortHandler({ data: new Float32Array([0.1, 0.2]) });
    await tick();
    assert.equal(unhandledDestroyError, null,
      `Destroy leaked an unhandled microphone cleanup rejection: ${unhandledDestroyError?.message}`);
    assert.equal(destroyDecoder.worker, null);
    assert.equal(destroyDecoder.microphoneSessionId, 0);
    assert.equal(destroyDecoder.receiverSessionId, sessionBeforeDestroy,
      'Destroy created a new receiver session after terminating its Worker');
    assert.equal(FakeWorker.instances.at(-1).messages.length, messagesBeforeDestroy,
      'A stale AudioWorklet callback posted audio after destroy');
    assert.throws(() => destroyDecoder.reset(), /Decoder destroyed/);
    assert.throws(() => destroyDecoder.push(new Float32Array(1), 8000), /Decoder destroyed/);
    await assert.rejects(destroyDecoder.end(), /Decoder destroyed/);
  } finally {
    process.removeListener('unhandledRejection', captureUnhandled);
    restoreGlobal('navigator', originalNavigatorForDestroy);
    restoreGlobal('window', originalWindowForDestroy);
    restoreGlobal('AudioWorkletNode', originalAudioWorkletForDestroy);
  }

  const batchDecoder = new WebSSTVDecoder();
  batchDecoder.reset({ emitFrames: true, renderEveryRows: 8 });
  const firstWorker = batchDecoder.worker;
  firstWorker.emit({ type: 'decoder-ready', protocolVersion: DECODER_WORKER_PROTOCOL });
  const cancelledOutcome = batchDecoder
    .decodeAll(new Float32Array(32), 8000)
    .then(() => null, error => error);
  await tick();
  batchDecoder.cancelBatch('security cancellation test');
  const cancellationError = await cancelledOutcome;
  assert.match(cancellationError.message, /security cancellation test/);
  assert.equal(firstWorker.terminated, true, 'cancelBatch did not terminate the active Worker');
  const replacementWorker = batchDecoder.worker;
  assert.notEqual(replacementWorker, firstWorker);
  assert.ok(replacementWorker.messages.some(message => message.type === 'reset'),
    'replacement Worker did not restore receiver callbacks/options');
  firstWorker.emit({ type: 'batch-complete', jobId: 2, skippedCount: 0 });

  replacementWorker.emit({ type: 'decoder-ready', protocolVersion: DECODER_WORKER_PROTOCOL });
  let progressCalls = 0;
  const replacementResult = batchDecoder.decodeAll(new Float32Array(16), 8000, {
    onProgress() { progressCalls++; },
  });
  await tick();
  const batchStart = replacementWorker.messages.find(message => message.type === 'batch-start');
  assert.ok(batchStart, 'replacement Worker did not receive a new batch');
  replacementWorker.emit({ type: 'batch-progress', jobId: batchStart.jobId, progress: 0.5 });
  replacementWorker.emit({
    type: 'batch-complete',
    jobId: batchStart.jobId,
    frameCount: 0,
    skippedCount: 0,
  });
  assert.deepEqual(await replacementResult, { frames: [], skippedCount: 0 });
  assert.ok(progressCalls > 0, 'replacement Worker lost the batch progress callback');
  batchDecoder.destroy();

  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const workerMessages = [];
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: { postMessage(message) { workerMessages.push(message); } },
  });
  try {
    await import(`./js/decoder-worker.js?security-test=${Date.now()}`);
    assert.deepEqual(workerMessages.shift(), {
      type: 'decoder-ready',
      protocolVersion: DECODER_WORKER_PROTOCOL,
    });
    globalThis.self.onmessage({
      data: {
        type: 'batch-start',
        jobId: 1,
        sampleRate: 8000,
        sampleCount: 50 * 1024 * 1024 + 1,
      },
    });
    assert.equal(workerMessages.pop().type, 'batch-error',
      'Worker accepted a batch above its allocation limit');
    globalThis.self.onmessage({
      data: { type: 'batch-start', jobId: 2, sampleRate: 8000, sampleCount: 2 },
    });
    globalThis.self.onmessage({
      data: { type: 'batch-chunk', jobId: 2, offset: 1, samples: new ArrayBuffer(4) },
    });
    assert.equal(workerMessages.pop().type, 'batch-error',
      'Worker accepted an out-of-order batch chunk');
  } finally {
    restoreGlobal('self', originalSelf);
  }

  console.log('Security checks passed: microphone cleanup/destroy, recording cap, session isolation, Worker cancellation and limits');
} finally {
  restoreGlobal('Worker', originalWorker);
}
