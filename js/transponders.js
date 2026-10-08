import { normalizeCatalogId } from './orbit-core.js';
import { CachedFeed, TRANSPONDER_URL } from './tracking-store.js';

export function toneFromTransponder(row) {
  const description = String(row.description || '');
  if (/\bno\s+CTCSS\b|\bwithout\s+CTCSS\b|无需亚音/i.test(description)) return '无需';
  const explicit = row.ctcss_hz ?? row.ctcss ?? row.uplink_ctcss ?? row.params?.ctcss;
  const matches = explicit == null ? [...description.matchAll(/(?:\bCTCSS\b|\bPL\b|亚音)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:Hz)?|(\d+(?:\.\d+)?)\s*(?:Hz\s*)?\bPL\b/gi)] : [];
  const tones = explicit == null ? matches.map(match => Number(match[1] || match[2])) : [Number(explicit)];
  const valid = [...new Set(tones.filter(tone => Number.isFinite(tone) && tone >= 50 && tone <= 300))];
  return valid.length ? valid.map(tone => `${tone.toFixed(1)} Hz`).join(' / ') : '未提供';
}

export function parseTransponders(text) {
  let rows;
  try { rows = JSON.parse(text); } catch (_) { throw new Error('转发器 JSON 格式错误'); }
  if (!Array.isArray(rows) || !rows.length || rows.length > 20000) throw new Error('转发器数据必须是非空数组，最多 20000 条');
  const profiles = new Map();
  const frequency = value => Number.isSafeInteger(value) && value > 0 && value <= 1e12;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !row.uuid || !row.type) throw new Error('转发器记录无效');
    // SatNOGS also carries records with no catalog ID or no receiving frequency.
    if (row.norad_cat_id == null || row.downlink_low == null) continue;
    const catalogId = normalizeCatalogId(row.norad_follow_id ?? row.norad_cat_id);
    const lowHz = row.downlink_low, highHz = row.downlink_high ?? lowHz;
    const uplinkLowHz = row.uplink_low, uplinkHighHz = row.uplink_high ?? uplinkLowHz;
    if (!frequency(lowHz) || !frequency(highHz) || highHz < lowHz ||
        (uplinkLowHz != null && (!frequency(uplinkLowHz) || !frequency(uplinkHighHz) || uplinkHighHz < uplinkLowHz))) {
      throw new Error('转发器频率或频段无效');
    }
    const mode = String(row.mode || '').slice(0, 20);
    const isRepeater = uplinkLowHz != null && (/^FM/i.test(mode) || /repeater|中继/i.test(row.description || ''));
    const id = `remote-${String(row.uuid).slice(0, 100)}`;
    profiles.set(`${catalogId}:${id}`, { id, catalogId, name: String(row.description || row.type).slice(0, 120),
      mode, lowHz, highHz, uplinkLowHz, uplinkHighHz, uplinkMode: String(row.uplink_mode || mode).slice(0, 20),
      isRepeater, tone: isRepeater ? toneFromTransponder(row) : null, invert: row.invert === true,
      inactive: row.alive === false || row.status === 'inactive', unconfirmed: row.unconfirmed === true,
      type: String(row.type).slice(0, 30), source: TRANSPONDER_URL, sourceLabel: 'TLEData 转发器',
      checkedAt: String(row.updated || '').slice(0, 10), builtin: true });
  }
  if (!profiles.size) throw new Error('没有可用的转发器下行频率');
  return [...profiles.values()];
}

export class TransponderSource extends CachedFeed {
  constructor(store, fetcher, options) {
    super(store, parseTransponders, fetcher, { url: TRANSPONDER_URL,
      cacheKey: 'transponders:v1', requestKey: 'lastRequest:transponders' }, options);
  }
}
