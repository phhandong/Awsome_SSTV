export const REFRESH_INTERVAL = 2 * 60 * 60 * 1000;
export const ISS_URL = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=JSON';
export const AMATEUR_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=JSON';

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

class EphemerisFeed {
  constructor(store, parse, fetcher, feed, { timeoutMs = 15000 } = {}) {
    this.store = store; this.parse = parse; this.fetcher = fetcher; this.pending = null;
    this.feed = feed; this.timeoutMs = timeoutMs;
  }
  refresh(now = Date.now()) {
    if (this.pending) return this.pending;
    this.pending = this.performRefresh(now).finally(() => { this.pending = null; });
    return this.pending;
  }
  async performRefresh(now) {
    const { url, cacheKey, requestKey, resultKey, select } = this.feed;
    if (!await this.store.claimRequest(now, requestKey)) return { limited: true,
      [resultKey]: await this.store.get(cacheKey), error: await this.store.get(`${requestKey}:error`) || undefined };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit' });
      if (response.status !== 200) throw new Error(`星历服务返回 HTTP ${response.status}`);
      const text = await response.text();
      if (!/^[\[{]/.test(text.trim())) throw new Error('星历服务未返回 OMM JSON');
      const records = this.parse(text, 'celestrak', now);
      const value = select(records);
      await this.store.set(cacheKey, value);
      await this.store.set(`${requestKey}:error`, null);
      return { [resultKey]: value };
    } catch (error) {
      const message = error.name === 'AbortError' ? '星历请求超时' : error.message;
      await this.store.set(`${requestKey}:error`, message);
      return { [resultKey]: await this.store.get(cacheKey), error: message };
    } finally { clearTimeout(timeout); }
  }
}

export class EphemerisSource extends EphemerisFeed {
  constructor(store, parse, fetcher = globalThis.fetch?.bind(globalThis), options) {
    super(store, parse, fetcher, { url: ISS_URL, cacheKey: 'iss', requestKey: 'lastRequest', resultKey: 'record',
      select(records) {
        const record = records.find(item => item.catalogId === '25544');
        if (!record) throw new Error('返回数据中没有 ISS');
        return record;
      } }, options);
  }
}

export class CatalogSource extends EphemerisFeed {
  constructor(store, parse, fetcher = globalThis.fetch?.bind(globalThis), options) {
    super(store, parse, fetcher, { url: AMATEUR_URL, cacheKey: 'amateur', requestKey: 'lastRequest:amateur', resultKey: 'records',
      select(records) {
        const catalog = records.filter(item => item.catalogId !== '25544');
        if (!catalog.length) throw new Error('目录中没有可用的业余无线电卫星');
        return catalog;
      } }, options);
  }
}
