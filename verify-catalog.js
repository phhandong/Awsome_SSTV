// verify-catalog.js - Guard the MMSSTV mode catalog, including narrow modes.

import { RXSSTV_MODE_CATALOG, getMode, listModes, SegType } from './js/modes.js';

const normalized = name => name.replace(/\s+/g, '').toLowerCase();
const engineIndexes = new Set(RXSSTV_MODE_CATALOG.map(mode => mode.engineIndex));
const implemented = RXSSTV_MODE_CATALOG.filter(mode => mode.implemented);
const browserModes = listModes();

let ok = RXSSTV_MODE_CATALOG.length === 43 && engineIndexes.size === 43 && browserModes.length === 43;
for (const catalogMode of implemented) {
  const browserMode = browserModes.find(mode => normalized(mode.name) === normalized(catalogMode.name));
  const matches = browserMode && browserMode.width === catalogMode.width && browserMode.height === catalogMode.height;
  if (!matches) {
    ok = false;
    console.error(`missing or mismatched browser mode: ${catalogMode.name}`);
  }
}

const robot36 = RXSSTV_MODE_CATALOG[3];
const pd120 = RXSSTV_MODE_CATALOG[16];
const mc180n = RXSSTV_MODE_CATALOG[42];
if (robot36.name !== 'Robot 36' || robot36.durationMs !== 36000 ||
    pd120.width !== 640 || pd120.height !== 496 || mc180n.name !== 'MC180-N') {
  ok = false;
  console.error('runtime catalog anchor values changed');
}

const robot36Mode = getMode(8);
const robot72Mode = getMode(12);
const robot36Durations = robot36Mode.lineSegments.map(segment => segment.durationMs).join(',');
const robot72Scans = robot72Mode.lineSegments
  .filter(segment => segment.type === SegType.SCAN)
  .map(segment => `${segment.channel}:${segment.durationMs}`).join(',');
if (robot36Mode.lineDurationMs !== 148.5 || robot36Durations !== '9,3,88,4.5,44' ||
    !robot36Mode.robot36Legacy || robot36Mode.syncPeriodMs !== 150 || robot36Mode.interlace?.fields !== 2 ||
    robot72Mode.lineDurationMs !== 300 || robot72Scans !== 'Y:138,Cr:69,Cb:69' ||
    !robot72Mode.lineYuv || robot72Mode.chromaAlternate) {
  ok = false;
  console.error('Robot36/Robot72 protocol timing changed');
}

console.log(`RXSSTV catalog: ${RXSSTV_MODE_CATALOG.length} engine modes, ${implemented.length} browser implementations`);
process.exit(ok ? 0 : 1);
