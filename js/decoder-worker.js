// SPDX-License-Identifier: LGPL-3.0-or-later
import { SSTVReceiver } from './receiver.js';
import { decodeAll } from './decoder.js';

const DECODER_WORKER_PROTOCOL = 3;
let receiver = null;
let batchUpload = null;

self.postMessage({ type: 'decoder-ready', protocolVersion: DECODER_WORKER_PROTOCOL });

function create(options = {}) {
  const receiverOptions = options.emitFrames === false
    ? {
        ...options,
        onProgress: progress => self.postMessage({ type: 'decode-progress', progress }),
      }
    : options;
  receiver = new SSTVReceiver(receiverOptions);
  receiver.on('*', event => {
    if (event.type === 'frame') {
      const result = event.result;
      const pixels = result.pixels.slice();
      self.postMessage({ ...event, result: { ...result, pixels } }, [pixels.buffer]);
    } else if (event.type === 'error') {
      self.postMessage({ type: 'error', message: event.message });
    } else {
      self.postMessage(event);
    }
  });
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'reset') create(data.options);
    else if (data.type === 'batch-start') {
      batchUpload = {
        jobId: data.jobId,
        sampleRate: data.sampleRate,
        options: data.options || {},
        samples: new Float32Array(data.sampleCount),
        received: 0,
      };
    }
    else if (data.type === 'batch-chunk') {
      if (!batchUpload || data.jobId !== batchUpload.jobId) return;
      const chunk = new Float32Array(data.samples);
      batchUpload.samples.set(chunk, data.offset);
      batchUpload.received += chunk.length;
    }
    else if (data.type === 'batch-end') {
      if (!batchUpload || data.jobId !== batchUpload.jobId) return;
      const batch = batchUpload;
      batchUpload = null;
      if (batch.received !== batch.samples.length) {
        throw new Error(`Incomplete batch audio: ${batch.received} / ${batch.samples.length}`);
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
    else if (data.type === 'push') {
      if (!receiver) create(data.options);
      receiver.push(new Float32Array(data.samples), data.sampleRate);
    } else if (data.type === 'end') {
      if (!receiver) throw new Error('Decoder worker has no active receiver');
      receiver.end();
    }
  } catch (error) {
    if (data.type?.startsWith('batch-')) {
      self.postMessage({ type: 'batch-error', jobId: data.jobId, message: error.message });
    } else {
      self.postMessage({ type: 'error', message: error.message });
    }
  }
};
