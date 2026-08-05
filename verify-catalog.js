// verify-catalog.js - Guard the runtime-extracted RXSSTV mode catalog.

import { RXSSTV_MODE_CATALOG, listModes } from './js/modes.js';

const normalized = name => name.replace(/\s+/g, '').toLowerCase();
const engineIndexes = new Set(RXSSTV_MODE_CATALOG.map(mode => mode.engineIndex));
const implemented = RXSSTV_MODE_CATALOG.filter(mode => mode.implemented);
const browserModes = listModes();

let ok = RXSSTV_MODE_CATALOG.length === 37 && engineIndexes.size === 37;
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
if (robot36.name !== 'Robot 36' || robot36.durationMs !== 36000 ||
    pd120.width !== 640 || pd120.height !== 496) {
  ok = false;
  console.error('runtime catalog anchor values changed');
}

console.log(`RXSSTV catalog: ${RXSSTV_MODE_CATALOG.length} engine modes, ${implemented.length} browser implementations`);
process.exit(ok ? 0 : 1);
