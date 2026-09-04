// SPDX-License-Identifier: LGPL-3.0-or-later
import { SSTVReceiver } from './receiver.js';
import { decodeAll } from './decoder.js';

const DECODER_WORKER_PROTOCOL = 6;
const AUDIO_INPUT_MIN_SAMPLE_RATE = 8000;
const AUDIO_INPUT_MAX_SAMPLE_RATE = 192000;
const AUDIO_INPUT_MAX_SAMPLES = 50 * 1024 * 1024;
let receiver = null;
let receiverSessionId = 0;
let batchUpload = null;

self.postMessage({ type: 'decoder-ready', protocolVersion: DECODER_WORKER_PROTOCOL });

function assertSessionId(sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error('Invalid receiver session ID');
}

function create(options = {}, sessionId) {
  assertSessionId(sessionId);
  receiverSessionId = sessionId;
  const eventSessionId = sessionId;
  const receiverOptions = options.emitFrames === false
    ? {
        ...options,
        onProgress: progress => self.postMessage({
          type: 'decode-progress', sessionId: eventSessionId, progress,
        }),
      }
    : options;
  receiver = new SSTVReceiver(receiverOptions);
  receiver.on('*', event => {
    if (event.type === 'frame') {
      const result = event.result;
      const pixels = result.pixels.slice();
      self.postMessage({ ...event, sessionId: eventSessionId, result: { ...result, pixels } }, [pixels.buffer]);
    } else if (event.type === 'frame-patch') {
      const pixels = event.pixels;
      self.postMessage({ ...event, sessionId: eventSessionId, pixels }, [pixels.buffer]);
    } else if (event.type === 'error') {
      self.postMessage({ type: 'error', sessionId: eventSessionId, message: event.message });
    } else {
      self.postMessage({ ...event, sessionId: eventSessionId });
    }
  });
}

function assertSampleRate(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate < AUDIO_INPUT_MIN_SAMPLE_RATE ||
      sampleRate > AUDIO_INPUT_MAX_SAMPLE_RATE) {
    throw new Error('Audio sample rate exceeds the supported range');
  }
}

function assertJobId(jobId) {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error('Invalid batch job ID');
}

self.onmessage = ({ data }) => {
  const type = typeof data?.type === 'string' ? data.type : '';
  try {
    if (type === 'reset') create(data.options, data.sessionId);
    else if (type === 'rearm') {
      assertSessionId(data.sessionId);
      if (receiver && data.sessionId === receiverSessionId) receiver.rearm();
    }
    else if (type === 'batch-start') {
      if (batchUpload) throw new Error('A batch upload is already active');
      assertJobId(data.jobId);
      assertSampleRate(data.sampleRate);
      if (!Number.isSafeInteger(data.sampleCount) || data.sampleCount < 1 ||
          data.sampleCount > AUDIO_INPUT_MAX_SAMPLES) {
        throw new Error('Batch audio exceeds the sample limit');
      }
      batchUpload = {
        jobId: data.jobId,
        sampleRate: data.sampleRate,
        options: data.options || {},
        samples: new Float32Array(data.sampleCount),
        nextOffset: 0,
      };
    }
    else if (type === 'batch-chunk') {
      if (!batchUpload || data.jobId !== batchUpload.jobId) return;
      if (!(data.samples instanceof ArrayBuffer) || data.samples.byteLength % 4 !== 0 ||
          !Number.isSafeInteger(data.offset) || data.offset !== batchUpload.nextOffset) {
        throw new Error('Invalid or out-of-order batch audio chunk');
      }
      const chunk = new Float32Array(data.samples);
      if (chunk.length < 1 || chunk.length > batchUpload.samples.length - data.offset) {
        throw new Error('Batch audio chunk exceeds the declared sample count');
      }
      batchUpload.samples.set(chunk, data.offset);
      batchUpload.nextOffset += chunk.length;
    }
    else if (type === 'batch-end') {
      if (!batchUpload || data.jobId !== batchUpload.jobId) return;
      const batch = batchUpload;
      batchUpload = null;
      if (batch.nextOffset !== batch.samples.length) {
        throw new Error(`Incomplete batch audio: ${batch.nextOffset} / ${batch.samples.length}`);
      }
      const output = decodeAll(batch.samples, batch.sampleRate, {
        ...batch.options,
        onProgress: progress => self.postMessage({ type: 'batch-progress', jobId: batch.jobId, progress }),
        onFrame: frame => {
          self.postMessage(
            { type: 'batch-frame', jobId: batch.jobId, frame },
            [frame.result.pixels.buffer]
          );
        },
      });
      self.postMessage({
        type: 'batch-complete',
        jobId: batch.jobId,
        frameCount: output.frames.length,
        skippedCount: output.skippedCount,
      });
    }
    else if (type === 'push') {
      assertSessionId(data.sessionId);
      if (receiver && data.sessionId !== receiverSessionId) return;
      assertSampleRate(data.sampleRate);
      if (!(data.samples instanceof ArrayBuffer) || data.samples.byteLength < 4 ||
          data.samples.byteLength % 4 !== 0 || data.samples.byteLength / 4 > AUDIO_INPUT_MAX_SAMPLES) {
        throw new Error('Streaming audio exceeds the sample limit');
      }
      if (!receiver) create(data.options, data.sessionId);
      receiver.push(new Float32Array(data.samples), data.sampleRate);
    } else if (type === 'end') {
      assertSessionId(data.sessionId);
      if (!Number.isSafeInteger(data.requestId) || data.requestId < 1) {
        throw new Error('Invalid receiver end request ID');
      }
      if (!receiver || data.sessionId !== receiverSessionId) {
        self.postMessage({
          type: 'receiver-ended', sessionId: data.sessionId, requestId: data.requestId, cancelled: true,
        });
        return;
      }
      let endError = null;
      try {
        receiver.end();
      } catch (error) {
        endError = error instanceof Error ? error.message : String(error);
      }
      self.postMessage({
        type: 'receiver-ended',
        sessionId: data.sessionId,
        requestId: data.requestId,
        ...(endError ? { error: endError } : {}),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (type.startsWith('batch-')) {
      if (batchUpload?.jobId === data?.jobId) batchUpload = null;
      self.postMessage({ type: 'batch-error', jobId: data?.jobId, message });
    } else {
      self.postMessage({
        type: 'error',
        sessionId: data?.sessionId,
        requestId: data?.requestId,
        message,
      });
      if (type === 'end' && Number.isSafeInteger(data?.requestId)) {
        self.postMessage({
          type: 'receiver-ended',
          sessionId: data?.sessionId,
          requestId: data.requestId,
          error: message,
        });
      }
    }
  }
};
