import { StreamingSnrEstimator } from './fft.js';

const DECODER_WORKER_PROTOCOL = 3;
const DECODER_WORKER_READY_TIMEOUT_MS = 5000;

function snrFftSize(sampleRate) {
  const target = Math.max(2048, sampleRate * 0.15);
  let size = 2048;
  while (size < target && size < 16384) size *= 2;
  return size;
}

export class WebSSTVDecoder extends EventTarget {
  constructor() {
    super();
    this.workerProtocolVersion = null;
    this.workerReadyPromise = new Promise(resolve => { this.resolveWorkerReady = resolve; });
    this.worker = new Worker(
      new URL(`./decoder-worker.js?v=${DECODER_WORKER_PROTOCOL}`, import.meta.url),
      { type: 'module' }
    );
    this.worker.onmessage = ({ data }) => {
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
      this.dispatchEvent(new CustomEvent(data.type, { detail: data }));
      if (data.type === 'frame' && !data.partial && this.pending) {
        this.pending.resolve(data.result);
        this.pending = null;
      } else if (data.type === 'error' && this.pending) {
        this.pending.reject(new Error(data.message));
        this.pending = null;
      }
    };
    this.worker.onerror = event => {
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
    };
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.capture = null;
    this.snrConfig = null;
    this.snrEstimator = null;
    this.snrSampleRate = 0;
    this.batchJobId = 0;
    this.batchPending = null;
  }

  reset(options = {}) {
    this.cancelBatch('Batch decode reset');
    const { emitSnr = false, ...decoderOptions } = options;
    const baseband = options.dsp?.baseband || {};
    this.snrConfig = emitSnr === true
      ? { lowHz: baseband.lowHz, highHz: baseband.highHz }
      : null;
    this.snrEstimator = null;
    this.snrSampleRate = 0;
    this.worker.postMessage({ type: 'reset', options: decoderOptions });
  }

  push(samples, sampleRate) {
    const transferable = samples.slice();
    this.worker.postMessage({ type: 'push', samples: transferable.buffer, sampleRate }, [transferable.buffer]);
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

  end() {
    this.worker.postMessage({ type: 'end' });
  }

  decode(samples, sampleRate, options = {}) {
    if (this.pending) this.pending.reject(new Error('A decode is already running'));
    // One-shot file decoding is final-frame-only unless a caller explicitly
    // asks for provisional frames. Live microphone/playback paths use reset()
    // directly with emitFrames:true.
    this.reset({ ...options, emitFrames: options.emitFrames === true });
    const chunkSize = Math.max(2048, Math.floor(sampleRate / 2));
    for (let offset = 0; offset < samples.length; offset += chunkSize) {
      this.push(samples.subarray(offset, Math.min(samples.length, offset + chunkSize)), sampleRate);
    }
    this.end();
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  decodeAll(samples, sampleRate, options = {}) {
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
    if (this.workerProtocolVersion == null) {
      let timeoutId;
      try {
        await Promise.race([
          this.workerReadyPromise,
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
    this.batchPending.reject(new Error(message));
    this.batchPending = null;
  }

  async startMicrophone(options = {}) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集');
    if (!window.isSecureContext) throw new Error('麦克风实时接收需要 HTTPS 或 localhost');
    await this.stopMicrophone(false);
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass({ latencyHint: 'interactive' });
    await this.audioContext.audioWorklet.addModule(new URL('./pcm-capture-worklet.js', import.meta.url));
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.audioContext, 'pcm-capture');
    const muted = this.audioContext.createGain();
    muted.gain.value = 0;
    this.source.connect(this.capture).connect(muted).connect(this.audioContext.destination);
    this.reset({ ...options, emitFrames: true, emitSnr: true, renderEveryRows: 8 });
    this.capture.port.onmessage = ({ data }) => {
      const context = this.audioContext;
      if (context) this.push(data, context.sampleRate);
    };
    await this.audioContext.resume();
  }

  async stopMicrophone(finalize = true) {
    if (finalize && this.capture) this.end();
    this.capture?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks?.() || []) track.stop();
    if (this.audioContext && this.audioContext.state !== 'closed') await this.audioContext.close();
    this.capture = null;
    this.source = null;
    this.stream = null;
    this.audioContext = null;
    this.snrConfig = null;
    this.snrEstimator = null;
    this.snrSampleRate = 0;
  }

  destroy() {
    this.cancelBatch('Decoder destroyed');
    if (this.pending) {
      this.pending.reject(new Error('Decoder destroyed'));
      this.pending = null;
    }
    this.stopMicrophone(false);
    this.worker.terminate();
  }
}
