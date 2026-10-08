export const ISS_PROFILES = [
  { id: 'iss-sstv-uhf', name: 'SSTV UHF', mode: 'FM', lowHz: 437550000, highHz: 437550000, note: 'SSTV 活动频率，以活动公告为准', source: 'https://www.ariss.org/contact-the-iss.html' },
  { id: 'iss-sstv-vhf', name: 'SSTV VHF', mode: 'FM', lowHz: 145800000, highHz: 145800000, note: '历史常用 SSTV 频率，以活动公告为准', source: 'https://www.ariss.org/?linkId=130232132' },
  { id: 'iss-repeater', name: 'FM 转发器下行', mode: 'FM', lowHz: 437800000, highHz: 437800000, uplinkLowHz: 145990000, uplinkHighHz: 145990000, uplinkMode: 'FM', isRepeater: true, tone: '67.0 Hz', note: '转发器下行频率，不代表正在工作', source: 'https://www.ariss.org/current-status-of-iss-stations.html' },
].map(profile => Object.freeze({ ...profile, checkedAt: '2026-10-07', builtin: true }));

export function mhzToHz(value) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(String(value).trim())) throw new Error('频率请输入正数 MHz，最多六位小数');
  const hz = Math.round(Number(value) * 1e6);
  if (!Number.isSafeInteger(hz) || hz <= 0) throw new Error('频率必须大于零且在有效范围内');
  return hz;
}
export const formatMHz = hz => (hz / 1e6).toFixed(6);
export function validateProfile(profile) {
  if (!profile || !String(profile.name || '').trim() || String(profile.name).length > 60) throw new Error('请输入 1～60 字的频率名称');
  if (String(profile.mode || '').length > 20) throw new Error('模式标签最多 20 字');
  if (![profile.lowHz, profile.highHz].every(value => Number.isSafeInteger(value) && value > 0) || profile.lowHz > profile.highHz) throw new Error('频段上下限无效');
  return { id: profile.id, name: String(profile.name).trim(), mode: String(profile.mode || '').trim(), lowHz: profile.lowHz, highHz: profile.highHz };
}
export function receivedFrequency(nominalHz, position, now = Date.now()) {
  if (!Number.isFinite(nominalHz) || nominalHz <= 0 || !position || now - position.time > 4000 || now < position.time ||
      !Number.isFinite(position.dopplerFactor) || position.dopplerFactor <= 0) return null;
  const receivedHz = nominalHz * position.dopplerFactor;
  return { receivedHz, shiftHz: receivedHz - nominalHz };
}

// Catalog numbers, not orbit-source IDs, own the user's frequency choices.
export class RadioProfiles {
  constructor(store) { this.store = store; this.entries = {}; this.remote = new Map(); }
  setRemote(profiles = []) {
    this.remote.clear();
    for (const profile of profiles) {
      if (!profile || !/^\d{1,9}$/.test(profile.catalogId) || !profile.id?.startsWith('remote-') || !profile.builtin) continue;
      const items = this.remote.get(profile.catalogId) || [];
      items.push(profile); this.remote.set(profile.catalogId, items);
    }
    for (const items of this.remote.values()) items.sort((a, b) => Number(a.inactive) - Number(b.inactive));
  }
  async load() {
    const remote = await this.store.get('transponders:v1');
    this.setRemote(Array.isArray(remote) ? remote : []);
    const data = await this.store.get('radioProfiles.v1');
    if (data && typeof data === 'object') for (const [catalog, entry] of Object.entries(data)) {
      if (!/^\d{1,9}$/.test(catalog) || !entry || typeof entry !== 'object') continue;
      const profiles = [];
      for (const profile of Array.isArray(entry.profiles) ? entry.profiles : []) {
        try { if (typeof profile.id === 'string' && profile.id.startsWith('custom-') && !profiles.some(p => p.id === profile.id)) profiles.push(validateProfile(profile)); } catch (_) { /* Skip damaged records. */ }
      }
      this.entries[catalog] = { profiles, selectedId: entry.selectedId, tunedHz: entry.tunedHz };
    }
  }
  entry(catalog) {
    if (!/^\d{1,9}$/.test(String(catalog))) throw new Error('请先选择卫星');
    return this.entries[catalog] ||= { profiles: [] };
  }
  list(catalog) { return [...(String(catalog) === '25544' ? ISS_PROFILES : []), ...(this.remote.get(String(catalog)) || []), ...this.entry(catalog).profiles]; }
  current(catalog) {
    const entry = this.entry(catalog), list = this.list(catalog);
    const profile = list.find(p => p.id === entry.selectedId) || list[0];
    if (!profile) return null;
    const tunedHz = entry.selectedId === profile.id && Number.isSafeInteger(entry.tunedHz) && entry.tunedHz >= profile.lowHz && entry.tunedHz <= profile.highHz
      ? entry.tunedHz : Math.round((profile.lowHz + profile.highHz) / 2);
    return { profile, tunedHz };
  }
  async select(catalog, id, tunedHz) {
    const profile = this.list(catalog).find(p => p.id === id);
    if (!profile) throw new Error('请选择有效频率');
    tunedHz ??= Math.round((profile.lowHz + profile.highHz) / 2);
    if (!Number.isSafeInteger(tunedHz) || tunedHz < profile.lowHz || tunedHz > profile.highHz) throw new Error('目标频率必须位于所选频段内');
    Object.assign(this.entry(catalog), { selectedId: id, tunedHz });
    await this.store.set('radioProfiles.v1', this.entries);
  }
  async save(catalog, input) {
    const profile = validateProfile(input), entry = this.entry(catalog);
    if (!profile.id) profile.id = `custom-${globalThis.crypto.randomUUID()}`;
    if (!profile.id.startsWith('custom-')) throw new Error('内置预设不能修改，请新增自定义频率');
    entry.profiles = entry.profiles.filter(p => p.id !== profile.id).concat(profile);
    await this.select(catalog, profile.id);
  }
  async remove(catalog, id) {
    const entry = this.entry(catalog);
    if (!entry.profiles.some(p => p.id === id)) throw new Error('只能删除自定义频率');
    entry.profiles = entry.profiles.filter(p => p.id !== id);
    if (entry.selectedId === id) { delete entry.selectedId; delete entry.tunedHz; }
    await this.store.set('radioProfiles.v1', this.entries);
  }
}
