import assert from 'node:assert/strict';
import { PhoneOrientation, angleDelta, ORIENTATION_REUSE_MS } from './js/orientation.js';

const savedNow = Date.now;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
let now = Date.UTC(2026, 9, 7), permission = 'granted', permissionRequests = 0;
const storage = new Map(), listeners = new Set();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  isSecureContext: true,
  DeviceOrientationEvent: { requestPermission: async () => { permissionRequests++; return permission; } },
  addEventListener: (_, listener) => listeners.add(listener),
  removeEventListener: (_, listener) => listeners.delete(listener),
} });
Date.now = () => now;
function create() {
  const states = [];
  const phone = new PhoneOrientation(value => states.push(value));
  phone.declination = 0;
  return { phone, states };
}
function feed(phone, overrides = {}, step = 100) {
  now += step;
  phone.consume({ alpha: 0, beta: 0, gamma: 0, webkitCompassHeading: 0, webkitCompassAccuracy: 5, ...overrides });
}
function stable(phone, overrides = {}) { for (let i = 0; i < 22; i++) feed(phone, overrides); }
try {
  const first = create();
  await first.phone.enable();
  assert.match(first.states.at(-1).title, /首次/);
  feed(first.phone);
  assert.equal(first.phone.offset, null, 'one sample cannot auto-calibrate');
  first.phone.resume();
  assert.equal(first.phone.calibrationSamples.length, 1, 'view switch preserves calibration in progress');
  for (let i = 0; i < 22; i++) feed(first.phone, { webkitCompassHeading: i % 2 ? 1 : 359 });
  assert.ok(first.states.at(-1).valid);
  assert.ok(Math.abs(angleDelta(first.phone.pose.azimuth, 0)) < 2, 'wrap stays near north');
  assert.ok(first.states.some(s => s.progress > 0 && s.progress < 100), 'alignment reports real sample progress');
  assert.equal(storage.size, 1, 'only onboarding is persisted');
  first.phone.stop();

  const reopened = create(), p = reopened.phone;
  await p.enable();
  assert.doesNotMatch(reopened.states.at(-1).title, /首次/);
  assert.equal(p.offset, null, 'never restore an old sensor offset');
  stable(p, { alpha: 100, webkitCompassHeading: 40 });
  assert.ok(Math.abs(angleDelta(p.pose.azimuth, 40)) < .01);
  const originalOffset = p.offset, requestsBefore = permissionRequests;
  await p.enable(); p.resume();
  assert.equal(permissionRequests, requestsBefore);
  assert.equal(listeners.size, 1);
  assert.equal(p.offset, originalOffset);

  // Manual alignment must not bypass the 2-second quality/stability gate.
  p.calibrate();
  assert.equal(p.offset, null);
  feed(p);
  assert.equal(p.pose, null);
  stable(p);
  assert.ok(p.pose.valid);

  // A single bad compass sample hides the pointer but retains the reference.
  const reference = p.offset;
  feed(p, { beta: 45, webkitCompassAccuracy: -1 });
  assert.equal(p.offset, reference);
  assert.equal(p.pose, null);
  assert.match(reopened.states.at(-1).title, /系统罗盘尚未就绪/);
  feed(p, { beta: 45 });
  assert.equal(p.pose, null, 'wait for recovery stability');
  for (let i = 0; i < 6; i++) feed(p, { beta: 45 });
  assert.ok(p.pose.valid, 'brief fault recovers while tilted');
  assert.equal(p.offset, reference);
  assert.ok(Math.abs(p.pose.elevation - 45) < 1e-9);
  // The 20-degree gate must not turn into a calibration reset at 21 degrees.
  feed(p, { beta: 45, webkitCompassAccuracy: 21 });
  assert.equal(p.offset, reference);
  assert.equal(reopened.states.at(-1).state, 'accuracy');
  for (let i = 0; i < 7; i++) feed(p, { beta: 45 });
  assert.ok(p.pose.valid);

  // Repeated noisy readings cannot repeatedly announce ready.
  for (let i = 0; i < 20; i++) feed(p, { beta: 45, webkitCompassAccuracy: i % 2 ? 5 : 25 });
  assert.equal(p.pose, null);
  stable(p);
  assert.ok(p.pose.valid);
  feed(p, { beta: 45, alpha: NaN });
  assert.equal(p.sample, null);
  assert.equal(p.pose, null);
  for (let i = 0; i < 7; i++) feed(p, { beta: 45 });
  assert.ok(p.pose.valid, 'brief missing attitude also recovers');

  // Long faults require validation, even after the reported accuracy improves.
  stable(p, { beta: 45, webkitCompassAccuracy: -1 });
  stable(p, { beta: 45 });
  assert.equal(p.pose, null);
  assert.equal(p.checkResumedReference, true);
  assert.match(reopened.states.at(-1).title, /核验/);
  stable(p);
  assert.ok(p.pose.valid);

  // Regression: arbitrary relative yaw reset after background must not produce
  // a valid 90-degree error, even if compass accuracy says +/-5 degrees.
  p.pause();
  assert.equal(p.pose, null); assert.equal(p.sample, null); assert.equal(listeners.size, 0);
  now += 30000; p.resume();
  const beforeFresh = reopened.states.length;
  feed(p, { alpha: 90, beta: 45 });
  assert.ok(reopened.states.length > beforeFresh, 'first fresh event refreshes a stale UI even if the pending message matches');
  assert.equal(p.pose, null);
  for (let i = 0; i < 1800; i++) feed(p, { alpha: 90, beta: 45 });
  assert.equal(p.pose, null, 'tilted accuracy cannot validate the old frame, even after three minutes');
  stable(p, { alpha: 90 });
  assert.ok(Math.abs(angleDelta(p.pose.azimuth, 0)) < .01, 'flat check repairs the reset frame');
  feed(p, { alpha: 90, beta: 45 });
  assert.ok(p.pose.valid);

  // Active tilted tracking does not demand a new flat check every two minutes.
  for (let i = 0; i < 1800; i++) feed(p, { alpha: 90, beta: 45 });
  assert.ok(p.pose.valid);
  p.pause(); now += ORIENTATION_REUSE_MS + 1; p.pause(); p.resume();
  assert.equal(p.offset, null);
  assert.match(reopened.states.at(-1).title, /过期/);
  stable(p);
  p.pause(); now -= 1000; p.resume();
  assert.equal(p.offset, null, 'clock rollback rejects reference');
  stable(p);
  feed(p, { beta: 45 }, 3000);
  assert.equal(p.pose, null, 'a silent gap requires a reference check');
  stable(p);

  p.invalidate('test');
  stable(p, { beta: 40 });
  assert.equal(p.offset, null);
  assert.equal(reopened.states.at(-1).state, 'flat');
  for (const bad of [undefined, null, NaN, -1, 40]) {
    stable(p, { webkitCompassAccuracy: bad });
    assert.equal(p.offset, null);
    assert.doesNotMatch(reopened.states.at(-1).message, /磁场|磁性|干扰/);
  }
  for (let i = 0; i < 40; i++) feed(p, { alpha: (360 - i * 10) % 360, webkitCompassHeading: i * 10 % 360 });
  assert.equal(p.offset, null, 'moving phone cannot pass stability check');
  for (let i = 0; i < 10; i++) feed(p);
  feed(p, {}, 1000);
  for (let i = 0; i < 11; i++) feed(p);
  assert.equal(p.offset, null, 'interrupted samples do not count as continuous stability');
  stable(p);
  assert.ok(p.pose.valid);
  // A large reference change while flat must also be checked, not blended in.
  feed(p, { alpha: 90 });
  assert.equal(p.pose, null);
  stable(p, { alpha: 90 });
  assert.ok(Math.abs(angleDelta(p.pose.azimuth, 0)) < .01);
  p.stop();
  feed(p);
  assert.equal(p.sample, null, 'disabled sensors ignore queued events');
  assert.equal(p.offset, null);

  permission = 'denied';
  await assert.rejects(create().phone.enable(), /权限未允许/);
  assert.equal(listeners.size, 0);
  permission = 'granted';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('storage unavailable'); } });
  const privateMode = create();
  await privateMode.phone.enable(); stable(privateMode.phone);
  assert.ok(privateMode.phone.pose.valid);
  privateMode.phone.stop();
  console.log('PASS orientation: stable manual/auto alignment, progress, transient recovery, prolonged faults, 90-degree resume regression, sensor gaps, expiry, north wrap and permissions');
} finally {
  Date.now = savedNow;
  for (const [key, descriptor] of [['localStorage', storageDescriptor], ['window', windowDescriptor]]) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
