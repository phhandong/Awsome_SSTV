import { recordToSatrec, validateObserver, lookAt, predictPasses } from './orbit-core.js';
let sat, observer, generation;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'configure') {
      generation = data.generation;
      sat = null; observer = null;
      sat = recordToSatrec(data.record);
      observer = validateObserver(data.observer);
    }
    if (data.generation !== generation || !sat || !observer) return;
    if (data.type === 'configure' || data.type === 'tick') {
      self.postMessage({ type: 'position', generation, position: lookAt(sat, observer, data.time) });
    }
    if (data.type === 'configure' || data.type === 'predict') {
      self.postMessage({ type: 'passes', generation, prediction: predictPasses(sat, observer, data.time) });
    }
  } catch (error) {
    self.postMessage({ type: 'error', generation: data.generation, message: error.message });
  }
};
