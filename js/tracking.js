import { parseElements, validateObserver, DAY } from './orbit-core.js';
import { TrackingStore, EphemerisSource, REFRESH_INTERVAL } from './tracking-store.js';
import { PhoneOrientation, pointingGuide } from './orientation.js';

const $ = id => document.getElementById(id);
const localTime = time => new Date(time).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const degrees = value => `${value.toFixed(1)}°`;

export function initTracking({ receiver, onActivity = () => {} }) {
  if (!$('trackView')) return null;
  let fallback;
  try { fallback = localStorage; } catch (_) { fallback = null; }
  const store = new TrackingStore(globalThis.indexedDB, fallback);
  const source = new EphemerisSource(store, parseElements);
  let records = [], selected = 'celestrak:25544', observer = null, position = null, prediction = null;
  let pose = null, active = false, generation = 0, worker = null, workerFailed = false, ready = false;
  let poseMessage = '', lastPredict = 0, locationGeneration = 0, drawFrame = null, lastDraw = 0;
  const orientation = new PhoneOrientation(value => {
    pose = value;
    if (!value.valid) poseMessage = value.message;
    renderPose(); scheduleDraw();
  });
  const record = () => records.find(item => item.id === selected);

  function ensureWorker() {
    if (worker || workerFailed) return;
    try {
      worker = new Worker(new URL('./orbit-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.generation !== generation || document.hidden) return;
        if (data.type === 'position') { position = data.position; renderPosition(); }
        if (data.type === 'passes') { prediction = data.prediction; renderPasses(); }
        if (data.type === 'error') { position = null; prediction = null; renderPosition(); $('passList').textContent = data.message; }
        scheduleDraw();
      };
      worker.onerror = () => {
        workerFailed = true; worker?.terminate(); worker = null; position = null; prediction = null;
        renderPosition(); $('passList').textContent = '轨道计算无法启动，请重新打开应用';
      };
    } catch (_) { workerFailed = true; $('passList').textContent = '当前浏览器无法启动轨道计算'; }
  }
  function configure() {
    generation++; position = null; prediction = null;
    renderPosition(); renderPasses(); renderData();
    if (!record() || !observer || document.hidden) return;
    ensureWorker(); lastPredict = Date.now();
    worker?.postMessage({ type: 'configure', generation, record: record(), observer, time: lastPredict });
  }
  function renderChoices() {
    const select = $('satelliteSelect');
    select.replaceChildren();
    if (!records.some(item => item.id === 'celestrak:25544')) select.add(new window.Option('ISS · 等待星历', 'celestrak:25544'));
    for (const item of records) select.add(new window.Option(`${item.name} · ${item.source === 'import' ? '本地导入' : '自动更新'}`, item.id));
    if (![...select.options].some(option => option.value === selected)) selected = 'celestrak:25544';
    select.value = selected;
    $('trackingTarget').textContent = record()?.name || 'ISS';
  }
  function renderData() {
    const item = record();
    $('trackingTarget').textContent = item?.name || 'ISS';
    const old = item && Date.now() - item.epoch > 72 * 3600000;
    const future = item && item.epoch > Date.now() + DAY;
    $('orbitEpoch').textContent = item
      ? `${old ? '⚠ 数据较旧 · ' : future ? '⚠ 历元在未来，请检查时间 · ' : ''}历元 ${localTime(item.epoch)}；${item.source === 'import' ? '导入' : '获取'} ${localTime(item.fetchedAt)}。${item.source === 'import' ? '此目标需手动更新。' : ''}`
      : '暂无可用星历；联网更新 ISS 或导入本地文件。';
    $('orbitEpoch').classList.toggle('is-warning', !!old || !!future);
    $('storageStatus').hidden = store.persistent;
    $('storageStatus').textContent = '浏览器持久存储不可用，离线数据可能无法保留；当前会话仍可使用。';
  }
  async function refresh(manual = false) {
    if (!ready || document.hidden) return;
    $('refreshOrbit').disabled = true;
    $('orbitDataStatus').textContent = '正在检查 ISS 星历…';
    try {
      const result = await source.refresh();
      if (result.record) {
        const previous = records.find(item => item.id === result.record.id);
        records = records.filter(item => item.id !== result.record.id).concat(result.record);
        renderChoices();
        if (selected === result.record.id && previous?.epoch !== result.record.epoch) configure();
      }
      const next = (await store.get('lastRequest')) + REFRESH_INTERVAL;
      $('orbitDataStatus').textContent = result.error
        ? `${result.error}；${result.record ? '继续使用缓存。' : '可手动导入星历。'}下次联网检查 ${localTime(next)}。`
        : result.limited ? `${manual ? '尚未到更新间隔。' : ''}ISS 下次检查 ${localTime(next)}。` : 'ISS 星历已更新；每两小时最多请求一次。';
      $('orbitDataStatus').classList.toggle('is-warning', !!result.error);
    } catch (error) { $('orbitDataStatus').textContent = `无法读取星历：${error.message}`; }
    finally { $('refreshOrbit').disabled = false; renderData(); }
  }
  async function setObserver(value, label) {
    validateObserver(value);
    observer = value;
    $('observerLat').value = value.latitude;
    $('observerLon').value = value.longitude;
    $('observerAlt').value = value.altitudeEstimated ? '' : value.altitude;
    $('observerStatus').textContent = `${label} · 海拔 ${value.altitude} m${value.altitudeEstimated ? '（估计）' : ''}${Number.isFinite(value.accuracy) ? ` · 水平精度约 ${Math.round(value.accuracy)} m` : ''}`;
    orientation.setObserver(observer); configure();
    await store.set('observer', observer); renderData();
  }
  function showView(tracking) {
    active = tracking;
    $('receiveView').hidden = tracking; $('trackView').hidden = !tracking;
    for (const [id, chosen] of [['receiveTab', !tracking], ['trackTab', tracking]]) {
      $(id).setAttribute('aria-selected', String(chosen)); $(id).tabIndex = chosen ? 0 : -1;
    }
    if (tracking) { orientation.resume(); scheduleDraw(); }
    onActivity(active); syncReceiver();
  }
  $('receiveTab').addEventListener('click', () => showView(false));
  $('trackTab').addEventListener('click', () => showView(true));
  document.querySelector('.field-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? false : event.key === 'End' ? true : !active;
    showView(next); $(next ? 'trackTab' : 'receiveTab').focus();
  });
  $('satelliteSelect').addEventListener('change', () => { selected = $('satelliteSelect').value; configure(); void store.set('selected', selected); });
  $('refreshOrbit').addEventListener('click', () => void refresh(true));
  $('orbitFile').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('星历文件不能大于 1 MB');
      const imported = parseElements(await file.text());
      const merged = new Map(records.filter(item => item.source === 'import').map(item => [item.id, item]));
      for (const item of imported) merged.set(item.id, item);
      if (merged.size > 500) throw new Error('本机最多保存 500 颗导入卫星');
      records = records.filter(item => item.source !== 'import').concat([...merged.values()]);
      selected = imported[0].id;
      await store.set('imports', [...merged.values()]); await store.set('selected', selected);
      renderChoices(); configure(); $('orbitDataStatus').textContent = `已导入 ${imported.length} 颗卫星；本地导入数据需手动更新。`;
    } catch (error) { $('orbitDataStatus').textContent = `导入失败：${error.message}`; }
    finally { event.target.value = ''; }
  });
  $('observerForm').addEventListener('submit', event => {
    event.preventDefault(); locationGeneration++;
    const altitudeEstimated = !$('observerAlt').value.trim();
    void setObserver({ latitude: Number($('observerLat').value), longitude: Number($('observerLon').value), altitude: altitudeEstimated ? 0 : Number($('observerAlt').value), altitudeEstimated }, '手动位置')
      .catch(error => { $('observerStatus').textContent = error.message; });
  });
  $('locateObserver').addEventListener('click', () => {
    if (!navigator.geolocation) { $('observerStatus').textContent = '定位不可用，请手动填写坐标'; return; }
    const requestId = ++locationGeneration;
    $('locateObserver').disabled = true; $('observerStatus').textContent = '正在获取当前位置…';
    navigator.geolocation.getCurrentPosition(result => {
      $('locateObserver').disabled = false; if (requestId !== locationGeneration) return;
      const { latitude, longitude, altitude, accuracy } = result.coords;
      void setObserver({ latitude, longitude, altitude: altitude ?? 0, accuracy, altitudeEstimated: altitude == null }, '系统定位')
        .catch(error => { $('observerStatus').textContent = error.message; });
    }, error => { $('locateObserver').disabled = false; if (requestId === locationGeneration) $('observerStatus').textContent = `定位未成功（${error.code}），可重试或手动填写。`; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
  $('orientationEnable').addEventListener('click', () => {
    const promise = orientation.enable(); // Keep permission request within the user gesture.
    $('orientationEnable').disabled = true;
    promise.then(() => { $('orientationCalibrate').disabled = false; $('orientationStop').hidden = false; })
      .catch(error => { $('orientationStatus').textContent = error.message; $('orientationEnable').disabled = false; });
  });
  $('orientationCalibrate').addEventListener('click', () => {
    try { orientation.calibrate(); poseMessage = '已校准 · 用手机物理顶部指向目标'; renderPose(); }
    catch (error) { $('orientationStatus').textContent = error.message; }
  });
  $('orientationStop').addEventListener('click', () => {
    orientation.stop(); $('orientationEnable').disabled = false; $('orientationCalibrate').disabled = true; $('orientationStop').hidden = true;
    $('orientationStatus').textContent = '姿态已关闭';
  });
  $('trackingReceiveBtn').addEventListener('click', () => { $('micReceiveBtn').click(); syncReceiver(); });
  $('trackingFileStop').addEventListener('click', () => { $('offlineDecodeBtn').click(); syncReceiver(); });
  function syncReceiver() {
    const state = receiver();
    $('trackingRxStatus').textContent = $('receiverStatus').textContent;
    $('trackingSnr').textContent = $('receiverLevelText').textContent;
    const button = $('trackingReceiveBtn');
    button.textContent = $('micReceiveLabel').textContent;
    button.disabled = $('micReceiveBtn').disabled;
    button.setAttribute('aria-pressed', String(state.micActive));
    $('trackingFileStop').hidden = !state.fileActive;
  }
  const rxObserver = new window.MutationObserver(syncReceiver);
  for (const id of ['receiverStatus', 'receiverLevelText', 'micReceiveBtn', 'offlineDecodeBtn']) rxObserver.observe($(id), { subtree: true, childList: true, attributes: true, characterData: true });
  function renderPosition() {
    $('orbitAz').textContent = position ? degrees(position.azimuth) : '—';
    $('orbitEl').textContent = position ? degrees(position.elevation) : '—';
    $('orbitRange').textContent = position ? `${Math.round(position.distance)} km` : '—';
    $('orbitVisibility').textContent = position ? (position.elevation >= 0 ? '地平线上方' : '地平线下方') : observer ? '等待星历' : '等待位置';
    $('satelliteCompact').textContent = position
      ? `${record()?.name || '卫星'} · AZ ${degrees(position.azimuth)} / EL ${degrees(position.elevation)}`
      : `${record()?.name || 'ISS'} · ${observer ? '等待有效星历' : '设置位置以预测过境'}`;
    renderPose(); renderCountdown();
  }
  function renderPose() {
    const fresh = pose?.valid && Date.now() - pose.time <= 2000;
    $('poseAz').textContent = fresh ? degrees(pose.azimuth) : '—';
    $('poseEl').textContent = fresh ? degrees(pose.elevation) : '—';
    $('poseRoll').textContent = fresh ? degrees(pose.roll) : '—';
    const guide = pointingGuide(fresh ? pose : null, position);
    $('pointingHint').textContent = guide.text;
    $('pointingAngle').textContent = guide.angle == null ? '—' : `${guide.angle.toFixed(1)}°`;
    if (fresh) $('orientationStatus').textContent = `真北已校正 · 指南针精度约 ±${pose.accuracy.toFixed(0)}°${pose.accuracy > 20 ? ' · 请重新校准' : ''}`;
    else if (orientation.enabled) $('orientationStatus').textContent = pose?.valid ? '姿态数据已暂停，请重新校准' : poseMessage;
  }
  function renderPasses() {
    const list = $('passList'); list.replaceChildren();
    if (!prediction) { list.textContent = observer && record() ? '正在计算过境…' : '设置目标和位置后显示过境。'; renderCountdown(); return; }
    if (!prediction.passes.length) list.textContent = '未来 24 小时没有高于几何地平线的过境。';
    for (const pass of prediction.passes) {
      const row = document.createElement('div'); row.className = 'pass-row';
      const time = document.createElement('strong'); time.textContent = pass.ongoingStart ? '预测起点已在地平线上方' : localTime(pass.rise);
      const max = document.createElement('span'); max.textContent = `最高 ${degrees(pass.maxElevation)}`;
      const detail = document.createElement('small'); detail.textContent = `最高点 ${localTime(pass.peak)} · ${pass.ongoingEnd ? '24 小时窗口内未落下' : `落下 ${localTime(pass.set)}`}`;
      row.append(time, max, detail); list.append(row);
    }
    renderCountdown();
  }
  function renderCountdown() {
    const now = Date.now(); const next = prediction?.passes.find(pass => pass.set >= now);
    $('passCountdown').textContent = !prediction ? '等待轨道预测' : !next ? '未来 24 小时无过境' : now >= next.rise ? '正在过境' : `距升起 ${Math.floor((next.rise - now) / 3600000)}时 ${Math.floor((next.rise - now) / 60000) % 60}分 ${Math.floor((next.rise - now) / 1000) % 60}秒`;
  }
  function scheduleDraw() {
    if (!active || document.hidden || drawFrame != null) return;
    drawFrame = requestAnimationFrame(draw);
  }
  function draw(time) {
    drawFrame = null;
    if (time - lastDraw < 1000 / 30) { scheduleDraw(); return; }
    lastDraw = time;
    const canvas = $('skyPlot'), c = canvas.getContext('2d'); if (!c) return;
    const style = getComputedStyle(document.documentElement), color = key => style.getPropertyValue(key).trim();
    const center = 320, radius = 255;
    c.clearRect(0, 0, 640, 640); c.strokeStyle = color('--line-strong'); c.lineWidth = 1;
    for (const r of [radius, radius * 2 / 3, radius / 3]) { c.beginPath(); c.arc(center, center, r, 0, Math.PI * 2); c.stroke(); }
    for (let a = 0; a < 360; a += 30) { const angle = a * Math.PI / 180; c.beginPath(); c.moveTo(center + Math.sin(angle) * 16, center - Math.cos(angle) * 16); c.lineTo(center + Math.sin(angle) * radius, center - Math.cos(angle) * radius); c.stroke(); }
    c.font = '16px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = color('--text-dim');
    for (const [text, x, y] of [['N / 北',320,38],['E',604,320],['S',320,603],['W',35,320]]) c.fillText(text,x,y);
    const xy = p => { const r = radius * (90 - Math.max(0, p.elevation)) / 90, a = p.azimuth * Math.PI / 180; return [center + Math.sin(a) * r, center - Math.cos(a) * r]; };
    const next = prediction?.passes.find(pass => pass.set >= Date.now());
    if (next) {
      c.strokeStyle = color('--accent'); c.lineWidth = 2; c.setLineDash([5,5]); c.beginPath();
      next.track.forEach((p,i) => { const [x,y] = xy(p); if (i) c.lineTo(x,y); else c.moveTo(x,y); }); c.stroke(); c.setLineDash([]);
      const [x,y] = xy(next.track[0]); c.fillStyle = color('--text-dim'); c.font = '12px monospace'; c.fillText(next.ongoingStart ? 'NOW' : 'AOS',x,y-14);
    }
    if (position?.elevation >= 0) { const [x,y] = xy(position); c.fillStyle = color('--accent'); c.beginPath(); c.arc(x,y,7,0,Math.PI*2); c.fill(); c.beginPath(); c.arc(x,y,14,0,Math.PI*2); c.strokeStyle=color('--accent-line'); c.stroke(); }
    if (pose?.valid && Date.now() - pose.time <= 2000 && pose.elevation >= 0) {
      const [x,y] = xy(pose); c.strokeStyle=color('--accent-2'); c.lineWidth=2; c.beginPath(); c.moveTo(x,y-10);c.lineTo(x+10,y);c.lineTo(x,y+10);c.lineTo(x-10,y);c.closePath();c.stroke();
    }
  }
  async function tick() {
    if (document.hidden) return;
    const now = Date.now();
    if (position && now - position.time > 4000) { position = null; renderPosition(); }
    if (worker && observer && record()) {
      worker.postMessage({ type: 'tick', generation, time: now });
      if (now - lastPredict >= 60000 || now < lastPredict) { lastPredict = now; worker.postMessage({ type: 'predict', generation, time: now }); }
    }
    renderPose(); renderCountdown(); scheduleDraw();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      generation++; worker?.terminate(); worker = null;
      orientation.pause(); position = null;
      if (drawFrame != null) cancelAnimationFrame(drawFrame); drawFrame = null;
    } else { if (orientation.enabled) orientation.resume(); configure(); void refresh(); }
  });
  // Layout/theme changes should redraw even while satellite position is pending.
  const themeObserver = new window.MutationObserver(scheduleDraw);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('resize', scheduleDraw);
  const timer = setInterval(() => void tick(), 1000);
  const refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL);
  const initPromise = (async () => {
    const [iss, imports, savedObserver, savedSelection] = await Promise.all(['iss','imports','observer','selected'].map(key => store.get(key)));
    records = [iss, ...(Array.isArray(imports) ? imports : [])].filter(Boolean);
    selected = savedSelection || selected; renderChoices();
    if (savedObserver) { try { await setObserver(savedObserver, '已保存位置'); } catch (_) { $('observerStatus').textContent = '已保存位置无效，请重新设置'; } }
    ready = true; renderData(); configure(); await refresh();
  })().catch(error => { ready = true; $('orbitDataStatus').textContent = `初始化失败，可重新导入：${error.message}`; });
  return { ready: initPromise, isActive: () => active, syncReceiver,
    destroy() { clearInterval(timer); clearInterval(refreshTimer); worker?.terminate(); orientation.stop(); rxObserver.disconnect(); themeObserver.disconnect(); } };
}
