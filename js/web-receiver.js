import { StreamingSnrEstimator } from './fft.js';

const DECODER_WORKER_PROTOCOL = 6;
const DECODER_WORKER_READY_TIMEOUT_MS = 5000;
const AUDIO_INPUT_MIN_SAMPLE_RATE = 8000;
const AUDIO_INPUT_MAX_SAMPLE_RATE = 192000;
const AUDIO_INPUT_MAX_SAMPLES = 50 * 1024 * 1024;
const AUDIO_PUSH_MAX_SAMPLES = 4 * 1024 * 1024;
const MICROPHONE_RECORDING_MAX_SECONDS = 10 * 60;
const MICROPHONE_RECORDING_MAX_SAMPLES = 32 * 1024 * 1024;
const MICROPHONE_RECORDING_INITIAL_SECONDS = 30;

function snrFftSize(sampleRate) {
  const target = Math.max(2048, sampleRate * 0.15);
  let size = 2048;
  while (size < target && size < 16384) size *= 2;
  return size;
}

function assertAudioInput(samples, sampleRate, maxSamples = AUDIO_INPUT_MAX_SAMPLES) {
  if (!(samples instanceof Float32Array) || !Number.isSafeInteger(samples.length) ||
      samples.length < 1 || samples.length > maxSamples) {
    throw new Error('Audio sample buffer exceeds the safety limit');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < AUDIO_INPUT_MIN_SAMPLE_RATE ||
      sampleRate > AUDIO_INPUT_MAX_SAMPLE_RATE) {
    throw new Error('Audio sample rate exceeds the supported range');
  }
}

export class WebSSTVDecoder extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.workerProtocolVersion = null;
    this.workerReadyPromise = null;
    this.resolveWorkerReady = null;
    this.workerDecoderOptions = null;
    this.workerGeneration = 0;
    this.receiverSessionId = 0;
    this.activeReceiverSessionId = 0;
    this.receiverEndRequestId = 0;
    this.receiverEndPending = new Map();
    this.receiverEndInFlight = null;
    this.destroyed = false;
    this.spawnWorker();
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.capture = null;
    this.muted = null;
    this.recordingBuffer = null;
    this.recordingLength = 0;
    this.recordingSampleRate = 0;
    this.recordingMaxSamples = 0;
    this.recordingLimitReached = false;
    this.microphoneSessionId = 0;
    this.microphoneStopPromise = null;
    this.snrConfig = null;
    this.snrEstimator = null;
    this.snrSampleRate = 0;
    this.batchJobId = 0;
    this.batchPending = null;
  }

  spawnWorker() {
    if (this.destroyed) throw new Error('Decoder destroyed');
    this.workerProtocolVersion = null;
    this.workerReadyPromise = new Promise(resolve => { this.resolveWorkerReady = resolve; });
    const worker = new Worker(
      new URL(`./decoder-worker.js?v=${DECODER_WORKER_PROTOCOL}`, import.meta.url),
      { type: 'module' }
    );
    this.worker = worker;
    const generation = ++this.workerGeneration;
    worker.onmessage = ({ data }) => {
      if (worker !== this.worker || generation !== this.workerGeneration ||
          typeof data?.type !== 'string') return;
      if (data.type === 'decoder-ready') {
        this.workerProtocolVersion = data.protocolVersion;
        this.resolveWorkerReady();
        return;
      }
      if (data.type.startsWith('batch-')) {
        if (!this.batchPending || data.jobId !== this.batchPending.jobId) return;
        this.dispatchEvent(new CustomEvent(data.type, { detail: data }));
        if (data.type === 'batch-frame') {
          this.batchPending.frames.push(data.frame);
        } else if (data.type === 'batch-progress') {
          const progress = 0.05 + Math.max(0, Math.min(1, data.progress)) * 0.95;
          this.reportBatchProgress(this.batchPending, progress);
        } else if (data.type === 'batch-complete') {
          const pending = this.batchPending;
          this.batchPending = null;
          pending.resolve({ frames: pending.frames, skippedCount: data.skippedCount || 0 });
        } else if (data.type === 'batch-error') {
          const pending = this.batchPending;
          this.batchPending = null;
          pending.reject(new Error(data.message));
        }
        return;
      }
      if (data.type === 'receiver-ended') {
        const pending = this.receiverEndPending.get(data.requestId);
        if (pending && pending.sessionId === data.sessionId) {
          this.receiverEndPending.delete(data.requestId);
          // Decoder failure is delivered through the session's error event.
          // The end acknowledgement is still a successful ordering barrier so
          // microphone cleanup and recording retrieval cannot be stranded.
          pending.resolve(data);
        }
        if (data.error && this.pending?.sessionId === data.sessionId) {
          this.pending.reject(new Error(data.error));
          this.pending = null;
        }
        return;
      }
      // reset(), seeking, file loads and a following microphone session may all
      // overtake messages that the previous receiver already queued. Never let
      // those stale frames update the UI or settle another decode promise.
      if (!Number.isSafeInteger(data.sessionId) ||
          data.sessionId !== this.activeReceiverSessionId) return;
      this.dispatchEvent(new CustomEvent(data.type, { detail: data }));
      if (data.type === 'frame' && !data.partial && this.pending?.sessionId === data.sessionId) {
        this.pending.resolve(data.result);
        this.pending = null;
      } else if (data.type === 'error' && this.pending?.sessionId === data.sessionId) {
        this.pending.reject(new Error(data.message));
        this.pending = null;
      }
    };
    worker.onerror = event => {
      if (worker !== this.worker || generation !== this.workerGeneration) return;
      const message = event.message || 'Decoder worker failed';
      this.dispatchEvent(new CustomEvent('error', { detail: { message } }));
      if (this.pending) {
        this.pending.reject(new Error(message));
        this.pending = null;
      }
      if (this.batchPending) {
        this.batchPending.reject(new Error(message));
        this.batchPending = null;
      }
      this.releaseReceiverEnds(message);
    };
    return worker;
  }

  replaceWorker({ restoreReceiver = true } = {}) {
    const oldWorker = this.worker;
    const releaseOldReadyWaiters = this.resolveWorkerReady;
    this.worker = null;
    this.workerGeneration++;
    releaseOldReadyWaiters?.();
    oldWorker?.terminate();
    this.releaseReceiverEnds('Decoder worker restarted');
    const worker = this.spawnWorker();
    if (restoreReceiver && this.workerDecoderOptions) {
      worker.postMessage({
        type: 'reset',
        sessionId: this.activeReceiverSessionId,
        options: this.workerDecoderOptions,
      });
    }
    return worker;
  }

  reset(options = {}) {
    if (this.destroyed || !this.worker) throw new Error('Decoder destroyed');
    if (this.pending) {
      this.pending.reject(new Error('Decode replaced by a newer receiver session'));
      this.pending = null;
    }
    this.cancelBatch('Batch decode reset');
    const { emitSnr = false, ...decoderOptions } = options;
    const baseband = options.dsp?.baseband || {};
    this.snrConfig = emitSnr === true
      ? { lowHz: baseband.lowHz, highHz: baseband.highHz }
      : null;
    this.snrEstimator = null;
    this.snrSampleRate = 0;
    this.workerDecoderOptions = decoderOptions;
    const sessionId = ++this.receiverSessionId;
    this.activeReceiverSessionId = sessionId;
    this.receiverEndInFlight = null;
    this.worker.postMessage({ type: 'reset', sessionId, options: decoderOptions });
    return sessionId;
  }

  push(samples, sampleRate, sessionId = this.activeReceiverSessionId) {
    if (this.destroyed || !this.worker) throw new Error('Decoder destroyed');
    assertAudioInput(samples, sampleRate, AUDIO_PUSH_MAX_SAMPLES);
    const transferable = samples.slice();
    this.worker.postMessage({
      type: 'push',
      sessionId,
      samples: transferable.buffer,
      sampleRate,
    }, [transferable.buffer]);
    this.updateSnr(samples, sampleRate);
  }

  updateSnr(samples, sampleRate) {
    if (!this.snrConfig) return;
    try {
      if (!this.snrEstimator) {
        const fftSize = snrFftSize(sampleRate);
        this.snrEstimator = new StreamingSnrEstimator(sampleRate, {
          ...this.snrConfig,
          fftSize,
          hopSize: fftSize / 2,
        });
        this.snrSampleRate = sampleRate;
      }
      if (sampleRate !== this.snrSampleRate) return;
      const estimate = this.snrEstimator.push(samples);
      if (estimate) {
        this.dispatchEvent(new CustomEvent('snr', {
          detail: { type: 'snr', ...estimate },
        }));
      }
    } catch (error) {
      // A display-only metric must never interrupt audio delivery to the decoder Worker.
      console.warn('SNR meter disabled:', error);
      this.snrConfig = null;
      this.snrEstimator = null;
    }
  }

  end(sessionId = this.activeReceiverSessionId) {
    if (this.destroyed || !this.worker) {
      return Promise.reject(new Error('Decoder destroyed'));
    }
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) return Promise.resolve(null);
    if (this.receiverEndInFlight?.sessionId === sessionId) {
      return this.receiverEndInFlight.promise;
    }
    const requestId = ++this.receiverEndRequestId;
    const promise = new Promise(resolve => {
      this.receiverEndPending.set(requestId, { sessionId, resolve });
      try {
        this.worker.postMessage({ type: 'end', sessionId, requestId });
      } catch (error) {
        this.receiverEndPending.delete(requestId);
        const message = error instanceof Error ? error.message : String(error);
        this.dispatchEvent(new CustomEvent('error', {
          detail: { type: 'error', sessionId, message },
        }));
        resolve({ sessionId, requestId, error: message });
      }
    }).finally(() => {
      if (this.receiverEndInFlight?.requestId === requestId) this.receiverEndInFlight = null;
    });
    this.receiverEndInFlight = { sessionId, requestId, promise };
    return promise;
  }

  releaseReceiverEnds(message) {
    for (const pending of this.receiverEndPending.values()) {
      pending.resolve({ sessionId: pending.sessionId, cancelled: true, error: message });
    }
    this.receiverEndPending.clear();
    this.receiverEndInFlight = null;
  }

  cancelReceiver() {
    return this.reset({ emitFrames: false, autoSync: false });
  }

  rearmReceiver(sessionId = this.activeReceiverSessionId) {
    if (this.destroyed || !this.worker) throw new Error('Decoder destroyed');
    if (!Number.isSafeInteger(sessionId) || sessionId < 1 ||
        sessionId !== this.activeReceiverSessionId) return false;
    this.worker.postMessage({ type: 'rearm', sessionId });
    return true;
  }

  decode(samples, sampleRate, options = {}) {
    assertAudioInput(samples, sampleRate);
    if (this.pending) this.pending.reject(new Error('A decode is already running'));
    // One-shot file decoding is final-frame-only unless a caller explicitly
    // asks for provisional frames. Live microphone/playback paths use reset()
    // directly with emitFrames:true.
    const sessionId = this.reset({ ...options, emitFrames: options.emitFrames === true });
    const promise = new Promise((resolve, reject) => {
      this.pending = { sessionId, resolve, reject };
    });
    try {
      const chunkSize = Math.max(2048, Math.floor(sampleRate / 2));
      for (let offset = 0; offset < samples.length; offset += chunkSize) {
        this.push(samples.subarray(offset, Math.min(samples.length, offset + chunkSize)), sampleRate);
      }
      void this.end(sessionId).catch(error => {
        if (this.pending?.sessionId !== sessionId) return;
        this.pending.reject(error);
        this.pending = null;
      });
    } catch (error) {
      if (this.pending?.sessionId === sessionId) {
        const pending = this.pending;
        this.pending = null;
        pending.reject(error);
      }
      return promise;
    }
    return promise;
  }

  decodeAll(samples, sampleRate, options = {}) {
    if (this.destroyed || !this.worker) throw new Error('Decoder destroyed');
    assertAudioInput(samples, sampleRate);
    if (this.pending) {
      this.pending.reject(new Error('Batch decode replaced the active decode'));
      this.pending = null;
    }
    this.cancelBatch('Batch decode replaced by a newer job');
    const jobId = ++this.batchJobId;
    const { onProgress, ...workerOptions } = options;
    const promise = new Promise((resolve, reject) => {
      this.batchPending = { jobId, resolve, reject, frames: [], onProgress, lastProgress: 0 };
    });
    this.stageBatchAudio(jobId, samples, sampleRate, workerOptions).catch(error => {
      if (!this.batchPending || this.batchPending.jobId !== jobId) return;
      const pending = this.batchPending;
      this.batchPending = null;
      pending.reject(error);
    });
    return promise;
  }

  async stageBatchAudio(jobId, samples, sampleRate, options) {
    await this.waitForWorkerReady();
    await this.yieldToPage();
    if (!this.batchPending || this.batchPending.jobId !== jobId) return;
    this.worker.postMessage({
      type: 'batch-start',
      jobId,
      sampleRate,
      sampleCount: samples.length,
      options,
    });

    const chunkSize = Math.max(16384, Math.floor(sampleRate * 4));
    let chunkOrdinal = 0;
    for (let offset = 0; offset < samples.length; offset += chunkSize) {
      if (!this.batchPending || this.batchPending.jobId !== jobId) return;
      const end = Math.min(samples.length, offset + chunkSize);
      const chunk = samples.slice(offset, end);
      this.worker.postMessage(
        { type: 'batch-chunk', jobId, offset, samples: chunk.buffer },
        [chunk.buffer]
      );
      this.reportBatchProgress(this.batchPending, 0.05 * end / samples.length);
      chunkOrdinal++;
      if (chunkOrdinal % 4 === 0) await this.yieldToPage();
    }
    if (!this.batchPending || this.batchPending.jobId !== jobId) return;
    this.worker.postMessage({ type: 'batch-end', jobId });
  }

  async waitForWorkerReady() {
    const worker = this.worker;
    const generation = this.workerGeneration;
    const readyPromise = this.workerReadyPromise;
    if (this.workerProtocolVersion == null) {
      let timeoutId;
      try {
        await Promise.race([
          readyPromise,
          new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('解码 Worker 未响应，请刷新页面后重试')),
              DECODER_WORKER_READY_TIMEOUT_MS
            );
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
    }
    if (worker !== this.worker || generation !== this.workerGeneration) {
      throw new Error('Decoder worker was replaced');
    }
    if (this.workerProtocolVersion !== DECODER_WORKER_PROTOCOL) {
      throw new Error(
        `解码 Worker 版本不匹配 (${this.workerProtocolVersion ?? 'unknown'} / ${DECODER_WORKER_PROTOCOL})，请刷新页面后重试`
      );
    }
  }

  reportBatchProgress(pending, value) {
    const progress = Math.max(pending.lastProgress, Math.min(1, Number(value) || 0));
    pending.lastProgress = progress;
    pending.onProgress?.(progress);
  }

  yieldToPage() {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }

  cancelBatch(message = 'Batch decode cancelled') {
    this.batchJobId++;
    if (!this.batchPending) return;
    const pending = this.batchPending;
    this.batchPending = null;
    pending.reject(new Error(message));
    // decodeAll() is synchronous once batch-end is received, so a message-based
    // cancel cannot pre-empt it. Terminating the Worker is the actual stop.
    this.replaceWorker({ restoreReceiver: true });
  }

  async startMicrophone(options = {}) {
    if (this.destroyed || !this.worker) throw new Error('Decoder destroyed');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集');
    if (!window.isSecureContext) throw new Error('麦克风实时接收需要 HTTPS 或 localhost');
    await this.stopMicrophone(false);
    if (this.destroyed || !this.worker) throw new Error('Decoder destroyed');
    const { recording: configuredRecordingOptions = {}, ...decoderOptions } = options;
    const recordingOptions = configuredRecordingOptions || {};
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio');
      this.audioContext = new AudioContextClass({ latencyHint: 'interactive' });
      await this.audioContext.audioWorklet.addModule(new URL('./pcm-capture-worklet.js', import.meta.url));
      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.capture = new AudioWorkletNode(this.audioContext, 'pcm-capture');
      this.beginMicrophoneRecording(this.audioContext.sampleRate, recordingOptions);
      this.muted = this.audioContext.createGain();
      this.muted.gain.value = 0;
      this.source.connect(this.capture).connect(this.muted).connect(this.audioContext.destination);
      this.microphoneSessionId = this.reset({
        ...decoderOptions, emitFrames: true, emitSnr: true, renderEveryRows: 8,
      });
      const capture = this.capture;
      const context = this.audioContext;
      const sessionId = this.microphoneSessionId;
      capture.port.onmessage = ({ data }) => {
        // Pin every worklet callback to the objects/session that created it.
        // A queued callback from a stopped microphone must never feed a newer
        // session or append into its recording buffer.
        if (this.capture !== capture || this.audioContext !== context ||
            this.microphoneSessionId !== sessionId) return;
        this.push(data, context.sampleRate, sessionId);
        // recording-limit listeners may stop the receiver synchronously, so
        // deliver this final chunk before emitting that limit signal.
        this.appendMicrophoneRecording(data);
      };
      await this.audioContext.resume();
      const interrupted = () => {
        if (this.audioContext === context && this.capture === capture) {
          this.dispatchEvent(new CustomEvent('input-interrupted', { detail: { sessionId } }));
        }
      };
      for (const track of this.stream.getTracks()) {
        track.addEventListener?.('ended', interrupted, { once: true });
        track.addEventListener?.('mute', interrupted, { once: true });
      }
      context.addEventListener?.('statechange', () => {
        if (context.state === 'interrupted') interrupted();
      });
    } catch (error) {
      try { await this.stopMicrophone(false); } catch (_) {}
      throw error;
    }
  }

  stopMicrophone(finalize = true) {
    if (this.microphoneStopPromise) return this.microphoneStopPromise;
    const promise = this.performStopMicrophone(finalize);
    this.microphoneStopPromise = promise;
    const release = () => {
      if (this.microphoneStopPromise === promise) this.microphoneStopPromise = null;
    };
    promise.then(release, release);
    return promise;
  }

  async performStopMicrophone(finalize = true) {
    const capture = this.capture;
    const source = this.source;
    const muted = this.muted;
    const stream = this.stream;
    const audioContext = this.audioContext;
    const microphoneSessionId = this.microphoneSessionId;
    this.capture = null;
    this.source = null;
    this.muted = null;
    this.stream = null;
    this.audioContext = null;
    this.microphoneSessionId = 0;
    if (capture?.port) capture.port.onmessage = null;
    // AudioWorklet messages are asynchronous. A stop click can race the first
    // capture message (especially on a freshly-created context), leaving an
    // apparently successful session with no retained samples. Preserve a
    // bounded silence frame so the local recording/save path remains explicit
    // and deterministic even for an immediate stop.
    if (finalize && capture && !this.recordingLength && this.recordingSampleRate) {
      const minimumSamples = Math.max(1, Math.min(
        this.recordingMaxSamples,
        Math.floor(this.recordingSampleRate * 0.02)
      ));
      this.appendMicrophoneRecording(new Float32Array(minimumSamples));
    }
    for (const node of [capture, source, muted]) {
      try { node?.disconnect(); } catch (_) {}
    }
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop(); } catch (_) {}
    }
    if (audioContext && audioContext.state !== 'closed') {
      try { await audioContext.close(); } catch (_) {}
    }
    // receiver-ended is posted only after all final frame/error events from
    // this session, making stop a real completion barrier for the UI.
    if (finalize && capture) await this.end(microphoneSessionId);
    else if (capture && microphoneSessionId === this.activeReceiverSessionId &&
             !this.destroyed && this.worker) this.cancelReceiver();
    const recording = finalize ? this.takeMicrophoneRecording() : null;
    this.snrConfig = null;
    this.snrEstimator = null;
    this.snrSampleRate = 0;
    if (!finalize) this.clearMicrophoneRecording();
    return recording;
  }

  beginMicrophoneRecording(sampleRate, options = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate < AUDIO_INPUT_MIN_SAMPLE_RATE ||
        sampleRate > AUDIO_INPUT_MAX_SAMPLE_RATE) {
      throw new Error('麦克风采样率无效');
    }
    const requestedSeconds = Number(options.maxSeconds);
    const maxSeconds = Number.isFinite(requestedSeconds) && requestedSeconds > 0
      ? Math.min(MICROPHONE_RECORDING_MAX_SECONDS, requestedSeconds)
      : MICROPHONE_RECORDING_MAX_SECONDS;
    const requestedSamples = Number(options.maxSamples);
    const configuredSamples = Number.isSafeInteger(requestedSamples) && requestedSamples > 0
      ? Math.min(MICROPHONE_RECORDING_MAX_SAMPLES, requestedSamples)
      : MICROPHONE_RECORDING_MAX_SAMPLES;
    this.recordingMaxSamples = Math.max(1, Math.min(configuredSamples, Math.floor(sampleRate * maxSeconds)));
    const initialCapacity = Math.min(
      this.recordingMaxSamples,
      Math.max(128, Math.floor(sampleRate * MICROPHONE_RECORDING_INITIAL_SECONDS))
    );
    this.recordingBuffer = new Float32Array(initialCapacity);
    this.recordingLength = 0;
    this.recordingSampleRate = sampleRate;
    this.recordingLimitReached = false;
  }

  takeMicrophoneRecording() {
    if (!this.recordingLength || !this.recordingSampleRate) {
      this.clearMicrophoneRecording();
      return null;
    }
    // Return a view into the bounded recording buffer. This avoids allocating
    // and copying the complete recording at the exact moment capture stops.
    const samples = this.recordingBuffer.subarray(0, this.recordingLength);
    const recording = {
      samples,
      sampleRate: this.recordingSampleRate,
      limitReached: this.recordingLimitReached,
      maxSamples: this.recordingMaxSamples,
    };
    this.clearMicrophoneRecording();
    return recording;
  }

  clearMicrophoneRecording() {
    this.recordingBuffer = null;
    this.recordingLength = 0;
    this.recordingSampleRate = 0;
    this.recordingMaxSamples = 0;
    this.recordingLimitReached = false;
  }

  appendMicrophoneRecording(samples) {
    if (!this.recordingBuffer || this.recordingLimitReached || !samples?.length) return;
    const writable = Math.min(samples.length, this.recordingMaxSamples - this.recordingLength);
    if (writable > 0) {
      this.ensureRecordingCapacity(this.recordingLength + writable);
      this.recordingBuffer.set(samples.subarray(0, writable), this.recordingLength);
      this.recordingLength += writable;
    }
    if (this.recordingLength >= this.recordingMaxSamples && !this.recordingLimitReached) {
      this.recordingLimitReached = true;
      this.dispatchEvent(new CustomEvent('recording-limit', {
        detail: {
          type: 'recording-limit',
          sampleRate: this.recordingSampleRate,
          samples: this.recordingLength,
          maxSamples: this.recordingMaxSamples,
          durationSeconds: this.recordingLength / this.recordingSampleRate,
        },
      }));
    }
  }

  ensureRecordingCapacity(required) {
    if (required <= this.recordingBuffer.length) return;
    const grown = Math.max(required, Math.ceil(this.recordingBuffer.length * 1.5));
    const capacity = Math.min(this.recordingMaxSamples, grown);
    if (!Number.isSafeInteger(capacity) || capacity < required) throw new Error('录音缓冲区超出安全上限');
    const next = new Float32Array(capacity);
    next.set(this.recordingBuffer.subarray(0, this.recordingLength));
    this.recordingBuffer = next;
  }

  destroy() {
    this.cancelBatch('Decoder destroyed');
    if (this.pending) {
      this.pending.reject(new Error('Decoder destroyed'));
      this.pending = null;
    }
    this.releaseReceiverEnds('Decoder destroyed');
    this.destroyed = true;
    void this.stopMicrophone(false).catch(() => {});
    this.worker?.terminate();
    this.worker = null;
  }
}
