// AudioWorklet is intentionally limited to PCM capture. DSP runs in decoder-worker.js.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (let channel = 0; channel < channels.length; channel++) {
      const input = channels[channel];
      for (let i = 0; i < mono.length; i++) mono[i] += input[i] / channels.length;
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
