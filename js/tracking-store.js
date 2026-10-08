export const REFRESH_INTERVAL = 2 * 60 * 60 * 1000;
export const TLE_URL = 'https://tledata.xanyi.eu.org/tledata/all.txt';
export const TRANSPONDER_URL = 'https://tledata.xanyi.eu.org/tledata/trans.json';
export const ISS_URL = TLE_URL;
export const AMATEUR_URL = TLE_URL;
export const ORBIT_REQUEST_KEY = 'lastRequest:tledata';
const defaultFetch = (...args) => globalThis.fetch(...args);
const sharedOrbits = new WeakMap();

// All persistent writes are best-effort. A failed store never disables the receiver.
export class TrackingStore {
  constructor(indexedDB = globalThis.indexedDB, fallback) {
    if (fallback === undefined) { try { fallback = globalThis.localStorage; } catch (_) { fallback = null; } }
    this.indexedDB = indexedDB; this.fallback = fallback; this.memory = new Map(); this.persistent = true;
    this.unpersisted = new Set();
    this.claims = Promise.resolve();
  }
  async open() {
    if (this.opening) return this.opening;
    this.opening = new Promise(resolve => {
      if (!this.indexedDB) { this.persistent = false; resolve(null); return; }
      let request;
      try { request = this.indexedDB.open('sstv-tracking', 1); } catch (_) { this.persistent = false; resolve(null); return; }
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = request.onblocked = () => { this.persistent = false; resolve(null); };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    return this.opening;
  }
  async get(key) {
    if (this.unpersisted.has(key)) return this.memory.get(key);
    const db = await this.open();
    if (db) {
      try {
        const value = await new Promise((resolve, reject) => { const r = db.transaction('state').objectStore('state').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        if (value !== undefined) return value;
      }
      catch (_) { this.persistent = false; }
    }
    try { return JSON.parse(this.fallback?.getItem(`sstv.tracking.${key}`) || 'null') ?? this.memory.get(key); }
    catch (_) { return this.memory.get(key); }
  }
  async set(key, value) {
    this.memory.set(key, value);
    this.unpersisted.add(key);
    const db = await this.open();
    if (db) {
      try {
        await new Promise((resolve, reject) => { const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(value, key); tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
        this.unpersisted.delete(key);
        return;
      } catch (_) { this.persistent = false; }
    }
    try { this.fallback?.setItem(`sstv.tracking.${key}`, JSON.stringify(value)); } catch (_) { /* Session memory remains available. */ }
  }
  async claimRequest(now, key = 'lastRequest') {
    const db = await this.open();
    if (db) {
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state');
          let allowed = false;
          const r = store.get(key);
          r.onsuccess = () => { allowed = !Number.isFinite(r.result) || now - r.result >= REFRESH_INTERVAL; if (allowed) store.put(now, key); };
          tx.oncomplete = () => resolve(allowed); tx.onabort = tx.onerror = () => reject(tx.error);
        });
      } catch (_) { this.persistent = false; }
    }
    const claim = this.claims.then(async () => {
      const last = await this.get(key);
      if (Number.isFinite(last) && now - last < REFRESH_INTERVAL) return false;
      await this.set(key, now);
      return true;
    });
    this.claims = claim.catch(() => {});
    return claim;
  }
}

export class CachedFeed {
  constructor(store, parse, fetcher = defaultFetch, feed, { timeoutMs = 30000 } = {}) {
    this.store = store; this.parse = parse; this.fetcher = fetcher; this.pending = null;
    this.feed = feed; this.timeoutMs = timeoutMs;
  }
  refresh(now = Date.now()) {
    if (this.pending) return this.pending;
    this.pending = this.performRefresh(now).finally(() => { this.pending = null; });
    return this.pending;
  }
  async performRefresh(now) {
    const { url, cacheKey, requestKey, maxBytes = 8 * 1024 * 1024 } = this.feed;
    if (!await this.store.claimRequest(now, requestKey)) return { limited: true,
      value: await this.store.get(cacheKey), error: await this.store.get(`${requestKey}:error`) || undefined };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit' });
      if (response.status !== 200) throw new Error(`数据服务返回 HTTP ${response.status}`);
      if (Number(response.headers?.get('content-length')) > maxBytes) throw new Error('数据文件过大');
      const text = await response.text();
      if (text.length > maxBytes || new Blob([text]).size > maxBytes) throw new Error('数据文件过大');
      const value = this.parse(text, now);
      await this.store.set(cacheKey, value);
      await this.store.set(`${requestKey}:error`, null);
      return { value };
    } catch (error) {
      const message = error.name === 'AbortError' ? '数据请求超时' : error.message;
      await this.store.set(`${requestKey}:error`, message);
      return { value: await this.store.get(cacheKey), error: message };
    } finally { clearTimeout(timeout); }
  }
}

export class EphemerisSource extends CachedFeed {
  constructor(store, parse, fetcher = defaultFetch, options) {
    const previous = sharedOrbits.get(store);
    if (previous && previous.parseElements === parse && previous.fetcher === fetcher && previous.timeoutMs === (options?.timeoutMs ?? 30000)) return previous;
    super(store, (text, now) => {
      // Preserve the historical automatic-source IDs so selections and favorites survive the change of host.
      const records = parse(text, 'celestrak', now, { maxBytes: 8 * 1024 * 1024, maxRecords: 30000 });
      if (!records.some(item => item.catalogId === '25544')) throw new Error('返回数据中没有 ISS');
      return records.map(record => ({ ...record, sourceUrl: TLE_URL }));
    }, fetcher, { url: TLE_URL, cacheKey: 'tledata:orbits:v1', requestKey: ORBIT_REQUEST_KEY }, options);
    this.parseElements = parse;
    sharedOrbits.set(store, this);
  }
  async performRefresh(now) {
    const result = await super.performRefresh(now);
    const record = result.value?.find(item => item.catalogId === '25544');
    const records = result.value?.filter(item => item.catalogId !== '25544');
    if (!result.limited && !result.error) {
      await this.store.set('iss', record);
      await this.store.set('amateur', records);
    }
    return { record: record || await this.store.get('iss'), records: records || await this.store.get('amateur'),
      limited: result.limited, error: result.error };
  }
}

// Both views share the same download, cache, timeout and request interval.
export class CatalogSource extends EphemerisSource {}
