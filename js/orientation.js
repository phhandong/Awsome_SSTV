import wmm from './vendor/wmm2025.js';
const D = Math.PI / 180;
export const wrap = degrees => ((degrees % 360) + 360) % 360;
export const angleDelta = (a, b) => ((a - b + 540) % 360) - 180;
const clamp = x => Math.max(-1, Math.min(1, x));
const GUIDE_KEY = 'sstv.orientationGuideComplete.v1';
export const ORIENTATION_REUSE_MS = 2 * 60 * 1000;

export function declinationAt(observer, time = Date.now()) {
  const date = new Date(time);
  if (date < new Date('2025-01-01T00:00:00Z') || date >= new Date('2030-01-01T00:00:00Z')) throw new Error('WMM2025 已超出有效期，请更新应用');
  // The dependency labels model publication dates as validity dates. Use the
  // official epoch interval, and a proper leap-year fraction for coefficients.
  const year = date.getUTCFullYear();
  const fractionalYear = year + (time - Date.UTC(year, 0, 1)) / (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1));
  const model = Object.create(wmm);
  model.main_field_coeff_g = wmm.main_field_coeff_g.map((v, i) => v + (fractionalYear - 2025) * (wmm.secular_var_coeff_g[i] || 0));
  model.main_field_coeff_h = wmm.main_field_coeff_h.map((v, i) => v + (fractionalYear - 2025) * (wmm.secular_var_coeff_h[i] || 0));
  const field = model.point([observer.latitude, observer.longitude, observer.altitude / 1000]);
  if (!Number.isFinite(field.decl) || field.h < 2000) throw new Error('此位置的磁场水平分量过弱，无法可靠定向');
  return field.decl;
}

// W3C intrinsic Z-X'-Y'' rotation. Physical +Y is the phone's TOP, regardless
// of screen orientation. gamma rotates about +Y, so it does not change this ray.
export function topVector(alpha, beta, yawOffset = 0) {
  const a = alpha * D, b = beta * D, o = yawOffset * D;
  const x = -Math.sin(a) * Math.cos(b), y = Math.cos(a) * Math.cos(b), z = Math.sin(b);
  // Positive heading/yawOffset is clockwise in the ENU horizontal plane.
  return [x * Math.cos(o) + y * Math.sin(o), -x * Math.sin(o) + y * Math.cos(o), z];
}
export function vectorAngles([east, north, up]) {
  return { azimuth: wrap(Math.atan2(east, north) / D), elevation: Math.asin(clamp(up)) / D };
}
export function smoothVector(previous, next, weight) {
  if (!previous) return next;
  const mixed = next.map((v, i) => previous[i] * (1 - weight) + v * weight);
  const length = Math.hypot(...mixed);
  return length < 0.01 ? next : mixed.map(v => v / length);
}
export function pointingGuide(pose, target, now = Date.now()) {
  if (!target) return { text: '等待卫星位置', angle: null };
  if (target.elevation < 0) return { text: '目标在地平线下 · 等待过境', angle: null };
  if (!pose?.valid || now - pose.time > 2000) return { text: '启用姿态，等待方向就绪后用手机顶部指向卫星', angle: null };
  const a = target.azimuth * D, e = target.elevation * D;
  const vector = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
  const angle = Math.acos(clamp(vector.reduce((sum, v, i) => sum + v * pose.vector[i], 0))) / D;
  if (pose.accuracy > 20) return { text: '指南针精度不足 · 等待读数稳定', angle: null };
  if (angle < 5) return { text: '已接近目标方向', angle };
  const delta = angleDelta(target.azimuth, pose.azimuth), lift = target.elevation - pose.elevation;
  const parts = [];
  if (target.elevation < 80 && pose.elevation < 80 && Math.abs(delta) > 3) parts.push(`${delta > 0 ? '向右 →' : '← 向左'} ${Math.abs(delta).toFixed(0)}°`);
  if (Math.abs(lift) > 3) parts.push(`${lift > 0 ? '抬高 ↑' : '降低 ↓'} ${Math.abs(lift).toFixed(0)}°`);
  return { text: parts.join(' · ') || '接近天顶 · 按夹角缓慢调整', angle };
}

const CALIBRATION_MS = 2000;
const BAD_READING_GRACE_MS = 1500;
const RECOVERY_MS = 500;
const isFlat = s => Math.abs(s.beta) <= 12 && Math.abs(s.gamma) <= 12;

// These fields describe availability / estimated error, not magnetic interference.
function compassIssue({ heading, accuracy }) {
  if (!Number.isFinite(heading) || heading < 0 || !Number.isFinite(accuracy))
    return { state: 'waiting', title: '等待罗盘数据', message: '浏览器尚未提供有效读数，请稍候' };
  if (accuracy < 0)
    return { state: 'waiting', title: '系统罗盘尚未就绪', message: '可缓慢转动手机，再屏幕朝上平放' };
  if (accuracy > 20)
    return { state: 'accuracy', title: '方向精度不足', message: '暂不显示指向，读数稳定后自动恢复' };
  return null;
}

export class PhoneOrientation {
  constructor(onChange) {
    this.onChange = onChange; this.enabled = false; this.offset = null; this.declination = null;
    this.pose = null; this.lastRender = 0; this.sample = null; this.lastSampleTime = null; this.enabledAt = null;
    this.listening = false; this.referenceTime = null; this.checkResumedReference = false;
    this.badSince = null; this.goodSince = null;
    this.guideComplete = false; this.calibrationSamples = [];
    try { this.guideComplete = globalThis.localStorage?.getItem(GUIDE_KEY) === '1'; } catch (_) { /* Storage is optional. */ }
    this.handle = event => this.consume(event);
  }
  setObserver(observer) {
    try { this.declination = declinationAt(observer); this.invalidate('位置已更新，请屏幕朝上平放约 2 秒'); }
    catch (error) { this.declination = null; this.invalidate(error.message, '需要有效观测位置', 'waiting'); }
  }
  invalidate(message, title = '重新对齐方向', state = 'flat') {
    this.offset = null; this.pose = null; this.calibrationSamples = []; this.lastRender = 0;
    this.referenceTime = null; this.checkResumedReference = false;
    this.badSince = null; this.goodSince = null;
    this.pending(message, state, title);
  }
  pending(message, state = 'waiting', title = '等待方向数据', progress = null) {
    this.pose = null; this.lastRender = 0;
    const key = JSON.stringify([message, state, title, progress]);
    if (this.pendingKey === key) return;
    this.pendingKey = key; this.pendingMessage = message;
    this.onChange({ valid: false, message, state, title, progress });
  }
  rememberGuide() {
    this.guideComplete = true;
    // Persist onboarding only: an offset belongs to this sensor session.
    try { globalThis.localStorage?.setItem(GUIDE_KEY, '1'); } catch (_) { /* Continue in memory. */ }
  }
  async enable() {
    if (this.enabled) { this.resume(); return; }
    if (!window.isSecureContext) throw new Error('姿态功能需要 HTTPS');
    const api = window.DeviceOrientationEvent;
    if (!api) throw new Error('当前设备不支持姿态传感器');
    // Keep permission within the initiating user gesture, including iOS Chrome.
    if (typeof api.requestPermission === 'function' && await api.requestPermission() !== 'granted') throw new Error('运动权限未允许，请在浏览器设置中检查权限后重试');
    this.enabled = true; this.enabledAt = Date.now();
    this.resume();
    this.invalidate('屏幕朝上，保持平放约 2 秒', this.guideComplete ? '准备对齐方向' : '首次使用 · 对齐方向');
  }
  calibrate() {
    if (!this.enabled) throw new Error('请先开启指向');
    if (!this.sample || Date.now() - this.sample.time > 2000) throw new Error('尚未收到姿态数据，请检查运动权限');
    if (this.declination == null) throw new Error('请先设置有效观测位置');
    // A manual retry uses the same quality and stability gate as auto alignment.
    // One sample cannot certify a heading, nor calibrate the phone magnetometer.
    this.invalidate('屏幕朝上，保持平放约 2 秒');
  }
  autoCalibrate(sample) {
    const { time, alpha, beta, heading } = sample;
    if (!isFlat(sample)) {
      this.calibrationSamples = [];
      this.pending('屏幕朝上，保持平放约 2 秒', 'flat', this.checkResumedReference ? '请平放核验方向' : '请将手机平放');
      return false;
    }
    const offset = angleDelta(heading + this.declination, vectorAngles(topVector(alpha, beta)).azimuth);
    const samples = this.calibrationSamples, first = samples[0], last = samples.at(-1);
    if (last && (time < last.time || time - last.time > 500 || Math.abs(angleDelta(offset, first.offset)) > 5 || Math.abs(angleDelta(heading, first.heading)) > 5)) samples.length = 0;
    samples.push({ offset, heading, time });
    const elapsed = time - samples[0].time;
    this.pending('保持平放约 2 秒，完成后即可抬起', 'calibrating', '正在对齐方向', Math.min(100, Math.floor(elapsed / CALIBRATION_MS * 10) * 10));
    if (elapsed < CALIBRATION_MS || samples.length < 10) return false;
    this.offset = Math.atan2(samples.reduce((sum, s) => sum + Math.sin(s.offset * D), 0), samples.reduce((sum, s) => sum + Math.cos(s.offset * D), 0)) / D;
    this.referenceTime = time; this.checkResumedReference = false;
    this.calibrationSamples = []; this.badSince = null; this.goodSince = null;
    this.rememberGuide();
    return true;
  }
  suspendForReading(message, state, title, now) {
    this.calibrationSamples = []; this.goodSince = null;
    this.badSince ??= now;
    // Brief faults hide the pointer but retain its reference. Sustained faults
    // require a fresh flat check before any direction is displayed again.
    if (this.offset != null && now - this.badSince >= BAD_READING_GRACE_MS) this.checkResumedReference = true;
    this.pending(message, state, title);
  }
  consume(event) {
    if (!this.enabled) return;
    const now = Date.now(), previousTime = this.lastSampleTime;
    this.lastSampleTime = now;
    // A fresh event must replace the UI's stale-data notice even when the
    // sensor's pending state text is unchanged (e.g. flat check after resume).
    if (previousTime != null && (now < previousTime || now - previousTime > 2000)) this.pendingKey = null;
    if (this.offset != null && previousTime != null) {
      const gap = now - previousTime;
      if (gap < 0 || gap > ORIENTATION_REUSE_MS) this.invalidate('方向参考已过期，请平放约 2 秒');
      else if (gap > 2000) { this.checkResumedReference = true; this.calibrationSamples = []; }
    }
    const alpha = event.alpha, beta = event.beta, gamma = event.gamma;
    if (![alpha, beta, gamma].every(value => typeof value === 'number' && Number.isFinite(value))) {
      this.sample = null;
      this.suspendForReading('姿态数据暂不可用，恢复后自动重试', 'waiting', '等待姿态数据', now);
      return;
    }
    const heading = event.webkitCompassHeading ?? event.heading;
    const accuracy = event.webkitCompassAccuracy ?? event.accuracy;
    this.sample = { alpha, beta, gamma, heading, accuracy, time: now };
    if (this.declination == null) { this.pending('设置观测位置后即可对齐方向', 'waiting', '需要观测位置'); return; }
    const issue = compassIssue(this.sample);
    if (issue) { this.suspendForReading(issue.message, issue.state, issue.title, now); return; }
    if (this.badSince != null) {
      if (now - this.badSince >= BAD_READING_GRACE_MS && this.goodSince == null) this.checkResumedReference = this.offset != null;
      this.goodSince ??= now;
      if (this.offset != null && !this.checkResumedReference && now - this.goodSince < RECOVERY_MS) {
        this.pending('正在确认读数稳定，无需重新校准', 'waiting', '读数恢复中'); return;
      }
      this.badSince = null; this.goodSince = null;
    }
    const initializing = this.offset == null || this.checkResumedReference;
    if (initializing && !this.autoCalibrate(this.sample)) return;
    if (now - this.lastRender < 1000 / 30) return;
    const weight = 1 - Math.exp(-(now - this.lastRender) / 90);
    // Correct only a flat heading. Never refresh the reference age using a
    // tilted compass accuracy value: it cannot validate the relative frame.
    if (!initializing && isFlat(this.sample)) {
      const desired = angleDelta(heading + this.declination, vectorAngles(topVector(alpha, beta)).azimuth);
      if (Math.abs(angleDelta(desired, this.offset)) > 15) {
        this.checkResumedReference = true; this.calibrationSamples = [];
        this.autoCalibrate(this.sample); return;
      }
      this.offset = angleDelta(this.offset + angleDelta(desired, this.offset) * weight, 0);
      this.referenceTime = now;
    }
    const vector = smoothVector(this.pose?.vector, topVector(alpha, beta, this.offset), weight);
    this.lastRender = now;
    this.pose = { valid: true, time: now, vector, ...vectorAngles(vector), roll: gamma, accuracy };
    this.pendingKey = null; this.pendingMessage = null;
    this.onChange(this.pose);
  }
  pause() {
    if (!this.listening) return;
    window.removeEventListener('deviceorientation', this.handle); this.listening = false;
    this.sample = null; this.calibrationSamples = [];
    this.pending('返回后请短暂平放，核验方向参考', 'waiting', '指向已暂停');
  }
  resume() {
    if (!this.enabled || this.listening) return;
    const age = Date.now() - this.lastSampleTime;
    if (this.offset != null && this.lastSampleTime != null && age >= 0 && age <= ORIENTATION_REUSE_MS) {
      this.checkResumedReference = true;
      this.pending('屏幕朝上，保持平放约 2 秒', 'flat', '请平放核验方向');
    } else this.invalidate('屏幕朝上，保持平放约 2 秒', this.offset != null ? '方向参考已过期' : '准备对齐方向');
    this.listening = true;
    window.addEventListener('deviceorientation', this.handle);
  }
  stop() {
    this.enabled = false; this.pause(); this.sample = null; this.lastSampleTime = null;
    this.invalidate('再次开启后自动对齐方向', '指向已关闭', 'waiting');
  }
}
