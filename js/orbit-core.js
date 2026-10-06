import { twoline2satrec, json2satrec, propagate, gstime, eciToEcf, ecfToLookAngles } from './vendor/satellite.es.js';

export const DAY = 86400000;
export const DEG = Math.PI / 180;
export const normalizeDegrees = degrees => ((degrees % 360) + 360) % 360;

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
export function validateObserver(observer) {
  if (!observer || !finite(observer.latitude) || Math.abs(observer.latitude) > 90 ||
      !finite(observer.longitude) || Math.abs(observer.longitude) > 180 ||
      !finite(observer.altitude) || observer.altitude < -1000 || observer.altitude > 100000) {
    throw new Error('观测位置无效：纬度 ±90°，经度 ±180°，海拔 −1000～100000 米');
  }
  return observer;
}

export function recordToSatrec(record) {
  const sat = record.format === 'tle'
    ? twoline2satrec(record.elements[0], record.elements[1]) : json2satrec(record.elements);
  if (sat.error || !finite(sat.no) || sat.no <= 0 || !finite(sat.ecco) || sat.ecco < 0 || sat.ecco >= 1 ||
      !finite(sat.jdsatepoch)) throw new Error('轨道参数无法用于 SGP4 计算');
  const result = propagate(sat, new Date((sat.jdsatepoch - 2440587.5) * DAY));
  if (!result?.position || !finite(result.position.x)) throw new Error('轨道传播失败，卫星可能已衰减');
  return sat;
}

function checksum(line) {
  let sum = 0;
  for (const char of line.slice(0, 68)) sum += /\d/.test(char) ? Number(char) : char === '-' ? 1 : 0;
  return sum % 10 === Number(line[68]);
}

export function parseElements(text, source = 'import', fetchedAt = Date.now()) {
  if (typeof text !== 'string' || !text.trim() || text.length > 1024 * 1024) throw new Error('请选择小于 1 MB 的 TLE 或 OMM JSON 文件');
  const records = [];
  const add = (record) => {
    const sat = recordToSatrec(record);
    const catalogId = String(sat.satnum);
    records.push({ ...record, catalogId, epoch: (sat.jdsatepoch - 2440587.5) * DAY,
      id: `${source}:${catalogId}`, source, fetchedAt, name: String(record.name || catalogId).slice(0, 120) });
  };
  if (/^[\[{]/.test(text.trim())) {
    let values;
    try { values = JSON.parse(text); } catch (_) { throw new Error('OMM JSON 格式错误'); }
    if (!Array.isArray(values)) values = [values];
    if (!values.length || values.length > 500) throw new Error('一次最多导入 500 颗卫星');
    for (const input of values) {
      if (!input || typeof input !== 'object') throw new Error('OMM 记录无效');
      const epoch = String(input.EPOCH || '');
      const utcEpoch = /(?:Z|[+-]\d\d:\d\d)$/.test(epoch) ? epoch : `${epoch}Z`;
      if (!/^\d{4}-\d{2}-\d{2}T/.test(epoch) || !Number.isFinite(Date.parse(utcEpoch))) throw new Error('OMM 缺少有效 UTC 历元');
      for (const [key, expected] of Object.entries({ CENTER_NAME: 'EARTH', REF_FRAME: 'TEME', TIME_SYSTEM: 'UTC', MEAN_ELEMENT_THEORY: 'SGP4' })) {
        if (input[key] != null && String(input[key]).toUpperCase() !== expected) throw new Error(`不支持的 OMM ${key}`);
      }
      const fields = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
      const elements = { EPOCH: new Date(utcEpoch).toISOString(), NORAD_CAT_ID: String(input.NORAD_CAT_ID || '') };
      if (!/^\d{1,9}$/.test(elements.NORAD_CAT_ID)) throw new Error('OMM 缺少有效卫星编号');
      for (const key of fields) {
        if (input[key] == null || String(input[key]).trim() === '' || !Number.isFinite(Number(input[key]))) throw new Error(`OMM 缺少有效 ${key}`);
        elements[key] = Number(input[key]);
      }
      if (elements.MEAN_MOTION <= 0 || elements.MEAN_MOTION > 20 || elements.ECCENTRICITY < 0 || elements.ECCENTRICITY >= 1 ||
          elements.INCLINATION < 0 || elements.INCLINATION > 180 ||
          ['RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY'].some(key => elements[key] < 0 || elements[key] >= 360)) throw new Error('OMM 轨道参数超出有效范围');
      add({ format: 'omm', elements, name: input.OBJECT_NAME });
    }
  } else {
    const lines = text.trim().split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
    for (let i = 0; i < lines.length;) {
      const name = lines[i].startsWith('1 ') ? '' : lines[i++].replace(/^0 /, '');
      const one = lines[i++], two = lines[i++];
      if (!one?.startsWith('1 ') || !two?.startsWith('2 ') || one.length !== 69 || two.length !== 69 ||
          one.slice(2, 7) !== two.slice(2, 7) || !checksum(one) || !checksum(two)) throw new Error('TLE 行格式、编号或校验和错误');
      add({ format: 'tle', elements: [one, two], name });
      if (records.length > 500) throw new Error('一次最多导入 500 颗卫星');
    }
  }
  if (!records.length) throw new Error('没有可用轨道记录');
  return [...new Map(records.map(record => [record.id, record])).values()];
}

export function lookAt(sat, observer, time) {
  const date = new Date(time);
  const result = propagate(sat, date);
  if (sat.error || !result?.position || !finite(result.position.x)) throw new Error('轨道传播失败，请更新星历或更换目标');
  const look = ecfToLookAngles({ latitude: observer.latitude * DEG, longitude: observer.longitude * DEG, height: observer.altitude / 1000 }, eciToEcf(result.position, gstime(date)));
  if (![look.azimuth, look.elevation, look.rangeSat].every(finite)) throw new Error('卫星坐标无效');
  return { time, azimuth: normalizeDegrees(look.azimuth / DEG), elevation: look.elevation / DEG, distance: look.rangeSat };
}

// Bracket horizon crossings, then bisect to <0.25s. Work is confined to an orbit Worker.
export function predictPasses(sat, observer, start, duration = DAY) {
  const end = start + duration;
  const point = time => lookAt(sat, observer, time);
  const crossing = (a, b) => {
    const above = point(a).elevation >= 0;
    while (b - a > 250) { const m = (a + b) / 2; if ((point(m).elevation >= 0) === above) a = m; else b = m; }
    return (a + b) / 2;
  };
  const passes = [];
  let previous = point(start), rise = previous.elevation >= 0 ? start : null;
  const finish = (set, ongoingEnd) => {
    // First locate the highest sample, then refine its local maximum.
    let best = rise;
    for (let t = rise; t <= set; t += 10000) if (point(t).elevation > point(best).elevation) best = t;
    let a = Math.max(rise, best - 10000), b = Math.min(set, best + 10000);
    for (let i = 0; i < 20; i++) {
      const l = a + (b - a) / 3, r = b - (b - a) / 3;
      if (point(l).elevation < point(r).elevation) a = l; else b = r;
    }
    const peak = point((a + b) / 2);
    const track = [];
    for (let i = 0; i <= 90; i++) track.push(point(rise + (set - rise) * i / 90));
    passes.push({ rise, set, peak: peak.time, maxElevation: peak.elevation, ongoingStart: rise === start, ongoingEnd, track });
  };
  for (let t = Math.min(start + 10000, end); t <= end; t = Math.min(t + 10000, end)) {
    const current = point(t);
    if (previous.elevation < 0 && current.elevation >= 0) rise = crossing(previous.time, t);
    if (rise != null && previous.elevation >= 0 && current.elevation < 0) { finish(crossing(previous.time, t), false); rise = null; }
    previous = current;
    if (t === end) break;
  }
  if (rise != null) finish(end, true);
  return { from: start, until: end, passes };
}
