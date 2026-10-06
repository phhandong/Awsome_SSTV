export const REFRESH_INTERVAL = 2 * 60 * 60 * 1000;
export const ISS_URL = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=JSON';

// All persistent writes are best-effort. A failed store never disables the receiver.
export class TrackingStore {
  constructor(indexedDB = globalThis.indexedDB, fallback) {
    if (fallback === undefined) { try { fallback = globalThis.localStorage; } catch (_) { fallback = null; } }
    this.indexedDB = indexedDB; this.fallback = fallback; this.memory = new Map(); this.persistent = true;
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
    const db = await this.open();
    if (db) {
      try { return await new Promise((resolve, reject) => { const r = db.transaction('state').objectStore('state').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
      catch (_) { this.persistent = false; }
    }
    try { return JSON.parse(this.fallback?.getItem(`sstv.tracking.${key}`) || 'null') ?? this.memory.get(key); }
    catch (_) { return this.memory.get(key); }
  }
  async set(key, value) {
    this.memory.set(key, value);
    const db = await this.open();
    if (db) {
      try {
        await new Promise((resolve, reject) => { const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(value, key); tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
        return;
      } catch (_) { this.persistent = false; }
    }
    try { this.fallback?.setItem(`sstv.tracking.${key}`, JSON.stringify(value)); } catch (_) { /* Session memory remains available. */ }
  }
  async claimRequest(now) {
    const db = await this.open();
    if (db) {
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state');
          let allowed = false;
          const r = store.get('lastRequest');
          r.onsuccess = () => { allowed = !Number.isFinite(r.result) || now - r.result >= REFRESH_INTERVAL; if (allowed) store.put(now, 'lastRequest'); };
          tx.oncomplete = () => resolve(allowed); tx.onabort = tx.onerror = () => reject(tx.error);
        });
      } catch (_) { this.persistent = false; }
    }
    const last = await this.get('lastRequest');
    if (Number.isFinite(last) && now - last < REFRESH_INTERVAL) return false;
    await this.set('lastRequest', now);
    return true;
  }
}

export class EphemerisSource {
  constructor(store, parse, fetcher = globalThis.fetch?.bind(globalThis)) {
    this.store = store; this.parse = parse; this.fetcher = fetcher; this.pending = null;
  }
  refresh(now = Date.now()) {
    if (this.pending) return this.pending;
    this.pending = this.performRefresh(now).finally(() => { this.pending = null; });
    return this.pending;
  }
  async performRefresh(now) {
    if (!await this.store.claimRequest(now)) return { limited: true, record: await this.store.get('iss') };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetcher(ISS_URL, { signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit' });
      if (response.status !== 200) throw new Error(`星历服务返回 HTTP ${response.status}`);
      const text = await response.text();
      const records = this.parse(text, 'celestrak', now);
      const record = records.find(item => item.catalogId === '25544');
      if (!record) throw new Error('返回数据中没有 ISS');
      await this.store.set('iss', record);
      return { record };
    } catch (error) {
      return { record: await this.store.get('iss'), error: error.name === 'AbortError' ? '星历请求超时' : error.message };
    } finally { clearTimeout(timeout); }
  }
}
