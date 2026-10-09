import { createPassCalendar } from './pass-calendar.js';

const MAX_DATA_LENGTH = 8192;

// Only the event snapshot is sent; imported orbital elements and browser storage stay local.
function snapshot(input) {
  const { satellite, observer, pass, now = Date.now() } = input;
  if (!satellite || !observer || !pass) throw new Error('缺少过境信息');
  const value = { v: 1, satellite: { id: satellite.id, name: satellite.name, catalogId: satellite.catalogId, epoch: satellite.epoch },
    observer: { latitude: observer.latitude, longitude: observer.longitude, altitude: observer.altitude },
    pass: { rise: pass.rise, peak: pass.peak, set: pass.set, maxElevation: pass.maxElevation,
      ongoingStart: !!pass.ongoingStart, ongoingEnd: !!pass.ongoingEnd }, now };
  validateSnapshot(value);
  return value;
}

function validateSnapshot(value) {
  if (value?.v !== 1 || typeof value.satellite?.id !== 'string' || value.satellite.id.length > 160
    || typeof value.satellite.name !== 'string' || value.satellite.name.length > 160
    || !/^\d{1,9}$/.test(String(value.satellite.catalogId))
    || !value.observer || Math.abs(value.observer.latitude) > 90 || Math.abs(value.observer.longitude) > 180
    || value.observer.altitude < -1000 || value.observer.altitude > 100000
    || !value.pass || value.pass.maxElevation < 0 || value.pass.maxElevation > 90
    || ![value.now, value.satellite.epoch, value.pass.rise, value.pass.peak, value.pass.set].every(time =>
      Number.isFinite(time) && time >= 0 && time < Date.UTC(2100, 0, 1))
    || value.pass.set - value.pass.rise > 86400000) throw new Error('订阅日历信息无效');
  createPassCalendar(value);
}

function endpointURL(endpoint) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('订阅地址无效');
  url.hash = ''; url.search = '';
  return url;
}

export function createPassSubscription(input, endpoint) {
  const value = snapshot(input);
  const data = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (data.length > MAX_DATA_LENGTH) throw new Error('订阅日历信息过长');
  const url = endpointURL(endpoint);
  url.searchParams.set('data', data);
  return { url: url.href, webcalURL: url.href.replace(/^https?:/, 'webcal:') };
}

export function readPassSubscription(data) {
  if (typeof data !== 'string' || !data.length || data.length > MAX_DATA_LENGTH || !/^[A-Za-z0-9_-]+$/.test(data)) {
    throw new Error('订阅日历信息无效');
  }
  const bytes = Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  validateSnapshot(value);
  return value;
}

export async function findCalendarEndpoint(endpoint, fetcher = globalThis.fetch) {
  try {
    const url = endpointURL(endpoint); url.searchParams.set('capabilities', '1');
    const response = await fetcher(url.href, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) return null;
    const value = await response.json();
    return value.service === 'awesome-sstv-pass-calendar' && value.version === 1 ? endpointURL(endpoint).href : null;
  } catch (_) { return null; }
}
