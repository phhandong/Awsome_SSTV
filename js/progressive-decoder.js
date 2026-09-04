// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright 2026 Awesome SSTV contributors

import { ColorSpace, FREQ, SegType, freqToPixel } from './modes.js';
import { demodulate, demodulatePhase } from './demod.js';

const DEFAULT_WINDOW_PADDING_MS = 8;
const DEFAULT_SYNC_SEARCH_MS = 5;
const SYNC_TOLERANCE_HZ = 80;
const ROBOT36_VIS_EDGE_ADVANCE_MS = 1.15;

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0;
}

function assertMode(mode) {
  if (!mode || !Number.isSafeInteger(mode.width) || mode.width < 1 ||
      !Number.isSafeInteger(mode.height) || mode.height < 1 ||
      !Array.isArray(mode.lineSegments) || !mode.lineSegments.length) {
    throw new Error('Invalid progressive SSTV mode');
  }
}

function lineLayout(mode, sampleRate) {
  let samples = 0;
  let elapsedMs = 0;
  return mode.lineSegments.map(segment => {
    const startSamples = samples;
    if (mode.robot36Legacy) {
      samples += Math.floor(segment.durationMs * sampleRate / 1000);
    } else {
      elapsedMs += segment.durationMs;
      samples = Math.round(elapsedMs * sampleRate / 1000);
    }
    return { segment, startSamples, endSamples: samples };
  });
}

function initialDataOffset(mode, sampleRate) {
  if (!mode.needsInitialSync) return 0;
  // Scottie's initial 9-ms sync and 1.5-ms porch are outside lineSegments.
  return Math.floor(9 * sampleRate / 1000) + Math.floor(1.5 * sampleRate / 1000);
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length & 1
    ? values[middle]
    : (values[middle - 1] + values[middle]) * 0.5;
}

function averageFrequency(freq, start, end) {
  const first = Math.max(0, Math.floor(start));
  const last = Math.min(freq.length, Math.ceil(end));
  if (last <= first) return FREQ.BLACK;
  let sum = 0;
  for (let index = first; index < last; index++) sum += freq[index];
  return sum / (last - first);
}

function findLocalSync(freq, expectedStart, durationSamples, searchSamples, targetHz) {
  const first = Math.max(0, Math.floor(expectedStart - searchSamples));
  const last = Math.min(
    freq.length - durationSamples,
    Math.ceil(expectedStart + searchSamples)
  );
  if (last < first || durationSamples < 1) return null;

  const lowHz = targetHz - SYNC_TOLERANCE_HZ;
  const highHz = targetHz + SYNC_TOLERANCE_HZ;
  const inBand = index => index >= 0 && index < freq.length &&
    freq[index] >= lowHz && freq[index] <= highHz;
  let count = 0;
  for (let index = first; index < first + durationSamples; index++) {
    if (inBand(index)) count++;
  }
  let bestStart = first;
  let bestCount = count;
  for (let start = first + 1; start <= last; start++) {
    if (inBand(start - 1)) count--;
    if (inBand(start + durationSamples - 1)) count++;
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }
  if (bestCount < durationSamples * 0.2) return null;

  const innerStart = Math.max(0, bestStart + Math.floor(durationSamples * 0.2));
  const innerEnd = Math.min(freq.length, bestStart + Math.ceil(durationSamples * 0.8));
  const values = [];
  for (let index = innerStart; index < innerEnd; index++) values.push(freq[index]);
  return {
    start: bestStart,
    frequencyOffset: values.length ? median(values) - targetHz : 0,
  };
}

function rgbaFromRgb(channels, width) {
  const pixels = new Uint8ClampedArray(width * 4);
  const red = channels.R;
  const green = channels.G;
  const blue = channels.B;
  for (let x = 0; x < width; x++) {
    const offset = x * 4;
    pixels[offset] = red?.[x] ?? 0;
    pixels[offset + 1] = green?.[x] ?? 0;
    pixels[offset + 2] = blue?.[x] ?? 0;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function rgbaFromGray(values, width) {
  const pixels = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) {
    const value = values?.[x] ?? 0;
    const offset = x * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function writeYuvRow(target, targetOffset, yValues, crValues, cbValues, width) {
  for (let x = 0; x < width; x++) {
    const y = yValues?.[x] ?? 0;
    const cr = (crValues?.[x] ?? 128) - 128;
    const cb = (cbValues?.[x] ?? 128) - 128;
    const offset = targetOffset + x * 4;
    target[offset] = clampByte(y + 1.402 * cr);
    target[offset + 1] = clampByte(y - 0.344 * cb - 0.714 * cr);
    target[offset + 2] = clampByte(y + 1.772 * cb);
    target[offset + 3] = 255;
  }
}

/**
 * Low-latency preview decoder for an already acquired SSTV frame.
 *
 * Audio passed to push() is an immutable, contiguous stream chunk. All sample
 * coordinates, including imageStartSample and absoluteStart, share the input
 * PCM sample-rate coordinate space. imageStartSample is the first sample after
 * the VIS/FSK header; Scottie's extra initial sync is applied internally.
 *
 * This class intentionally does not replace decoder.decode(). Each transmitted
 * line is demodulated once from a small padded window and emitted as an RGBA
 * patch. The normal full-frame decoder should still produce the final image.
 */
export class ProgressiveFrameDecoder {
  constructor(modeOrOptions, options = {}) {
    let mode = modeOrOptions;
    if (modeOrOptions?.mode) {
      const { mode: configuredMode, ...configuredOptions } = modeOrOptions;
      mode = configuredMode;
      options = configuredOptions;
    }
    const {
    sampleRate,
    imageStartSample,
    dsp = {},
    source = 'vis',
    windowPaddingMs = DEFAULT_WINDOW_PADDING_MS,
    syncSearchMs = DEFAULT_SYNC_SEARCH_MS,
    } = options;
    assertMode(mode);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('Invalid progressive decoder sample rate');
    }
    if (!Number.isFinite(imageStartSample) || imageStartSample < 0) {
      throw new Error('Invalid progressive frame start');
    }

    this.mode = mode;
    this.sampleRate = sampleRate;
    this.imageStartSample = imageStartSample;
    this.dsp = { ...dsp };
    this.source = source;
    this.supportedSource = source === 'vis' || source === 'fsk';
    this.width = mode.width;
    this.height = mode.height;
    this.dataLineCount = mode.dataLines || mode.height;
    this.layout = lineLayout(mode, sampleRate);
    this.layoutSamples = this.layout[this.layout.length - 1].endSamples;
    this.nominalLineSamples = Number.isFinite(mode.syncPeriodMs)
      ? mode.syncPeriodMs * sampleRate / 1000
      : mode.lineDurationMs * sampleRate / 1000;
    this.currentLineSamples = this.nominalLineSamples;
    // Match decoder.decode(): the centered VIS smoother observes the leader
    // edge about 1.15 ms early. Native phase modes re-anchor naturally, while
    // the retained Robot 36 legacy clock needs the explicit correction.
    const legacyVisCorrection = mode.robot36Legacy &&
      (source === 'vis' || source === 'fsk')
      ? ROBOT36_VIS_EDGE_ADVANCE_MS * sampleRate / 1000
      : 0;
    this.nextLineStart = imageStartSample - legacyVisCorrection +
      initialDataOffset(mode, sampleRate);
    this.paddingSamples = Math.max(1, Math.ceil(
      Math.max(2, Number(windowPaddingMs) || DEFAULT_WINDOW_PADDING_MS) * sampleRate / 1000
    ));
    this.syncSearchSamples = Math.max(1, Math.ceil(
      Math.max(1, Number(syncSearchMs) || DEFAULT_SYNC_SEARCH_MS) * sampleRate / 1000
    ));
    this.syncLayout = mode.noSync
      ? null
      : this.layout.find(item => item.segment.type === SegType.SYNC) || null;
    this.nextDataLine = 0;
    this.committedRows = 0;
    this.lastSyncSample = null;
    this.pendingAlternate = null;
    this.chunks = [];
    this.inputEnd = null;
  }

  /**
   * Append a new stream chunk and return zero or more immutable dirty strips.
   * A patch is { y, rowCount, pixels, rows, totalRows, dataLine }.
   * availableDataLines is an optional exclusive high-water mark supplied by
   * receiver timing; byte availability is always checked independently.
   */
  push(samples, absoluteStart, availableDataLines = this.dataLineCount) {
    if (!(samples instanceof Float32Array)) {
      throw new Error('Progressive decoder requires Float32Array audio');
    }
    if (!Number.isSafeInteger(absoluteStart) || absoluteStart < 0) {
      throw new Error('Invalid progressive audio offset');
    }
    if (!Number.isFinite(availableDataLines)) {
      throw new Error('Invalid progressive line high-water mark');
    }
    // A sync/manual acquisition does not establish an unambiguous row-zero
    // phase for every family. The existing bounded full-prefix preview remains
    // the safe fallback for those receiver paths.
    if (!this.supportedSource) return [];
    this.appendChunk(samples, absoluteStart);

    const patches = [];
    const lineLimit = Math.max(
      0,
      Math.min(this.dataLineCount, Math.floor(availableDataLines))
    );
    while (this.nextDataLine < lineLimit && this.canDecodeNextLine()) {
      const patch = this.decodeNextLine();
      if (patch) patches.push(patch);
      this.pruneChunks();
    }
    return patches;
  }

  decodeAvailable(samples, absoluteStart, availableDataLines = this.dataLineCount) {
    return this.push(samples, absoluteStart, availableDataLines);
  }

  /**
   * Decode every complete transmitted line already present in the buffered
   * PCM. Unlike push(), finalization may omit the normal post-line padding:
   * that padding only warms the independent preview demodulator and is not
   * part of the SSTV line itself.
   */
  flush(availableDataLines = this.dataLineCount) {
    if (!Number.isFinite(availableDataLines)) {
      throw new Error('Invalid progressive line high-water mark');
    }
    if (!this.supportedSource || this.inputEnd == null) return [];
    const patches = [];
    const lineLimit = Math.max(
      0,
      Math.min(this.dataLineCount, Math.floor(availableDataLines))
    );
    while (this.nextDataLine < lineLimit && this.canDecodeNextLine(false)) {
      const patch = this.decodeNextLine(false);
      if (patch) patches.push(patch);
      this.pruneChunks();
    }
    return patches;
  }

  appendChunk(samples, absoluteStart) {
    if (!samples.length) return;
    let start = absoluteStart;
    let data = samples;
    if (this.inputEnd == null) {
      this.inputEnd = start;
    } else if (start > this.inputEnd) {
      throw new Error(`Gap in progressive audio stream: ${this.inputEnd} -> ${start}`);
    } else if (start < this.inputEnd) {
      const overlap = this.inputEnd - start;
      if (overlap >= data.length) return;
      data = data.subarray(overlap);
      start = this.inputEnd;
    }
    this.chunks.push({ start, end: start + data.length, data });
    this.inputEnd = start + data.length;
  }

  canDecodeNextLine(requirePostPadding = true) {
    if (this.inputEnd == null || !this.chunks.length) return false;
    const firstNeeded = Math.floor(this.nextLineStart - this.paddingSamples);
    const lastNeeded = Math.ceil(
      this.nextLineStart + this.layoutSamples +
        (requirePostPadding ? this.paddingSamples : 0)
    );
    // Missing pre-roll at the beginning is allowed. The local demodulator has
    // a causal warm-up and the first fixed/sync porch supplies useful guard.
    const finalRoundingTolerance = requirePostPadding ? 0 : 1;
    return this.chunks[0].start <= Math.max(firstNeeded, this.nextLineStart) &&
      this.inputEnd + finalRoundingTolerance >= lastNeeded;
  }

  extractWindow(start, end) {
    const first = Math.max(this.chunks[0].start, Math.floor(start));
    const last = Math.min(this.inputEnd, Math.ceil(end));
    if (last <= first) return null;
    const output = new Float32Array(last - first);
    let copied = 0;
    for (const chunk of this.chunks) {
      if (chunk.end <= first) continue;
      if (chunk.start >= last) break;
      const from = Math.max(first, chunk.start);
      const to = Math.min(last, chunk.end);
      output.set(
        chunk.data.subarray(from - chunk.start, to - chunk.start),
        from - first
      );
      copied += to - from;
    }
    if (copied !== output.length) throw new Error('Incomplete progressive audio window');
    return { samples: output, absoluteStart: first };
  }

  demodulateWindow(samples) {
    if (this.mode.robot36Legacy || this.dsp.demodulator === 'legacy') {
      return {
        freq: demodulate(samples, this.sampleRate, {
          ...this.dsp,
          engine: 'legacy',
          // Resetting an adaptive filter per line creates visible boundaries.
          // The final decoder still applies the requested full-frame LMS pass.
          lms: false,
          afc: false,
        }),
        groupDelaySamples: 0,
      };
    }
    const phase = demodulatePhase(samples, this.sampleRate, {
      baseband: this.dsp.baseband,
      filterDurationMs: this.dsp.filterDurationMs,
      kaiserBeta: this.dsp.kaiserBeta,
    });
    return { freq: phase.freq, groupDelaySamples: phase.groupDelaySamples };
  }

  decodeNextLine(includePostPadding = true) {
    const predictedStart = this.nextLineStart;
    const window = this.extractWindow(
      predictedStart - this.paddingSamples,
      predictedStart + this.layoutSamples +
        (includePostPadding ? this.paddingSamples : 0)
    );
    if (!window) return null;
    const { freq, groupDelaySamples } = this.demodulateWindow(window.samples);
    const predictedRelativeStart = predictedStart - window.absoluteStart + groupDelaySamples;
    let correctionSamples = 0;
    let frequencyOffset = 0;
    let measuredSyncSample = null;

    if (this.syncLayout) {
      const targetHz = this.mode.syncFreq ?? this.syncLayout.segment.freq ?? FREQ.SYNC;
      const durationSamples = Math.max(
        1,
        this.syncLayout.endSamples - this.syncLayout.startSamples
      );
      const expectedSync = predictedRelativeStart + this.syncLayout.startSamples;
      const sync = findLocalSync(
        freq,
        expectedSync,
        durationSamples,
        this.syncSearchSamples,
        targetHz
      );
      if (sync) {
        correctionSamples = sync.start - expectedSync;
        frequencyOffset = sync.frequencyOffset;
        measuredSyncSample = window.absoluteStart + sync.start - groupDelaySamples;
      }
    }

    // A line-start sync can place the line being decoded. For a line-end sync,
    // the current line came before the observation, so only correct the next
    // line; otherwise a late pulse would repaint its already received pixels.
    const resolvedStart = this.mode.syncAtLineStart
      ? predictedStart + correctionSamples
      : predictedStart;
    const lineRelativeStart = resolvedStart - window.absoluteStart + groupDelaySamples;
    const channels = this.decodeChannels(freq, lineRelativeStart, frequencyOffset);
    const dataLine = this.nextDataLine;
    const patch = this.makePatch(dataLine, channels);

    if (measuredSyncSample != null && this.lastSyncSample != null && dataLine < 30) {
      const observed = measuredSyncSample - this.lastSyncSample;
      if (observed > this.currentLineSamples * 0.85 &&
          observed < this.currentLineSamples * 1.15) {
        this.currentLineSamples = this.currentLineSamples * 0.7 + observed * 0.3;
      }
    }
    if (measuredSyncSample != null) this.lastSyncSample = measuredSyncSample;
    const correctedClockStart = this.mode.syncAtLineStart
      ? resolvedStart
      : predictedStart + correctionSamples;
    this.nextLineStart = correctedClockStart + this.currentLineSamples;
    this.nextDataLine++;
    return patch;
  }

  decodeChannels(freq, lineRelativeStart, frequencyOffset) {
    const channels = Object.create(null);
    for (const { segment, startSamples, endSamples } of this.layout) {
      if (segment.type !== SegType.SCAN) continue;
      const guard = this.mode.robot36Legacy
        ? Math.min(
            Math.floor(1.5 * this.sampleRate / 1000),
            (endSamples - startSamples) >> 1
          )
        : 0;
      const segmentStart = lineRelativeStart + startSamples + guard;
      const segmentLength = endSamples - startSamples - guard;
      const perPixel = segmentLength / this.width;
      const values = new Uint8ClampedArray(this.width);
      for (let x = 0; x < this.width; x++) {
        const pixelStart = this.mode.robot36Legacy
          ? Math.floor(segmentStart + x * perPixel)
          : Math.round(segmentStart + x * perPixel);
        const pixelEnd = this.mode.robot36Legacy
          ? Math.floor(segmentStart + (x + 1) * perPixel)
          : Math.round(segmentStart + (x + 1) * perPixel);
        values[x] = freqToPixel(
          averageFrequency(freq, pixelStart, pixelEnd) - frequencyOffset,
          this.mode
        );
      }
      channels[segment.channel] = values;
    }
    return channels;
  }

  makePatch(dataLine, channels) {
    if (this.mode.chromaAlternate) {
      const current = {
        dataLine,
        y: channels.Y,
        chroma: channels.CHROMA,
        chromaType: dataLine % 2 === 0 ? 'Cr' : 'Cb',
      };
      if (current.chromaType === 'Cr') {
        this.pendingAlternate = current;
        return null;
      }
      const previous = this.pendingAlternate;
      this.pendingAlternate = null;
      if (!previous || previous.chromaType !== 'Cr' ||
          previous.dataLine !== current.dataLine - 1) return null;
      const cr = previous.chromaType === 'Cr' ? previous.chroma : current.chroma;
      const cb = previous.chromaType === 'Cb' ? previous.chroma : current.chroma;
      const pixels = new Uint8ClampedArray(this.width * 2 * 4);
      writeYuvRow(pixels, 0, previous.y, cr, cb, this.width);
      writeYuvRow(pixels, this.width * 4, current.y, cr, cb, this.width);
      return this.patch(previous.dataLine, 2, pixels, dataLine);
    }

    if (this.mode.pairedLines) {
      const pixels = new Uint8ClampedArray(this.width * 2 * 4);
      writeYuvRow(pixels, 0, channels.YODD, channels.Cr, channels.Cb, this.width);
      writeYuvRow(
        pixels,
        this.width * 4,
        channels.YEVEN,
        channels.Cr,
        channels.Cb,
        this.width
      );
      return this.patch(dataLine * 2, 2, pixels, dataLine);
    }

    if (this.mode.lineYuv || this.mode.colorSpace === ColorSpace.YUV) {
      const pixels = new Uint8ClampedArray(this.width * 4);
      writeYuvRow(pixels, 0, channels.Y, channels.Cr, channels.Cb, this.width);
      return this.patch(dataLine, 1, pixels, dataLine);
    }

    const pixels = this.mode.colorSpace === ColorSpace.GRAY
      ? rgbaFromGray(channels.Y, this.width)
      : rgbaFromRgb(channels, this.width);
    return this.patch(dataLine, 1, pixels, dataLine);
  }

  patch(y, rowCount, pixels, dataLine) {
    this.committedRows = Math.max(this.committedRows, y + rowCount);
    return {
      y,
      rowCount,
      pixels,
      rows: this.committedRows,
      totalRows: this.height,
      dataLine,
      // Patches are provisional even when every row is present. Only the
      // existing full-frame decoder is allowed to emit partial:false.
      partial: true,
    };
  }

  pruneChunks() {
    const keepFrom = Math.floor(this.nextLineStart - this.paddingSamples);
    while (this.chunks.length && this.chunks[0].end <= keepFrom) {
      this.chunks.shift();
    }
    if (!this.chunks.length || this.chunks[0].start >= keepFrom) return;
    const first = this.chunks[0];
    const discard = keepFrom - first.start;
    if (discard > 0) {
      first.data = first.data.subarray(discard);
      first.start = keepFrom;
    }
  }
}
