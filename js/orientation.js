import wmm from './vendor/wmm2025.js';
const D = Math.PI / 180;
export const wrap = degrees => ((degrees % 360) + 360) % 360;
export const angleDelta = (a, b) => ((a - b + 540) % 360) - 180;
const clamp = x => Math.max(-1, Math.min(1, x));
const GUIDE_KEY = 'sstv.orientationGuideComplete.v1';

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
  if (pose.accuracy > 20) return { text: '指南针精度较低 · 远离磁性配件并重新校准', angle };
  if (angle < 5) return { text: '已接近目标方向', angle };
  const delta = angleDelta(target.azimuth, pose.azimuth), lift = target.elevation - pose.elevation;
  const parts = [];
  if (target.elevation < 80 && pose.elevation < 80 && Math.abs(delta) > 3) parts.push(`${delta > 0 ? '向右 →' : '← 向左'} ${Math.abs(delta).toFixed(0)}°`);
  if (Math.abs(lift) > 3) parts.push(`${lift > 0 ? '抬高 ↑' : '降低 ↓'} ${Math.abs(lift).toFixed(0)}°`);
  return { text: parts.join(' · ') || '接近天顶 · 按夹角缓慢调整', angle };
}

export class PhoneOrientation {
  constructor(onChange) {
    this.onChange = onChange; this.enabled = false; this.offset = null; this.declination = null;
    this.pose = null; this.lastRender = 0; this.sample = null;
    this.guideComplete = false; this.calibrationSamples = []; this.waitStarted = Date.now();
    try { this.guideComplete = globalThis.localStorage?.getItem(GUIDE_KEY) === '1'; } catch (_) { /* Storage is optional. */ }
    this.handle = event => this.consume(event);
  }
  setObserver(observer) {
    try { this.declination = declinationAt(observer); this.invalidate('位置已更新，正在自动校正方向…'); }
    catch (error) { this.declination = null; this.invalidate(error.message); }
  }
  invalidate(message) {
    this.offset = null; this.pose = null; this.calibrationSamples = []; this.waitStarted = Date.now();
    this.pending(message);
  }
  pending(message) {
    if (this.pendingMessage === message) return;
    this.pendingMessage = message;
    this.onChange({ valid: false, message });
  }
  rememberGuide() {
    this.guideComplete = true; this.pendingMessage = null;
    // Persist onboarding only: an offset belongs to this sensor session.
    try { globalThis.localStorage?.setItem(GUIDE_KEY, '1'); } catch (_) { /* Continue in memory. */ }
  }
  async enable() {
    if (!window.isSecureContext) throw new Error('姿态功能需要 HTTPS');
    const api = window.DeviceOrientationEvent;
    if (!api) throw new Error('当前设备不支持姿态传感器');
    // Called directly from the click handler, before any unrelated await.
    if (typeof api.requestPermission === 'function' && await api.requestPermission() !== 'granted') throw new Error('运动权限未允许，请在 Safari 网站设置中检查权限后重试');
    this.enabled = true;
    this.resume();
    this.invalidate(this.guideComplete ? '正在自动校正方向…' : '首次使用：将手机屏幕朝上平放约 2 秒，自动校准后即可抬起指向');
  }
  calibrate() {
    const s = this.sample;
    if (!s || Date.now() - s.time > 2000) throw new Error('尚未收到姿态数据，请检查运动权限');
    if (this.declination == null) throw new Error('请先设置有效观测位置');
    if (Math.abs(s.beta) > 15 || Math.abs(s.gamma) > 15) throw new Error('请将手机屏幕朝上平放后校准');
    if (!Number.isFinite(s.heading) || s.heading < 0 || !Number.isFinite(s.accuracy) || s.accuracy < 0 || s.accuracy > 20) throw new Error('指南针数据不可靠，请远离金属和磁性配件后重试');
    this.offset = angleDelta(s.heading + this.declination, vectorAngles(topVector(s.alpha, s.beta)).azimuth);
    this.pose = null;
    this.rememberGuide();
    this.consume(s);
  }
  autoCalibrate(sample) {
    const { time, alpha, beta, gamma, heading, accuracy } = sample;
    if (!Number.isFinite(heading) || heading < 0 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 20) {
      this.calibrationSamples = [];
      this.pending('指南针数据不可靠，请远离磁性配件；恢复后将自动校准');
      return false;
    }
    if (Math.abs(beta) > 12 || Math.abs(gamma) > 12) {
      this.calibrationSamples = [];
      if (time - this.waitStarted > 2000) this.pending('请将手机屏幕朝上短暂平放，方向将自动恢复，无需点击校准');
      return false;
    }
    const offset = angleDelta(heading + this.declination, vectorAngles(topVector(alpha, beta)).azimuth);
    const samples = this.calibrationSamples, first = samples[0], last = samples.at(-1);
    if (last && (time - last.time > 500 || Math.abs(angleDelta(offset, first.offset)) > 5 || Math.abs(angleDelta(heading, first.heading)) > 5)) samples.length = 0;
    samples.push({ offset, heading, time });
    this.pending(this.guideComplete ? '正在自动校正方向，请保持平稳…' : '首次校准中：请保持平放约 2 秒，无需点击按钮');
    if (time - samples[0].time < 2000 || samples.length < 10) return false;
    // Circular mean keeps 359° / 0° samples adjacent.
    this.offset = Math.atan2(samples.reduce((sum, s) => sum + Math.sin(s.offset * D), 0), samples.reduce((sum, s) => sum + Math.cos(s.offset * D), 0)) / D;
    this.calibrationSamples = []; this.pose = null; this.lastRender = 0;
    this.rememberGuide();
    return true;
  }
  consume(event) {
    const alpha = event.alpha, beta = event.beta, gamma = event.gamma;
    if (![alpha, beta, gamma].every(value => typeof value === 'number' && Number.isFinite(value))) {
      if (this.enabled) this.invalidate('姿态数据失效，恢复后将自动校准');
      return;
    }
    const now = Date.now();
    const heading = event.webkitCompassHeading ?? event.heading;
    const accuracy = event.webkitCompassAccuracy ?? event.accuracy;
    this.sample = { alpha, beta, gamma, heading, accuracy, time: now };
    if (this.declination == null) { if (this.enabled) this.pending('请先设置有效观测位置，随后自动校准方向'); return; }
    const initializing = this.offset == null;
    if (this.offset == null && (!this.enabled || !this.autoCalibrate(this.sample))) return;
    if (now - this.lastRender < 1000 / 30) return;
    if (typeof heading !== 'number' || !Number.isFinite(heading) || heading < 0 || !Number.isFinite(accuracy) || accuracy < 0) {
      this.invalidate('指南针数据失效，恢复后将自动校准'); return;
    }
    const weight = 1 - Math.exp(-(now - this.lastRender) / 90);
    this.lastRender = now;
    // Refresh the magnetic reference only when flat; tilted compass heading
    // differs between implementations, while alpha/beta track the calibrated ray.
    if (!initializing && Math.abs(beta) < 12 && Math.abs(gamma) < 12 && accuracy <= 20) {
      const desired = angleDelta(heading + this.declination, vectorAngles(topVector(alpha, beta)).azimuth);
      this.offset += angleDelta(desired, this.offset) * weight;
    }
    const vector = smoothVector(this.pose?.vector, topVector(alpha, beta, this.offset), weight);
    this.pose = { valid: true, time: now, vector, ...vectorAngles(vector), roll: gamma, accuracy };
    this.onChange(this.pose);
  }
  pause() { window.removeEventListener('deviceorientation', this.handle); this.sample = null; this.invalidate('姿态已暂停，返回前台后自动校正'); }
  resume() { if (this.enabled) { this.waitStarted = Date.now(); window.removeEventListener('deviceorientation', this.handle); window.addEventListener('deviceorientation', this.handle); } }
  stop() { this.enabled = false; this.pause(); }
}
