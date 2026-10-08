import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseElements } from './js/orbit-core.js';
import { TrackingStore, EphemerisSource, CatalogSource, TLE_URL, TRANSPONDER_URL, REFRESH_INTERVAL } from './js/tracking-store.js';
import { parseTransponders, toneFromTransponder, TransponderSource } from './js/transponders.js';
import { RadioProfiles } from './js/radio-profiles.js';

const raw = await readFile('test-fixtures/transponders.json', 'utf8');
const profiles = parseTransponders(raw);
const repeater = profiles.find(profile => profile.id === 'remote-iss-voice');
assert.equal(repeater.uplinkLowHz, 145990000);
assert.equal(repeater.lowHz, 437800000);
assert.equal(repeater.tone, '67.0 Hz');
assert.equal(profiles.find(profile => profile.catalogId === '100470').tone, '未提供');
assert.equal(profiles.find(profile => profile.catalogId === '100123').invert, true);
assert.equal(profiles.find(profile => profile.catalogId === '100123').uplinkMode, 'LSB');
for (const [description, expected] of [['V/U FM (PL 88.5Hz)', '88.5 Hz'], ['FM 67.0 PL', '67.0 Hz'],
  ['no CTCSS', '无需'], ['AFSK tones 1200 Hz', '未提供'], ['FM voice', '未提供']]) {
  assert.equal(toneFromTransponder({ description }), expected);
}
assert.equal(toneFromTransponder({ params: { ctcss: 67 } }), '67.0 Hz');
const input = JSON.parse(raw);
assert.equal(parseTransponders(JSON.stringify([{ ...input[0], norad_cat_id: 99914, norad_follow_id: 43775 }]))[0].catalogId, '43775');
assert.equal(parseTransponders(JSON.stringify([...input, { ...input[0], downlink_low: null }])).length, profiles.length);
for (const body of ['<html>error</html>', '{}', '[]', '[{}]', JSON.stringify([{ ...input[0], downlink_high: 1 }])]) assert.throws(() => parseTransponders(body));

const store = new TrackingStore(null, null), requests = [];
let transBody = raw, transStatus = 200;
const fetcher = async url => { requests.push(url); assert.equal(url, TRANSPONDER_URL); return { status: transStatus, text: async () => transBody }; };
const source = new TransponderSource(store, fetcher), now = Date.parse('2026-10-08T04:00:00Z');
await Promise.all([source.refresh(now), source.refresh(now)]);
assert.equal(requests.length, 1);
assert.equal((await source.refresh(now + 1)).limited, true);
const book = new RadioProfiles(store); await book.load();
assert.equal(book.list('27607')[0].tone, '67.0 Hz');
await book.select('27607', 'remote-so50-voice');
await book.save('27607', { name: 'My frequency', mode: 'FM', lowHz: 435000000, highHz: 435000000 });
const custom = book.current('27607').profile.id;
book.setRemote(profiles.map(profile => ({ ...profile, tone: '88.5 Hz' })));
assert.equal(book.current('27607').profile.id, custom, 'source refresh preserves custom selection');
await assert.rejects(book.remove('25544', 'remote-iss-voice'));
transBody = '<html>error</html>';
const failed = await source.refresh(now + REFRESH_INTERVAL);
assert.match(failed.error, /JSON/);
assert.deepEqual(failed.value, profiles, 'invalid remote data preserves last good snapshot');
assert.equal((await source.refresh(now + REFRESH_INTERVAL + 1)).limited, true);
transStatus = 503;
assert.match((await source.refresh(now + 2 * REFRESH_INTERVAL)).error, /503/);
const reopened = new RadioProfiles(store); await reopened.load();
assert.equal(reopened.current('27607').profile.id, custom);

// A full catalog exceeds the manual-import limits, without changing those limits.
const base = [
  '1 25544U 98067A   26280.56304952  .00004213  00000-0  85268-4 0  9995',
  '2 25544  51.6311 103.9669 0006810 234.3585 125.6769 15.48762857589177'
];
const tleLine = (line, id) => {
  const body = line.slice(0, 2) + id + line.slice(7, 68);
  const checksum = [...body].reduce((sum, char) => sum + (/\d/.test(char) ? Number(char) : char === '-' ? 1 : 0), 0) % 10;
  return body + checksum;
};
const all = ['ISS\n' + base.join('\n')];
for (let i = 0; i < 7000; i++) all.push(`TESTSAT ${i}\n${base.map(line => tleLine(line, String(30000 + i))).join('\n')}`);
const text = all.join('\n');
assert.ok(new Blob([text]).size > 1024 * 1024);
assert.throws(() => parseElements(text), /1 MB/);
const largeStore = new TrackingStore(null, null), orbitRequests = [];
const orbitFetch = async url => { orbitRequests.push(url); return { status: 200, text: async () => text }; };
const orbit = new EphemerisSource(largeStore, parseElements, orbitFetch), catalog = new CatalogSource(largeStore, parseElements, orbitFetch);
const [iss, directory] = await Promise.all([orbit.refresh(now), catalog.refresh(now)]);
assert.equal(orbitRequests.length, 1); assert.equal(orbitRequests[0], TLE_URL);
assert.equal(iss.record.catalogId, '25544'); assert.equal(directory.records.length, 7000);
assert.equal(directory.records[0].sourceUrl, TLE_URL);
assert.equal((await catalog.refresh(now + 1)).limited, true);
console.log('PASS TLEData: large TLE snapshot, one shared download, import limits, remote profiles, relay links, CTCSS/PL, missing tone, followed IDs, bands, custom selections, failed refresh and offline cache');
