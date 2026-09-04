// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright 2000-2013 Makoto Mori, Nobuyuki Oba
// JavaScript adaptation copyright 2026 Awesome SSTV contributors

import { decode } from './decoder.js';
import { demodulate } from './demod.js';
import { getMode } from './modes.js';
import { ProgressiveFrameDecoder } from './progressive-decoder.js';
import { decodeNarrowFSKHeader, decodeVISHeader } from './vis.js';
import { MMSSTV_SAMPLE_RATE, StreamingResampler } from './mmsstv-dsp.js';
import { detectSyncMode, resolveReceiveMode } from './sync-acquisition.js';

const ACQUISITION_WINDOW_SECONDS = 7;
const ACQUISITION_PROBE_SECONDS = 1;
// Keep enough audio before a rolling-window lock for VIS/FSK pre-roll, and
// enough after a completed frame to carry a following header across chunks.
const FRAME_PREROLL_SECONDS = 1;
const FRAME_TAIL_SECONDS = 0.1;
const FRAME_PCM_PAGE_SECONDS = 0.5;
const MAX_PARTIAL_PREVIEWS = 4;

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
    this.resampler = new StreamingResampler(MMSSTV_SAMPLE_RATE);
    this.frameSequence = 0;
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
    this.totalNativeSamples = 0;
    this.nativeSampleRate = 0;
    this.searchNativeChunks = [];
    this.searchNativeLength = 0;
    this.searchNativeStart = 0;
    this.acquisitionChunks = [];
    this.acquisitionLength = 0;
    this.acquisitionStart = 0;
    this.mode = null;
    this.header = null;
    this.clearFrameNativeBuffer();
    this.frameAcquisitionStart = 0;
    this.frameTargetAcquisitionEnd = 0;
    this.nextFrameAcquisitionFloor = 0;
    this.lastCompletedResult = null;
    this.activeFrameId = null;
    this.progressiveDecoder = null;
    this.progressiveFrameId = null;
    this.rows = 0;
    this.previewEveryRows = 0;
    this.nextPreviewRow = 0;
    this.lastProbeTotal = 0;
    this.ended = false;
    this.emit('searching', { status: 'searching', sampleRate: this.resampler.outputRate });
  }

  rearm() {
    if (this.ended) throw new Error('Receiver has ended; call reset() before rearming');
    if (this.mode) return false;
    this.nextFrameAcquisitionFloor = 0;
    this.lastProbeTotal = this.acquisitionStart + this.acquisitionLength;
    this.emit('searching', { status: 'searching', sampleRate: this.resampler.outputRate, rearmed: true });
    return true;
  }

  push(samples, sampleRate) {
    if (this.ended) throw new Error('Receiver has ended; call reset() before push()');
    if (!(samples instanceof Float32Array)) samples = Float32Array.from(samples || []);
    if (!samples.length) return;
    if (!this.nativeSampleRate) this.nativeSampleRate = sampleRate;
    if (this.nativeSampleRate !== sampleRate) {
      throw new Error(`Sample rate changed during receive: ${this.nativeSampleRate} -> ${sampleRate}`);
    }
    const nativeChunk = samples.slice();
    const nativeChunkStart = this.totalNativeSamples;
    this.totalNativeSamples += nativeChunk.length;
    this.appendNativeSearchChunk(nativeChunk, nativeChunkStart);

    const chunk = this.resampler.process(samples, sampleRate);
    if (chunk.length) this.appendAcquisitionChunk(chunk);

    let square = 0;
    for (let i = 0; i < nativeChunk.length; i++) square += nativeChunk[i] * nativeChunk[i];
    this.emit('level', { rms: Math.sqrt(square / nativeChunk.length), samples: this.totalNativeSamples });

    if (!this.mode && this.acquisitionStart + this.acquisitionLength - this.lastProbeTotal >=
        this.resampler.outputRate * ACQUISITION_PROBE_SECONDS) {
      this.lastProbeTotal = this.acquisitionStart + this.acquisitionLength;
      this.probeAcquisition();
    }
    if (this.mode) {
      const addition = this.appendLockedChunk(nativeChunk, nativeChunkStart);
      if (addition) this.decodeProgressiveChunk(addition.samples, addition.start);
      this.reportRows();
      this.finishReadyFrames();
    }
  }

  appendNativeSearchChunk(chunk, start) {
    if (!this.searchNativeChunks.length) this.searchNativeStart = start;
    this.searchNativeChunks.push(chunk);
    this.searchNativeLength += chunk.length;
    const maximum = Math.ceil((ACQUISITION_WINDOW_SECONDS + FRAME_PREROLL_SECONDS) * this.nativeSampleRate);
    while (this.searchNativeChunks.length > 1 &&
           this.searchNativeLength - this.searchNativeChunks[0].length >= maximum) {
      const removed = this.searchNativeChunks.shift();
      this.searchNativeLength -= removed.length;
      this.searchNativeStart += removed.length;
    }
  }

  appendAcquisitionChunk(chunk) {
    this.acquisitionChunks.push(chunk);
    this.acquisitionLength += chunk.length;
    const maximum = Math.ceil(ACQUISITION_WINDOW_SECONDS * this.resampler.outputRate);
    while (this.acquisitionChunks.length > 1 &&
           this.acquisitionLength - this.acquisitionChunks[0].length >= maximum) {
      const removed = this.acquisitionChunks.shift();
      this.acquisitionLength -= removed.length;
      this.acquisitionStart += removed.length;
    }
  }

  clearFrameNativeBuffer(start = 0) {
    this.frameNativePages = [];
    this.frameNativePage = null;
    this.frameNativePageLength = 0;
    this.frameNativeLength = 0;
    this.frameNativeStart = start;
  }

  appendFrameNativeSamples(samples, start) {
    if (!samples.length) return;
    const expectedStart = this.frameNativeStart + this.frameNativeLength;
    if (start !== expectedStart) {
      throw new Error(`Non-contiguous receiver frame PCM: ${expectedStart} -> ${start}`);
    }
    const pageSize = Math.max(1, Math.ceil(this.nativeSampleRate * FRAME_PCM_PAGE_SECONDS));
    let sourceOffset = 0;
    while (sourceOffset < samples.length) {
      if (!this.frameNativePage) {
        this.frameNativePage = new Float32Array(pageSize);
        this.frameNativePageLength = 0;
      }
      const count = Math.min(
        samples.length - sourceOffset,
        pageSize - this.frameNativePageLength
      );
      this.frameNativePage.set(
        samples.subarray(sourceOffset, sourceOffset + count),
        this.frameNativePageLength
      );
      this.frameNativePageLength += count;
      this.frameNativeLength += count;
      sourceOffset += count;
      if (this.frameNativePageLength === pageSize) {
        this.frameNativePages.push(this.frameNativePage);
        this.frameNativePage = null;
        this.frameNativePageLength = 0;
      }
    }
  }

  forEachFrameNativeSegment(listener) {
    let start = this.frameNativeStart;
    for (const page of this.frameNativePages) {
      listener(page, start);
      start += page.length;
    }
    if (this.frameNativePageLength) {
      const tail = this.frameNativePage.subarray(0, this.frameNativePageLength);
      listener(tail, start);
    }
  }

  copyFrameNativePcm() {
    const pcm = new Float32Array(this.frameNativeLength);
    let offset = 0;
    this.forEachFrameNativeSegment(segment => {
      pcm.set(segment, offset);
      offset += segment.length;
    });
    return pcm;
  }

  appendLockedChunk(chunk, chunkStart) {
    const capturedEnd = this.frameNativeStart + this.frameNativeLength;
    const chunkEnd = chunkStart + chunk.length;
    if (chunkEnd <= capturedEnd) return null;
    const relativeStart = Math.max(0, capturedEnd - chunkStart);
    const addition = relativeStart ? chunk.subarray(relativeStart) : chunk;
    const additionStart = chunkStart + relativeStart;
    this.appendFrameNativeSamples(addition, additionStart);
    return { samples: addition, start: additionStart };
  }

  probeAcquisition() {
    const forcedMode = resolveReceiveMode(this.options.mode);
    if (forcedMode) {
      const inputOffset = Math.max(0, this.options.startSample || 0);
      // Manual acquisition has no header evidence for a following frame.
      // After one natural completion, remain in searching until the caller
      // explicitly resets/re-arms the receiver; otherwise ambient microphone
      // audio would be treated as a new image every second and suppress the
      // operator's completion choice.
      if (this.nextFrameAcquisitionFloor > 0) return;
      const initialOffset = Math.round(inputOffset * this.resampler.outputRate / this.nativeSampleRate);
      const sampleOffset = Math.max(this.acquisitionStart, initialOffset);
      this.lock(forcedMode, {
        source: 'manual', mode: forcedMode,
        sampleOffset,
      });
      return;
    }
    if (this.acquisitionLength < this.resampler.outputRate / 2) return;
    const pcm = concatChunks(this.acquisitionChunks, this.acquisitionLength);
    const dsp = this.options.dsp || {};
    const freq = demodulate(pcm, this.resampler.outputRate, {
      bpf: dsp.bpf === true,
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
    const absoluteHeaderStart = Number.isFinite(header.headerStartSample)
      ? header.headerStartSample + this.acquisitionStart
      : header.sampleOffset + this.acquisitionStart;
    if (absoluteHeaderStart + this.resampler.outputRate * FRAME_TAIL_SECONDS <
        this.nextFrameAcquisitionFloor) return;
    this.lock(mode, {
      ...header,
      sampleOffset: header.sampleOffset + this.acquisitionStart,
      headerStartSample: Number.isFinite(header.headerStartSample)
        ? header.headerStartSample + this.acquisitionStart
        : header.headerStartSample,
      pulses: header.pulses?.map(pulse => pulse + this.acquisitionStart),
    });
  }

  lock(mode, header) {
    this.header = header;
    this.mode = mode;
    this.activeFrameId = ++this.frameSequence;
    this.rows = 0;
    const requestedPreviewRows = Math.max(1, Number(this.options.renderEveryRows) || 16);
    this.previewEveryRows = Math.max(
      requestedPreviewRows,
      Math.ceil(mode.height / (MAX_PARTIAL_PREVIEWS + 1))
    );
    this.nextPreviewRow = this.previewEveryRows;
    this.prepareFrameBuffer();
    const lineCount = mode.dataLines || mode.height;
    const rowPeriodMs = mode.syncPeriodMs || mode.lineDurationMs;
    const tail = FRAME_TAIL_SECONDS * this.resampler.outputRate;
    this.frameTargetAcquisitionEnd = header.sampleOffset +
      ((mode.needsInitialSync ? 10.5 : 0) + lineCount * rowPeriodMs) *
        this.resampler.outputRate / 1000 + tail;
    this.emit('locked', {
      status: 'locked', mode, header, source: header.source,
      confidence: header.confidence ?? 1, rows: 0,
    });
    this.prepareProgressiveDecoder();
  }

  prepareFrameBuffer() {
    const headerStart = Number.isFinite(this.header.headerStartSample)
      ? this.header.headerStartSample
      : this.header.sampleOffset - FRAME_PREROLL_SECONDS * this.resampler.outputRate;
    const wantedStart = Math.max(
      this.searchNativeStart,
      Math.floor((headerStart - FRAME_PREROLL_SECONDS * this.resampler.outputRate) *
        this.nativeSampleRate / this.resampler.outputRate)
    );
    const buffered = concatChunks(this.searchNativeChunks, this.searchNativeLength);
    const relative = Math.max(0, wantedStart - this.searchNativeStart);
    const prefix = buffered.subarray(relative);
    this.clearFrameNativeBuffer(wantedStart);
    this.appendFrameNativeSamples(prefix, wantedStart);
    this.frameAcquisitionStart = Math.round(wantedStart * this.resampler.outputRate / this.nativeSampleRate);
  }

  prepareProgressiveDecoder() {
    this.progressiveDecoder = null;
    this.progressiveFrameId = null;
    if (this.options.emitFrames === false) return;
    try {
      const decoder = new ProgressiveFrameDecoder({
        mode: this.mode,
        sampleRate: this.nativeSampleRate,
        imageStartSample: Math.round(
          this.header.sampleOffset * this.nativeSampleRate / this.resampler.outputRate
        ),
        source: this.header.source,
        dsp: this.options.dsp,
      });
      // Sync-only/manual acquisition cannot establish an immutable row-zero
      // phase for every family. Keep the existing bounded full-prefix preview
      // for those paths instead of opening a blank progressive frame.
      if (!decoder.supportedSource) return;
      const replayedPatches = [];
      this.forEachFrameNativeSegment((segment, start) => {
        replayedPatches.push(...decoder.decodeAvailable(
          segment,
          start,
          this.currentDataLines()
        ));
      });
      const frameId = this.activeFrameId;
      this.progressiveDecoder = decoder;
      this.progressiveFrameId = frameId;
      this.emit('frame-start', {
        frameId,
        width: this.mode.width,
        height: this.mode.height,
        mode: this.mode,
        dsp: {
          ...(this.options.dsp || {}),
          afcLocked: false,
          afcOffsetHz: 0,
        },
      });
      for (const patch of replayedPatches) {
        this.emit('frame-patch', { frameId, ...patch });
      }
    } catch (error) {
      // The final full-frame decoder remains authoritative. If a provisional
      // decoder cannot initialize, retain the bounded legacy preview path.
      this.progressiveDecoder = null;
      this.emit('preview-error', { message: error.message, error });
    }
  }

  currentDataLines() {
    if (!this.mode || !this.header) return 0;
    const lineCount = this.mode.dataLines || this.mode.height;
    const acquisitionEnd = this.acquisitionStart + this.acquisitionLength;
    const elapsed = Math.max(0, acquisitionEnd - this.header.sampleOffset);
    const rowPeriodMs = this.mode.syncPeriodMs || this.mode.lineDurationMs;
    return Math.min(
      lineCount,
      Math.floor(elapsed / (rowPeriodMs * this.resampler.outputRate / 1000))
    );
  }

  decodeProgressiveChunk(samples, absoluteStart) {
    if (!this.progressiveDecoder || this.options.emitFrames === false) return;
    try {
      const patches = this.progressiveDecoder.decodeAvailable(
        samples,
        absoluteStart,
        this.currentDataLines()
      );
      for (const patch of patches) {
        this.emit('frame-patch', { frameId: this.progressiveFrameId, ...patch });
      }
    } catch (error) {
      this.progressiveDecoder = null;
      this.emit('preview-error', { message: error.message, error });
    }
  }

  flushProgressiveDecoder() {
    if (!this.progressiveDecoder || this.options.emitFrames === false) return;
    try {
      const patches = this.progressiveDecoder.flush(this.mode.dataLines || this.mode.height);
      for (const patch of patches) {
        this.emit('frame-patch', { frameId: this.progressiveFrameId, ...patch });
      }
    } catch (error) {
      this.progressiveDecoder = null;
      this.emit('preview-error', { message: error.message, error });
    }
  }

  reportRows() {
    const lineCount = this.mode.dataLines || this.mode.height;
    // Robot 36's retained legacy scan layout totals 148.5 ms, while real sync
    // pulses and frame progress use the standard 150-ms cadence. Reporting on
    // the shorter scan layout marks the frame complete about 360 ms too early
    // and suppresses its final partial updates.
    const dataRows = this.currentDataLines();
    const displayRows = this.mode.pairedLines ? Math.min(this.mode.height, dataRows * 2) : Math.min(this.mode.height, dataRows);
    if (displayRows <= this.rows) return;
    const previous = this.rows;
    this.rows = displayRows;
    for (let row = previous; row < displayRows; row++) {
      this.emit('row', { row, rows: displayRows, totalRows: this.mode.height, mode: this.mode });
    }
    if (!this.progressiveDecoder && this.options.emitFrames !== false && displayRows < this.mode.height &&
        displayRows >= this.nextPreviewRow) {
      while (this.nextPreviewRow <= displayRows) this.nextPreviewRow += this.previewEveryRows;
      try {
        this.decodeCurrentFrame(true);
      } catch (_) {
        // A short prefix may not yet contain enough samples for a useful
        // decode. Row reporting must continue and the final decode will retry.
      }
    }
  }

  decodeCurrentFrame(partial = false) {
    const pcm = this.copyFrameNativePcm();
    if (!pcm.length) throw new Error('Receiver frame buffer is empty');
    const knownHeader = this.header.source === 'vis' || this.header.source === 'fsk'
      ? {
          ...this.header,
          sampleOffset: Math.round((this.header.sampleOffset - this.frameAcquisitionStart) *
            this.nativeSampleRate / this.resampler.outputRate),
          headerStartSample: Number.isFinite(this.header.headerStartSample)
            ? Math.round((this.header.headerStartSample - this.frameAcquisitionStart) *
              this.nativeSampleRate / this.resampler.outputRate)
            : this.header.headerStartSample,
        }
      : null;
    const knownAcquisition = knownHeader ? null : {
      ...this.header,
      mode: this.mode,
      sampleOffset: Math.round((this.header.sampleOffset - this.frameAcquisitionStart) *
        this.nativeSampleRate / this.resampler.outputRate),
    };
    const result = decode(pcm, this.nativeSampleRate, {
      ...this.options,
      mode: knownHeader || knownAcquisition ? 'auto' : this.options.mode,
      knownHeader,
      knownAcquisition,
      dsp: this.options.dsp,
      onProgress: partial ? undefined : this.options.onProgress,
    });
    const reconstructedRows = Number.isFinite(result.reconstruction?.completedRows)
      ? Math.max(0, Math.min(result.height, result.reconstruction.completedRows))
      : this.rows;
    const rows = partial
      ? Math.max(0, Math.min(this.rows, reconstructedRows))
      : reconstructedRows;
    const complete = (rows >= result.height || (!partial && this.rows >= result.height)) &&
      result.reconstruction?.complete !== false;
    this.emit('frame', {
      frameId: this.activeFrameId,
      result,
      partial,
      rows,
      complete,
      completionRatio: rows / Math.max(1, result.height),
    });
    return result;
  }

  finishReadyFrames() {
    const acquisitionEnd = this.acquisitionStart + this.acquisitionLength;
    if (!this.mode || acquisitionEnd < this.frameTargetAcquisitionEnd) return;
    const frameId = this.activeFrameId;
    const mode = this.mode;
    let completedTransmission = null;
    this.flushProgressiveDecoder();
    try {
      this.lastCompletedResult = this.decodeCurrentFrame(false);
      const rows = Number.isFinite(this.lastCompletedResult.reconstruction?.completedRows)
        ? Math.max(0, Math.min(this.lastCompletedResult.height,
          this.lastCompletedResult.reconstruction.completedRows))
        : this.rows;
      const complete = (rows >= this.lastCompletedResult.height ||
          this.rows >= this.lastCompletedResult.height) &&
        this.lastCompletedResult.reconstruction?.complete !== false;
      if (complete) {
        completedTransmission = {
          frameId,
          mode,
          rows: this.lastCompletedResult.height,
          complete: true,
          completionRatio: 1,
          reason: 'nominal-tail',
        };
      }
    } catch (error) {
      this.emit('frame-error', {
        frameId: this.progressiveFrameId,
        error,
        message: error.message,
      });
      this.emit('error', { error, message: error.message });
    }
    this.beginNextFrameSearch();
    // This event describes a protocol-level natural finish: the complete
    // image and its nominal post-frame tail have both arrived. Explicit end()
    // never emits it, so UI callers can distinguish a transmitter finishing
    // from the operator stopping reception. Keep it after `searching` so the
    // event sequence is deterministic for consumers.
    // The retained tail can already contain a following header; probe
    // immediately rather than waiting for the next periodic acquisition tick.
    this.probeAcquisition();
    if (completedTransmission && !this.mode) this.emit('transmission-ended', completedTransmission);
  }

  beginNextFrameSearch() {
    this.nextFrameAcquisitionFloor = Math.max(
      this.nextFrameAcquisitionFloor,
      this.frameTargetAcquisitionEnd - FRAME_TAIL_SECONDS * this.resampler.outputRate
    );
    this.mode = null;
    this.header = null;
    this.activeFrameId = null;
    this.progressiveDecoder = null;
    this.progressiveFrameId = null;
    this.rows = 0;
    this.previewEveryRows = 0;
    this.nextPreviewRow = 0;
    this.clearFrameNativeBuffer();
    this.frameTargetAcquisitionEnd = 0;
    this.lastProbeTotal = 0;
    this.emit('searching', { status: 'searching', sampleRate: this.resampler.outputRate });
  }

  end() {
    if (this.ended) return null;
    this.ended = true;
    if (this.mode) {
      try {
        // end() is the caller's explicit finalization boundary. Even when row
        // telemetry has not reached the nominal height (short/truncated tail,
        // scheduler cadence, or conservative frame timing), a successful
        // decode must be emitted as final so one-shot Worker promises settle.
        this.flushProgressiveDecoder();
        const result = this.decodeCurrentFrame(false);
        this.lastCompletedResult = result;
        return result;
      } catch (error) {
        if (this.lastCompletedResult) return this.lastCompletedResult;
        this.emit('frame-error', {
          frameId: this.progressiveFrameId,
          error,
          message: error.message,
        });
        this.emit('error', { error, message: error.message });
        throw error;
      }
    }
    if (this.lastCompletedResult) return this.lastCompletedResult;
    try {
      const buffered = concatChunks(this.searchNativeChunks, this.searchNativeLength);
      const wantedStart = Math.max(
        this.searchNativeStart,
        Math.floor((this.nextFrameAcquisitionFloor - FRAME_PREROLL_SECONDS * this.resampler.outputRate) *
          this.nativeSampleRate / this.resampler.outputRate)
      );
      const pcm = buffered.subarray(Math.max(0, wantedStart - this.searchNativeStart));
      const result = decode(pcm, this.nativeSampleRate, {
        ...this.options,
        dsp: this.options.dsp,
        onProgress: this.options.onProgress,
      });
      this.mode = result.mode;
      const rows = Number.isFinite(result.reconstruction?.completedRows)
        ? Math.max(0, Math.min(result.height, result.reconstruction.completedRows))
        : result.height;
      this.rows = rows;
      this.emit('frame', {
        frameId: this.activeFrameId ?? ++this.frameSequence,
        result,
        partial: false,
        rows,
        complete: rows >= result.height && result.reconstruction?.complete !== false,
        completionRatio: rows / Math.max(1, result.height),
      });
      return result;
    } catch (error) {
      if (this.lastCompletedResult) return this.lastCompletedResult;
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
