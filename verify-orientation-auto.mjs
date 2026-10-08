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
  assert.match(first.states.at(-1).message, /首次/);
  feed(first.phone);
  assert.equal(first.phone.offset, null, 'one sample cannot auto-calibrate');
  first.phone.resume();
  assert.equal(first.phone.calibrationSamples.length, 1, 'view switch preserves calibration in progress');
  for (let i = 0; i < 22; i++) feed(first.phone, { webkitCompassHeading: i % 2 ? 1 : 359 });
  assert.ok(first.states.at(-1).valid);
  assert.ok(Math.abs(angleDelta(first.phone.pose.azimuth, 0)) < 2, 'wrap stays near north');
  assert.equal(storage.size, 1, 'only onboarding is persisted');
  first.phone.stop();

  const reopened = create();
  await reopened.phone.enable();
  assert.doesNotMatch(reopened.states.at(-1).message, /首次/);
  assert.equal(reopened.phone.offset, null, 'never restore an old sensor offset');
  stable(reopened.phone, { alpha: 100, webkitCompassHeading: 40 });
  assert.ok(reopened.phone.pose.valid);
  assert.ok(Math.abs(angleDelta(reopened.phone.pose.azimuth, 40)) < .01);
  const originalOffset = reopened.phone.offset;
  const started = reopened.phone.waitStarted;
  reopened.phone.resume(); reopened.phone.resume();
  assert.equal(reopened.phone.waitStarted, started, 'switching views leaves the current session alone');
  assert.equal(listeners.size, 1, 'repeated resume cannot duplicate listeners');
  reopened.phone.pause();
  assert.equal(reopened.phone.pose, null);
  assert.equal(reopened.phone.sample, null);
  assert.equal(listeners.size, 0);
  assert.equal(reopened.phone.offset, originalOffset, 'background retains only the reference');
  now += 30000;
  reopened.phone.resume();
  assert.match(reopened.states.at(-1).message, /无需重新平放/);
  assert.equal(reopened.phone.pose, null, 'resume waits for a fresh reading');
  feed(reopened.phone, { alpha: 100, beta: 45, webkitCompassHeading: 40 });
  assert.ok(reopened.phone.pose.valid, 'tilted phone resumes immediately without flat calibration');
  assert.equal(reopened.phone.offset, originalOffset);
  assert.ok(Math.abs(reopened.phone.pose.elevation - 45) < .01);
  const requestsBefore = permissionRequests;
  await reopened.phone.enable();
  assert.equal(permissionRequests, requestsBefore, 'an enabled session does not request permission again');
  assert.equal(reopened.phone.offset, originalOffset, 'repeated enable preserves calibration');
  reopened.phone.pause(); reopened.phone.resume();
  feed(reopened.phone, { alpha: 230, webkitCompassHeading: 70 });
  assert.equal(reopened.phone.offset, null, 'changed sensor frame requires a fresh calibration');
  stable(reopened.phone, { alpha: 230, webkitCompassHeading: 70 });
  assert.ok(Math.abs(angleDelta(reopened.phone.pose.azimuth, 70)) < .01, 'foreground establishes a fresh reference');

  reopened.phone.pause();
  now += ORIENTATION_REUSE_MS + 1;
  reopened.phone.pause(); reopened.phone.resume();
  assert.equal(reopened.phone.offset, null, 'duplicate pause cannot extend retention');
  assert.match(reopened.states.at(-1).message, /过期.*平放/);
  stable(reopened.phone);
  reopened.phone.pause(); reopened.phone.resume();
  feed(reopened.phone, { beta: 40, webkitCompassAccuracy: 50 });
  assert.equal(reopened.phone.offset, null, 'unreliable compass cannot reuse a reference');
  stable(reopened.phone);
  reopened.phone.pause();
  now -= 1000;
  reopened.phone.resume();
  assert.equal(reopened.phone.offset, null, 'clock rollback rejects cached reference');
  stable(reopened.phone);
  now += ORIENTATION_REUSE_MS + 1;
  feed(reopened.phone, { beta: 40 });
  assert.equal(reopened.phone.offset, null, 'a silent sensor gap also expires the reference');

  reopened.phone.invalidate('test');
  stable(reopened.phone, { beta: 40 });
  assert.equal(reopened.phone.offset, null, 'tilted readings require flat recovery');
  assert.match(reopened.states.at(-1).message, /短暂平放/);
  stable(reopened.phone, { webkitCompassAccuracy: 40 });
  assert.equal(reopened.phone.offset, null);
  for (let i = 0; i < 40; i++) feed(reopened.phone, { alpha: (360 - i * 10) % 360, webkitCompassHeading: i * 10 % 360 });
  assert.equal(reopened.phone.offset, null, 'moving phone cannot pass stability check');
  for (let i = 0; i < 10; i++) feed(reopened.phone);
  feed(reopened.phone, {}, 1000);
  for (let i = 0; i < 11; i++) feed(reopened.phone);
  assert.equal(reopened.phone.offset, null, 'interrupted samples do not count as continuous stability');
  stable(reopened.phone);
  assert.ok(reopened.phone.pose.valid, 'recovers without a calibration click');
  feed(reopened.phone, { alpha: NaN });
  assert.equal(reopened.phone.pose, null);
  stable(reopened.phone);
  assert.ok(reopened.phone.pose.valid);
  reopened.phone.stop();
  assert.equal(reopened.phone.offset, null, 'explicit stop clears the reference');
  assert.equal(reopened.phone.sample, null);

  permission = 'denied';
  await assert.rejects(create().phone.enable(), /权限未允许/);
  assert.equal(listeners.size, 0, 'denied permission does not attach listeners');
  permission = 'granted';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('storage unavailable'); } });
  const privateMode = create();
  await privateMode.phone.enable();
  stable(privateMode.phone);
  assert.ok(privateMode.phone.pose.valid, 'storage is optional');
  privateMode.phone.stop();
  console.log('PASS automatic orientation: visible guide states, stable sampling, north wrap, short resume, expiry, sensor reset, bad readings, permissions and unavailable storage');
} finally {
  Date.now = savedNow;
  for (const [key, descriptor] of [['localStorage', storageDescriptor], ['window', windowDescriptor]]) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
