// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright 2000-2013 Makoto Mori, Nobuyuki Oba
// JavaScript adaptation copyright 2026 Awesome SSTV contributors

import { findSyncPulses } from './demod.js';
import { FREQ, getMode, listModes } from './modes.js';

const DEFAULT_TOLERANCE_MS = 3;
const MIN_MATCHED_INTERVALS = 3;

export function resolveReceiveMode(value) {
  if (value == null || value === '' || value === 'auto') return null;
  if (typeof value === 'object' && value.lineDurationMs) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return getMode(numeric);
  return listModes().find(mode => mode.name === value) || null;
}

function scoreMode(pulses, mode, sampleRate, toleranceMs) {
  if (pulses.length < MIN_MATCHED_INTERVALS + 1) return null;
  const ideal = mode.lineDurationMs * sampleRate / 1000;
  const tolerance = toleranceMs * sampleRate / 1000;
  let matches = 0;
  let directMatches = 0;
  let error = 0;
  let missedLines = 0;

  for (let i = 1; i < pulses.length; i++) {
    const gap = pulses[i] - pulses[i - 1];
    const lineStep = Math.max(1, Math.min(3, Math.round(gap / ideal)));
    const normalized = gap / lineStep;
    const delta = Math.abs(normalized - ideal);
    if (delta <= tolerance) {
      matches++;
      if (lineStep === 1) directMatches++;
      missedLines += lineStep - 1;
      error += delta / sampleRate * 1000;
    }
  }

  if (matches < MIN_MATCHED_INTERVALS) return null;
  const coverage = matches / (pulses.length - 1);
  if (coverage < 0.55) return null;
  const meanErrorMs = error / matches;
  const score = matches * 12 + directMatches * 8 + coverage * 10
    - meanErrorMs * 3 - missedLines * 2;
  return { mode, score, matches, directMatches, meanErrorMs, coverage };
}

/**
 * MMSSTV-style remote start based on repeated sync-pulse intervals.
 * Missing pulses are accepted as two or three line periods.
 */
export function detectSyncMode(frequency, sampleRate, options = {}) {
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const candidates = [];

  for (const narrow of [false, true]) {
    const targetHz = narrow ? FREQ.NARROW_SYNC : FREQ.SYNC;
    let pulses = findSyncPulses(frequency, sampleRate, 4, 0.25, targetHz);
    if (pulses.length < MIN_MATCHED_INTERVALS + 1) {
      pulses = findSyncPulses(frequency, sampleRate, 4, 0.12, targetHz);
    }
    for (const mode of listModes()) {
      if (mode.noSync || Boolean(mode.narrow) !== narrow) continue;
      const scored = scoreMode(pulses, mode, sampleRate, toleranceMs);
      if (scored) candidates.push({ ...scored, pulses, targetHz });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.meanErrorMs - b.meanErrorMs);
  const best = candidates[0];
  if (!best) return null;
  return {
    source: 'sync',
    mode: best.mode,
    sampleOffset: best.pulses[0],
    pulses: best.pulses,
    confidence: Math.min(1, best.coverage * (0.65 + 0.35 * best.directMatches / best.matches)),
    meanErrorMs: best.meanErrorMs,
    matchedIntervals: best.matches,
    targetHz: best.targetHz,
  };
}
