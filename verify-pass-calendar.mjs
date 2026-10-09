import assert from 'node:assert/strict';
import { createPassCalendar, exportPassCalendar } from './js/pass-calendar.js';

const now = Date.parse('2026-10-09T15:40:00Z');
const satellite = { id: 'import:25544', name: '国际空间站, ISS; 测试\\名称\nBEGIN:VEVENT', catalogId: '25544', epoch: now - 3600000 };
const observer = { latitude: 31.23, longitude: 121.47, altitude: 0 };
const pass = { rise: now + 10 * 60000, peak: now + 15 * 60000, set: now + 20 * 60000, maxElevation: 42.5 };
const input = { satellite, observer, pass, now };
const calendar = createPassCalendar(input);
const unfolded = calendar.content.replace(/\r\n /g, '');
assert.ok(calendar.content.endsWith('\r\n'));
assert.ok(calendar.content.split('\r\n').every(line => Buffer.byteLength(line, 'utf8') <= 75), 'UTF-8 line lengths');
assert.equal((unfolded.match(/^BEGIN:VEVENT$/gm) || []).length, 1, 'satellite name cannot inject an event');
assert.ok(unfolded.includes('SUMMARY:国际空间站\\, ISS\\; 测试\\\\名称\\nBEGIN:VEVENT 卫星过境\r\n'));
assert.ok(unfolded.includes('DTSTART:20261009T155000Z\r\nDTEND:20261009T160000Z'), 'UTC dates survive local midnight in Asia/Shanghai');
assert.ok(unfolded.includes('TRIGGER:-PT5M'));
assert.ok(unfolded.includes('最高仰角 42.5°'));
assert.ok(unfolded.includes('31.23000\\, 121.47000'));
const uid = value => value.content.replace(/\r\n /g, '').match(/^UID:(.*)\r$/m)[1];
assert.equal(uid(calendar), uid(createPassCalendar({ ...input, now: now + 1000 })), 'repeat export has same event identity');
assert.notEqual(uid(calendar), uid(createPassCalendar({ ...input, observer: { ...observer, latitude: 32 } })));
assert.equal(createPassCalendar({ ...input, now: pass.rise - 60000 }).content.includes('BEGIN:VALARM'), false, 'no reminder already in the past');
const partial = createPassCalendar({ ...input, pass: { ...pass, ongoingStart: true, ongoingEnd: true } });
assert.equal(partial.content.includes('BEGIN:VALARM'), false);
assert.match(partial.content.replace(/\r\n /g, ''), /并非实际升起时间/);
assert.match(partial.content.replace(/\r\n /g, ''), /并非实际落下时间/);
assert.throws(() => createPassCalendar({ ...input, now: pass.set }), /已结束/);
assert.throws(() => createPassCalendar({ ...input, pass: { ...pass, set: pass.rise } }), /无效/);
assert.throws(() => createPassCalendar({ ...input, pass: { ...pass, peak: NaN } }), /无效/);

// Exercise file sharing, cancellation and fallback without writing tracking storage.
let downloads = 0, shares = 0, removed = 0, revoked = 0;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalDocument = globalThis.document, originalTimeout = globalThis.setTimeout;
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
try {
  globalThis.document = { body: { append() {} }, createElement() { return { click() { downloads++; }, remove() { removed++; } }; } };
  URL.createObjectURL = blob => { assert.equal(blob.type, 'text/calendar;charset=utf-8'); return 'blob:test'; };
  URL.revokeObjectURL = () => { revoked++; };
  globalThis.setTimeout = fn => fn();
  const nav = { canShare: ({ files }) => files[0].name.endsWith('.ics'), share: async ({ files }) => {
    shares++; assert.equal(await files[0].text(), calendar.content);
  } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav });
  assert.equal(await exportPassCalendar(calendar), 'shared');
  assert.equal(downloads, 0);
  nav.share = async () => { throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
  assert.equal(await exportPassCalendar(calendar), 'cancelled');
  assert.equal(downloads, 0, 'cancel should not download silently');
  nav.share = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  assert.equal(await exportPassCalendar(calendar), 'downloaded');
  nav.canShare = () => false;
  assert.equal(await exportPassCalendar(calendar), 'downloaded');
  assert.equal(downloads, 2); assert.equal(removed, 2); assert.equal(revoked, 2); assert.equal(shares, 1);
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  globalThis.setTimeout = originalTimeout; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
}
console.log('PASS pass calendar: UTC, escaping, UTF-8 folding, reminders, partial passes, share/cancel/download');
