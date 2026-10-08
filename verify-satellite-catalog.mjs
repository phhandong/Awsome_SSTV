import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseElements } from './js/orbit-core.js';
import { TrackingStore, EphemerisSource, CatalogSource, REFRESH_INTERVAL, TLE_URL, ORBIT_REQUEST_KEY } from './js/tracking-store.js';
import { ISS_ID, mergeCatalog, retainedCatalog, catalogChoices, orbitStatus } from './js/tracking-catalog.js';

// Synthetic OMM orbits: fixture names/IDs exercise the directory, not reference orbit accuracy.
const issText = await readFile('test-fixtures/iss.json', 'utf8');
const amateurText = await readFile('test-fixtures/amateur.json', 'utf8');
const inputs = JSON.parse(amateurText);
const now = Date.parse('2026-10-06T08:00:00Z');
const store = new TrackingStore(null, null), requests = [];
const fetcher = async url => { requests.push(url); return { status: 200, text: async () => amateurText }; };
const issSource = new EphemerisSource(store, parseElements, fetcher);
const catalogSource = new CatalogSource(store, parseElements, fetcher);
const [iss, catalog] = await Promise.all([issSource.refresh(now), catalogSource.refresh(now), catalogSource.refresh(now)]);
assert.equal(requests.length, 1, 'ISS and directory share one concurrent download');
assert.equal(catalog.records.length, 3);
assert.ok(catalog.records.every(item => item.id !== ISS_ID));
assert.ok(catalog.records.some(item => item.catalogId === '100123'), 'OMM supports six-digit NORAD IDs');
await issSource.refresh(now + 1); await catalogSource.refresh(now + 1);
assert.equal(requests.length, 1);
await catalogSource.refresh(now + REFRESH_INTERVAL);
assert.equal(requests.filter(url => url === TLE_URL).length, 2);
assert.equal(await store.get(ORBIT_REQUEST_KEY), now + REFRESH_INTERVAL);

// A whole response must validate before replacing the previous good snapshot.
for (const [body, status, message] of [
  ['<html>Server Error</html>', 200, /TLE/], ['[]', 200, /最多导入/],
  ['[{}]', 200, /OMM/], ['[{', 200, /JSON/], [amateurText, 503, /503/],
  [JSON.stringify([...inputs, { ...inputs[1], ECCENTRICITY: 2 }]), 200, /范围/],
  [JSON.stringify(inputs.filter(item => item.NORAD_CAT_ID !== 25544)), 200, /没有 ISS/]
]) {
  const cached = await store.get('amateur');
  const next = (await store.get(ORBIT_REQUEST_KEY)) + REFRESH_INTERVAL;
  let calls = 0;
  const failed = new CatalogSource(store, parseElements, async () => { calls++; return { status, text: async () => body }; });
  const result = await failed.refresh(next);
  assert.match(result.error, message);
  assert.deepEqual(result.records, cached);
  assert.deepEqual(await store.get('amateur'), cached);
  assert.equal((await failed.refresh(next + 1)).limited, true);
  assert.equal(calls, 1, 'failed requests are rate limited');
}
const next = (await store.get(ORBIT_REQUEST_KEY)) + REFRESH_INTERVAL;
const timeout = new CatalogSource(store, parseElements, (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
}), { timeoutMs: 5 });
assert.match((await timeout.refresh(next)).error, /超时/);
assert.equal((await timeout.refresh(next + 1)).limited, true);

const duplicates = [...inputs, { ...inputs[1], OBJECT_NAME: 'AO-7 renamed' }];
const freshStore = new TrackingStore(null, null);
const deduplicated = await new CatalogSource(freshStore, parseElements, async () => ({ status: 200, text: async () => JSON.stringify(duplicates) })).refresh(now);
assert.equal(deduplicated.records.length, 3);
assert.equal(deduplicated.records.find(item => item.catalogId === '7530').name, 'AO-7 renamed');
const local = parseElements(issText)[0];
const all = [iss.record, local, ...catalog.records];
const favorites = new Set(['celestrak:7530', local.id]);
assert.equal(catalogChoices(all, favorites, '  Ao-7  ')[0].id, 'celestrak:7530');
assert.equal(catalogChoices(all, favorites, '100123')[0].name, 'TESTSAT-6');
assert.deepEqual(catalogChoices(all, favorites, '', 'imports').map(item => item.id), [local.id]);
assert.equal(catalogChoices(all, favorites, '', 'favorites').length, 2);
assert.equal(catalogChoices(all, new Set())[0].id, ISS_ID, 'ISS follows favorites and precedes names');
assert.equal(catalogChoices(all, favorites, 'nothing').length, 0);
assert.equal(catalogChoices([], new Set())[0].id, ISS_ID, 'ISS remains selectable before initial fetch');

const snapshot = catalog.records.filter(item => item.catalogId === '100123');
const merged = mergeCatalog(all, snapshot, favorites, 'celestrak:24278');
assert.deepEqual(merged.filter(item => item.missingFromCatalog).map(item => item.catalogId).sort(), ['24278', '7530']);
assert.ok(merged.some(item => item.id === local.id), 'manual import survives automatic snapshot');
const protectedSnapshot = retainedCatalog(merged, favorites, 'celestrak:24278');
assert.equal(protectedSnapshot.length, 2);
const restarted = mergeCatalog([iss.record, local, ...protectedSnapshot], snapshot, favorites, 'celestrak:24278');
assert.ok(restarted.find(item => item.id === 'celestrak:7530').missingFromCatalog, 'retained target survives restart');
const returned = mergeCatalog(restarted, deduplicated.records, favorites, 'celestrak:24278');
assert.equal(returned.find(item => item.id === 'celestrak:7530').missingFromCatalog, false);
assert.equal(catalogChoices(returned, favorites, '', 'favorites').length, 2, 'renaming does not lose favorites');
const pruned = mergeCatalog(merged, snapshot, new Set(), ISS_ID);
assert.equal(pruned.some(item => item.missingFromCatalog), false);
assert.match(orbitStatus(merged.find(item => item.id === 'celestrak:7530'), now + 4 * 86400000), /未在最新目录中.*较旧/);
assert.match(orbitStatus({ epoch: now + 2 * 86400000 }, now), /未来/);

const fallback = new TrackingStore(null, { getItem() { throw Error('storage denied'); }, setItem() { throw Error('quota'); } });
await fallback.set('favorites', [...favorites]);
assert.deepEqual(await fallback.get('favorites'), [...favorites]);
assert.equal(fallback.persistent, false);
const failedWrite = new TrackingStore(null, null);
failedWrite.open = async () => ({ transaction() { return { objectStore() { return {
  put() { throw Error('quota exceeded'); },
  get() { const request = { result: 'old cached value' }; queueMicrotask(() => request.onsuccess()); return request; }
}; } }; } });
await failedWrite.set('amateur', catalog.records);
assert.deepEqual(await failedWrite.get('amateur'), catalog.records, 'failed persistence must not resurrect old DB data in this session');
assert.equal(failedWrite.persistent, false);
const claims = await Promise.all([fallback.claimRequest(now, 'amateur'), fallback.claimRequest(now, 'amateur'), fallback.claimRequest(now)]);
assert.deepEqual(claims, [true, false, true], 'memory fallback claims serialize without sharing feed limits');
assert.equal((await new CatalogSource(fallback, parseElements, fetcher).refresh(now)).records.length, 3);
console.log('PASS satellite catalog: feed isolation, deduplication, strict responses, timeout, failed-request limits, search, favorites, retained targets and memory fallback');
