// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright 2000-2013 Makoto Mori, Nobuyuki Oba
// JavaScript adaptation copyright 2026 Awesome SSTV contributors

import { decode } from './decoder.js';
import { demodulate } from './demod.js';
import { getMode } from './modes.js';
import { decodeNarrowFSKHeader, decodeVISHeader } from './vis.js';
import { MMSSTV_SAMPLE_RATE, StreamingResampler } from './mmsstv-dsp.js';
import { detectSyncMode, resolveReceiveMode } from './sync-acquisition.js';

function concatChunks(chunks, length) {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

export class SSTVReceiver {
  constructor(options = {}) {
    this.options = { ...options, dsp: { engine: 'mmsstv', ...(options.dsp || {}) } };
    this.listeners = new Map();
    this.resampler = new StreamingResampler(options.sampleRate || MMSSTV_SAMPLE_RATE);
    this.reset();
  }

  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  emit(type, detail = {}) {
    const event = { type, ...detail };
    for (const listener of this.listeners.get(type) || []) listener(event);
    for (const listener of this.listeners.get('*') || []) listener(event);
  }

  reset() {
    this.resampler.reset();
    this.chunks = [];
    this.length = 0;
    this.mode = null;
    this.header = null;
    this.rows = 0;
    this.lastProbeLength = 0;
    this.lastRenderedRow = 0;
    this.ended = false;
    this.emit('searching', { status: 'searching', sampleRate: this.resampler.outputRate });
  }

  push(samples, sampleRate) {
    if (this.ended) throw new Error('Receiver has ended; call reset() before push()');
    const chunk = this.resampler.process(samples, sampleRate);
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.length += chunk.length;

    let square = 0;
    for (let i = 0; i < chunk.length; i++) square += chunk[i] * chunk[i];
    this.emit('level', { rms: Math.sqrt(square / chunk.length), samples: this.length });

    if (!this.mode && this.length - this.lastProbeLength >= this.resampler.outputRate / 4) {
      this.lastProbeLength = this.length;
      this.probeAcquisition();
    }
    if (this.mode) this.reportRows();
  }

  probeAcquisition() {
    const forcedMode = resolveReceiveMode(this.options.mode);
    if (forcedMode) {
      this.lock(forcedMode, {
        source: 'manual', mode: forcedMode, sampleOffset: Math.max(0, this.options.startSample || 0),
      });
      return;
    }
    const maxProbe = Math.min(this.length, this.resampler.outputRate * 7);
    if (maxProbe < this.resampler.outputRate / 2) return;
    const pcm = concatChunks(this.chunks, this.length).subarray(0, maxProbe);
    const dsp = this.options.dsp || {};
    const freq = demodulate(pcm, this.resampler.outputRate, {
      bpf: dsp.bpf !== false,
      lms: dsp.lms === true,
      lmsOptions: dsp.lmsOptions,
      afc: dsp.afc === true,
      engine: dsp.engine || 'mmsstv',
    });
    let header = decodeVISHeader(freq, this.resampler.outputRate, 0)
      || decodeNarrowFSKHeader(freq, this.resampler.outputRate, 0);
    let mode = header ? getMode(header.visCode7) : null;
    if (mode) {
      header = { ...header, source: header.extended || mode.narrow ? 'fsk' : 'vis', mode };
    } else if (this.options.autoSync !== false) {
      header = detectSyncMode(freq, this.resampler.outputRate, this.options.syncOptions);
      mode = header?.mode;
    }
    if (!mode) return;
    this.lock(mode, header);
  }

  lock(mode, header) {
    this.header = header;
    this.mode = mode;
    this.emit('locked', {
      status: 'locked', mode, header, source: header.source,
      confidence: header.confidence ?? 1, rows: 0,
    });
  }

  reportRows() {
    const lineCount = this.mode.dataLines || this.mode.height;
    const elapsed = Math.max(0, this.length - this.header.sampleOffset);
    const dataRows = Math.min(lineCount, Math.floor(elapsed / (this.mode.lineDurationMs * this.resampler.outputRate / 1000)));
    const displayRows = this.mode.pairedLines ? Math.min(this.mode.height, dataRows * 2) : Math.min(this.mode.height, dataRows);
    if (displayRows <= this.rows) return;
    const previous = this.rows;
    this.rows = displayRows;
    for (let row = previous; row < displayRows; row++) {
      this.emit('row', { row, rows: displayRows, totalRows: this.mode.height, mode: this.mode });
    }
    const cadence = this.options.renderEveryRows || 16;
    if (this.options.emitFrames !== false && this.rows - this.lastRenderedRow >= cadence) {
      this.lastRenderedRow = this.rows;
      this.renderPartial();
    }
  }

  renderPartial() {
    try {
      const result = decode(concatChunks(this.chunks, this.length), this.resampler.outputRate, {
        ...this.options,
        dsp: this.options.dsp,
      });
      this.emit('frame', { result, partial: this.rows < this.mode.height, rows: this.rows });
    } catch (_) {
      // A line-sync pulse may not be complete yet. The next cadence retries.
    }
  }

  end() {
    if (this.ended) return null;
    this.ended = true;
    try {
      const result = decode(concatChunks(this.chunks, this.length), this.resampler.outputRate, {
        ...this.options,
        dsp: this.options.dsp,
        onProgress: this.options.onProgress,
      });
      this.mode = result.mode;
      this.rows = result.height;
      this.emit('frame', { result, partial: false, rows: result.height });
      return result;
    } catch (error) {
      this.emit('error', { error, message: error.message });
      throw error;
    }
  }
}

export function decodeStream(chunks, sampleRate, options = {}) {
  const receiver = new SSTVReceiver({ ...options, emitFrames: false });
  for (const chunk of chunks) receiver.push(chunk, sampleRate);
  return receiver.end();
}
