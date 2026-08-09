// SPDX-License-Identifier: LGPL-3.0-or-later
import { SSTVReceiver } from './receiver.js';

let receiver = null;

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
    else if (data.type === 'push') {
      if (!receiver) create(data.options);
      receiver.push(new Float32Array(data.samples), data.sampleRate);
    } else if (data.type === 'end') {
      if (!receiver) throw new Error('Decoder worker has no active receiver');
      receiver.end();
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
