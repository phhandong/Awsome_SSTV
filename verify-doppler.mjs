import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lookAt, parseElements, recordToSatrec, radialVelocity, LIGHT_SPEED_KM_S } from './js/orbit-core.js';
import { RadioProfiles, mhzToHz, receivedFrequency } from './js/radio-profiles.js';
import { TrackingStore } from './js/tracking-store.js';
const near = (a, b, tolerance) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
for (const speed of [-7, 0, 7]) {
  const rate = radialVelocity({ x: 1000, y: 0, z: 0 }, { x: speed, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  assert.equal(rate, speed);
  const point = { time: 1000, dopplerFactor: 1 - rate / LIGHT_SPEED_KM_S };
  const a = receivedFrequency(145800000, point, 1000), b = receivedFrequency(437550000, point, 1000);
  near(a.shiftHz, -145800000 * speed / LIGHT_SPEED_KM_S, .00001);
  near(b.shiftHz, a.shiftHz * 437550000 / 145800000, .00001);
}
near(radialVelocity({ x: 6378, y: 1000, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 6378, y: 0, z: 0 }), -6378 * 7.292115e-5, 1e-10);
const record = parseElements(await readFile('test-fixtures/iss.json', 'utf8'))[0], sat = recordToSatrec(record);
for (const observer of [{ latitude: 31.23, longitude: 121.47, altitude: 0 }, { latitude: 0, longitude: 0, altitude: 2000 }, { latitude: 80, longitude: -30, altitude: 0 }]) {
  for (let i = 0; i < 12; i++) {
    const time = record.epoch + i * 300000, point = lookAt(sat, observer, time);
    const difference = (lookAt(sat, observer, time + 500).distance - lookAt(sat, observer, time - 500).distance);
    // SGP4's reported velocity and differentiated positions differ slightly;
    // 0.5 m/s is below 0.8 Hz at 437.55 MHz, and catches frame/sign errors.
    near(point.rangeRateKmS, difference, .0005);
  }
}
assert.equal(receivedFrequency(145800000, { time: 0, dopplerFactor: 1 }, 4001), null);
assert.equal(receivedFrequency(145800000, { time: 1000, dopplerFactor: 1 }, 0), null);
assert.equal(receivedFrequency(145800000, null), null);
for (const input of ['', '-1', '0', 'Infinity', '1e6', '144.1234567']) assert.throws(() => mhzToHz(input));
assert.equal(mhzToHz('437.550001'), 437550001);
const store = new TrackingStore(null, null), book = new RadioProfiles(store); await book.load();
assert.equal(book.current('25544').tunedHz, 437550000);
assert.equal(book.current('12345'), null);
await book.save('25544', { name: 'My band', mode: 'USB', lowHz: 435000000, highHz: 435100000 });
const id = book.current('25544').profile.id;
assert.equal(book.current('25544').tunedHz, 435050000);
await book.select('25544', id, 435025000);
await assert.rejects(book.select('25544', id, 436000000));
assert.equal(book.current('25544').tunedHz, 435025000);
const reopened = new RadioProfiles(store); await reopened.load();
assert.equal(reopened.current('25544').tunedHz, 435025000);
assert.equal(reopened.current('12345'), null);
await assert.rejects(reopened.save('25544', { id, name: 'bad', lowHz: 2, highHz: 1 }));
assert.equal(reopened.current('25544').profile.name, 'My band');
await reopened.save('25544', { id, name: 'Edited', mode: 'FM', lowHz: 436000000, highHz: 436000000 });
assert.equal(reopened.current('25544').tunedHz, 436000000);
await assert.rejects(reopened.remove('25544', 'iss-sstv-uhf'));
await reopened.remove('25544', id);
assert.equal(reopened.current('25544').tunedHz, 437550000);
console.log('PASS Doppler: signs, Earth rotation, independent range differentiation; profiles, bands, persistence, invalid data and session fallback');
