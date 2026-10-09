import { parseElements, normalizeCatalogId, validateObserver, DAY } from './orbit-core.js';
import { TrackingStore, EphemerisSource, CatalogSource, REFRESH_INTERVAL, ORBIT_REQUEST_KEY } from './tracking-store.js';
import { TransponderSource } from './transponders.js';
import { ISS_ID, mergeCatalog, retainedCatalog } from './tracking-catalog.js';
import { initSatellitePicker } from './satellite-picker.js';
import { PhoneOrientation, pointingGuide } from './orientation.js';
import { initFrequencyPanel } from './frequency-panel.js';
import { createPassCalendar, exportPassCalendar } from './pass-calendar.js';

const $ = id => document.getElementById(id);
const localTime = time => new Date(time).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const degrees = value => `${value.toFixed(1)}°`;

export function initTracking({ receiver, onActivity = () => {} }) {
  if (!$('trackView')) return null;
  let fallback;
  try { fallback = localStorage; } catch (_) { fallback = null; }
  const store = new TrackingStore(globalThis.indexedDB, fallback);
  const source = new EphemerisSource(store, parseElements);
  const catalogSource = new CatalogSource(store, parseElements);
  const transponderSource = new TransponderSource(store);
  // One live canvas and one set of image/recording controls shared by both views.
  const decodedOutput = $('decoderOutput');
  const decodedOutputHome = decodedOutput.parentElement;
  let records = [], selected = 'celestrak:25544', observer = null, position = null, prediction = null;
  let favorites = new Set(), catalogStarted = false, catalogLoading = false, refreshPending = null;
  let pose = null, active = false, generation = 0, worker = null, workerFailed = false, ready = false;
  let poseMessage = '', poseReadyUntil = 0, lastPredict = 0, locationGeneration = 0, drawFrame = null, lastDraw = 0;
  const orientation = new PhoneOrientation(value => {
    if (value.valid && !pose?.valid) poseReadyUntil = Date.now() + 2000;
    pose = value;
    if (!value.valid) poseMessage = value.message;
    renderPose(); scheduleDraw();
  });
  const record = () => records.find(item => item.id === selected);
  let orbitError = '';
  const frequency = initFrequencyPanel({ store, catalog: () => normalizeCatalogId(record()?.catalogId || '25544'),
    position: () => position, epoch: () => record()?.epoch,
    unavailable: () => !observer ? '请在设置中填写或获取观测位置' : !record() ? '等待有效星历' : orbitError || '等待实时轨道计算…' });
  const settings = $('trackingSettings'), imageDialog = $('trackingImageDialog');
  const picker = initSatellitePicker({
    state: () => ({ records, selected, favorites, loading: catalogLoading, status: $('catalogDataStatus').textContent }),
    profiles: catalogId => frequency.profiles(normalizeCatalogId(catalogId)),
    select(id) {
      selected = id;
      pruneMissing();
      renderChoices(); configure();
      void store.set('selected', selected); void saveRetained();
    },
    favorite(id) {
      if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
      pruneMissing();
      picker.render(); void store.set('favorites', [...favorites]); void saveRetained(); renderData();
    }
  });
  function pruneMissing() { records = records.filter(item => !item.missingFromCatalog || favorites.has(item.id) || item.id === selected); }
  function saveRetained() { return store.set('catalogRetained', retainedCatalog(records, favorites, selected)); }
  function openSettings(location = false) {
    settings.showModal();
    if (location || !observer) {
      $('observerLabel').scrollIntoView({ block: 'start' });
      $('locateObserver').focus({ preventScroll: true });
    }
  }
  $('trackingSettingsOpen').addEventListener('click', () => openSettings());
  $('trackingLocate').addEventListener('click', () => openSettings(true));
  $('trackingSettingsClose').addEventListener('click', () => settings.close());
  // A full backdrop tap closes a sheet; a drag starting inside never dismisses it.
  for (const dialog of [settings, imageDialog, $('satelliteDialog')]) {
    let backdropDown = false;
    const outside = event => {
      const box = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
    };
    dialog.addEventListener('pointerdown', event => { backdropDown = outside(event); });
    dialog.addEventListener('pointerup', event => { if (backdropDown && outside(event)) dialog.close(); backdropDown = false; });
    dialog.addEventListener('pointercancel', () => { backdropDown = false; });
  }
  const imageStage = decodedOutput.querySelector('.result-canvas-stage');
  const emptyImageLabel = decodedOutput.querySelector('.result-empty-state');
  const originalEmptyLabel = emptyImageLabel.textContent;
  function enlargeImage() {
    if (!active || imageDialog.open) return;
    $('trackingImageLargeMount').append(decodedOutput); imageDialog.showModal();
  }
  $('trackingImageExpand').addEventListener('click', enlargeImage);
  imageStage.addEventListener('click', enlargeImage);
  imageStage.addEventListener('keydown', event => {
    if (active && !imageDialog.open && ['Enter', ' '].includes(event.key)) { event.preventDefault(); enlargeImage(); }
  });
  $('trackingImageClose').addEventListener('click', () => imageDialog.close());
  imageDialog.addEventListener('close', () => {
    (active ? $('trackingImageMount') : decodedOutputHome).append(decodedOutput);
    if (active) $('trackingImageExpand').focus();
  });

  function ensureWorker() {
    if (worker || workerFailed) return;
    try {
      worker = new Worker(new URL('./orbit-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.generation !== generation || document.hidden) return;
        if (data.type === 'position') { orbitError = ''; position = data.position; renderPosition(); }
        if (data.type === 'passes') { prediction = data.prediction; renderPasses(); }
        if (data.type === 'error') { orbitError = data.message; position = null; prediction = null; renderPosition(); $('passList').textContent = data.message; }
        scheduleDraw();
      };
      worker.onerror = () => {
        workerFailed = true; worker?.terminate(); worker = null; position = null; prediction = null;
        orbitError = '轨道计算无法启动，请重新打开应用';
        renderPosition(); $('passList').textContent = '轨道计算无法启动，请重新打开应用';
      };
    } catch (_) { workerFailed = true; orbitError = '当前浏览器无法启动轨道计算'; $('passList').textContent = orbitError; frequency.render(); }
  }
  function configure() {
    generation++; position = null; prediction = null; if (!workerFailed) orbitError = '';
    $('passCalendarStatus').textContent = '';
    frequency.choices();
    renderPosition(); renderPasses(); renderData();
    if (!record() || !observer || document.hidden) return;
    ensureWorker(); lastPredict = Date.now();
    worker?.postMessage({ type: 'configure', generation, record: record(), observer, time: lastPredict });
  }
  function renderChoices() {
    if (selected !== ISS_ID && !records.some(item => item.id === selected)) selected = ISS_ID;
    const button = $('satelliteSelect'); button.value = selected;
    $('satelliteSelectName').textContent = record()?.name || 'ISS';
    button.setAttribute('aria-label', `选择卫星，当前 ${record()?.name || 'ISS'}`);
    $('trackingTarget').textContent = record()?.name || 'ISS';
    frequency.choices(); picker.render();
  }
  function renderData() {
    const item = record();
    $('trackingTarget').textContent = item?.name || 'ISS';
    const old = item && Date.now() - item.epoch > 72 * 3600000;
    const future = item && item.epoch > Date.now() + DAY;
    $('orbitEpoch').textContent = item
      ? `${item.missingFromCatalog ? '⚠ 未在最新目录中 · ' : ''}${old ? '⚠ 数据较旧 · ' : future ? '⚠ 历元在未来，请检查时间 · ' : ''}历元 ${localTime(item.epoch)}；${item.source === 'import' ? '导入' : '获取'} ${localTime(item.fetchedAt)}。${item.source === 'import' ? '此目标需手动更新。' : ''}`
      : '暂无可用星历；联网更新 ISS、导入文件或粘贴星历。';
    $('orbitEpoch').classList.toggle('is-warning', !!old || !!future || !!item?.missingFromCatalog);
    $('storageStatus').hidden = store.persistent;
    $('storageStatus').textContent = '浏览器持久存储不可用，离线数据可能无法保留；当前会话仍可使用。';
  }
  function refresh(manual = false) {
    if (!ready || document.hidden) return Promise.resolve();
    if (refreshPending) return refreshPending;
    refreshPending = performRefresh(manual).finally(() => { refreshPending = null; });
    return refreshPending;
  }
  async function refreshFeed(feed, catalog, manual) {
    const status = $(catalog ? 'catalogDataStatus' : 'orbitDataStatus');
    const label = catalog ? '卫星目录' : 'ISS 星历';
    if (catalog) catalogLoading = true;
    status.textContent = `正在检查${label}…`; picker.render();
    try {
      const result = await feed.refresh();
      const previous = record();
      if (catalog && Array.isArray(result.records)) {
        records = mergeCatalog(records, result.records, favorites, selected);
        await saveRetained();
      } else if (!catalog && result.record) {
        records = records.filter(item => item.id !== ISS_ID).concat(result.record);
      }
      renderChoices();
      if (previous?.epoch !== record()?.epoch || previous?.id !== record()?.id) configure();
      const next = (await store.get(ORBIT_REQUEST_KEY)) + REFRESH_INTERVAL;
      const cached = catalog ? result.records?.length : !!result.record;
      status.textContent = result.error
        ? `${label}：${result.error}；${cached ? '继续使用缓存。' : '暂无缓存，可在设置中导入星历。'}下次可检查 ${localTime(next)}。`
        : result.limited ? `${label}：${cached ? `已读取缓存${catalog ? ` · ${result.records.length} 颗卫星` : ''}。` : ''}${manual ? '尚未到更新间隔。' : ''}下次可检查 ${localTime(next)}。`
        : `${label}已更新${catalog ? ` · ${result.records.length} 颗卫星` : ''}；每两小时最多请求一次。`;
      status.classList.toggle('is-warning', !!result.error);
    } catch (error) { status.textContent = `${label}读取失败：${error.message}`; status.classList.add('is-warning'); }
    finally { if (catalog) catalogLoading = false; renderData(); picker.render(); }
  }
  async function refreshTransponders() {
    const status = $('transponderDataStatus');
    status.textContent = '正在检查转发器数据…';
    const result = await transponderSource.refresh();
    if (Array.isArray(result.value)) { frequency.updateTransponders(result.value); picker.render(); }
    const next = (await store.get('lastRequest:transponders')) + REFRESH_INTERVAL;
    status.textContent = result.error ? `转发器数据：${result.error}；${result.value ? '继续使用缓存。' : '暂无缓存。'}下次可检查 ${localTime(next)}。`
      : `转发器${result.limited ? '已缓存' : '已更新'} · ${result.value?.length || 0} 条频率记录；下次可检查 ${localTime(next)}。`;
    status.classList.toggle('is-warning', !!result.error);
  }
  async function performRefresh(manual) {
    $('refreshOrbit').disabled = true;
    try {
      const tasks = [refreshFeed(source, false, manual)];
      if (catalogStarted || active || manual) { catalogStarted = true; tasks.push(refreshFeed(catalogSource, true, manual), refreshTransponders()); }
      await Promise.all(tasks);
    } finally { $('refreshOrbit').disabled = false; }
  }
  async function setObserver(value, label) {
    validateObserver(value);
    observer = value;
    $('trackingLocate').hidden = true;
    $('orientationEnable').hidden = false;
    document.querySelector('.sky-console').classList.add('has-observer');
    $('observerLat').value = value.latitude;
    $('observerLon').value = value.longitude;
    $('observerAlt').value = value.altitudeEstimated ? '' : value.altitude;
    $('observerStatus').textContent = `${label} · 海拔 ${value.altitude} m${value.altitudeEstimated ? '（估计）' : ''}${Number.isFinite(value.accuracy) ? ` · 水平精度约 ${Math.round(value.accuracy)} m` : ''}`;
    orientation.setObserver(observer); configure();
    await store.set('observer', observer); renderData();
  }
  function showView(tracking) {
    active = tracking;
    if (imageDialog.open) imageDialog.close();
    if (settings.open) settings.close();
    picker.close();
    document.body.classList.toggle('is-tracking', tracking);
    imageStage.tabIndex = tracking ? 0 : -1;
    if (tracking) { imageStage.setAttribute('role', 'button'); imageStage.setAttribute('aria-label', '放大实时解码图像并保存'); }
    else { imageStage.removeAttribute('role'); imageStage.removeAttribute('aria-label'); }
    emptyImageLabel.textContent = tracking ? '等待 SSTV 图像' : originalEmptyLabel;
    (tracking ? $('trackingImageMount') : decodedOutputHome).append(decodedOutput);
    $('receiveView').hidden = tracking; $('trackView').hidden = !tracking;
    for (const [id, chosen] of [['receiveTab', !tracking], ['trackTab', tracking]]) {
      $(id).setAttribute('aria-selected', String(chosen)); $(id).tabIndex = chosen ? 0 : -1;
    }
    if (tracking) { window.scrollTo(0, 0); orientation.resume(); scheduleDraw(); void refresh().then(() => { if (active && !catalogStarted) void refresh(); }); }
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
  $('refreshOrbit').addEventListener('click', () => void refresh(true));
  async function importOrbitText(text) {
    if (new Blob([text]).size > 1024 * 1024) throw new Error('星历文本不能大于 1 MB');
    const imported = parseElements(text);
    const merged = new Map(records.filter(item => item.source === 'import').map(item => [item.id, item]));
    for (const item of imported) merged.set(item.id, item);
    if (merged.size > 500) throw new Error('本机最多保存 500 颗导入卫星');
    records = records.filter(item => item.source !== 'import').concat([...merged.values()]);
    selected = imported[0].id;
    pruneMissing();
    await store.set('imports', [...merged.values()]); await store.set('selected', selected); await saveRetained();
    renderChoices(); configure();
    $('orbitDataStatus').textContent = `已导入 ${imported.length} 颗卫星；本地导入数据需手动更新。`;
    $('orbitDataStatus').classList.remove('is-warning');
  }
  function showOrbitPaste(open) {
    $('orbitPasteForm').hidden = !open;
    $('orbitPasteOpen').setAttribute('aria-expanded', String(open));
    if (open) $('orbitPasteStatus').textContent = '';
    $(open ? 'orbitPasteText' : 'orbitPasteOpen').focus();
  }
  $('orbitPasteOpen').addEventListener('click', () => showOrbitPaste($('orbitPasteForm').hidden));
  $('orbitPasteCancel').addEventListener('click', () => showOrbitPaste(false));
  $('orbitPasteForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('orbitPasteSubmit').disabled = true;
    $('orbitPasteStatus').textContent = '';
    try {
      await importOrbitText($('orbitPasteText').value);
      $('orbitPasteText').value = '';
      showOrbitPaste(false);
    } catch (error) {
      $('orbitPasteStatus').textContent = `导入失败：${error.message}`;
    } finally { $('orbitPasteSubmit').disabled = false; }
  });
  $('orbitFile').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('星历文件不能大于 1 MB');
      await importOrbitText(await file.text());
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
    $('orientationStatus').classList.remove('is-warning');
    const promise = orientation.enable(); // Keep permission request within the user gesture.
    $('orientationEnable').disabled = true;
    promise.then(() => { $('orientationCalibrate').disabled = false; $('orientationStop').hidden = false; })
      .catch(error => { $('orientationStatus').textContent = error.message; $('orientationStatus').classList.add('is-warning'); $('orientationEnable').disabled = false; renderPose(); });
  });
  $('orientationCalibrate').addEventListener('click', () => {
    try { orientation.calibrate(); poseMessage = '已校准 · 用手机物理顶部指向目标'; renderPose(); }
    catch (error) { $('orientationStatus').textContent = error.message; }
  });
  $('orientationStop').addEventListener('click', () => {
    orientation.stop(); $('orientationEnable').disabled = false; $('orientationCalibrate').disabled = true; $('orientationStop').hidden = true;
    $('orientationStatus').textContent = '姿态已关闭';
    $('orientationStatus').classList.remove('is-warning');
    renderPose();
  });
  $('trackingReceiveBtn').addEventListener('click', () => { $('micReceiveBtn').click(); syncReceiver(); });
  $('trackingDownloadRecording').addEventListener('click', () => $('downloadRecordingBtn').click());
  $('trackingFileStop').addEventListener('click', () => { $('offlineDecodeBtn').click(); syncReceiver(); });
  function syncReceiver() {
    const state = receiver();
    $('trackingRxStatus').textContent = $('receiverStatus').textContent;
    $('trackingSnr').textContent = $('receiverLevelText').textContent;
    const button = $('trackingReceiveBtn');
    button.textContent = $('micReceiveLabel').textContent;
    button.disabled = $('micReceiveBtn').disabled;
    button.hidden = !!state.fileActive;
    button.setAttribute('aria-pressed', String(state.micActive));
    button.setAttribute('aria-busy', String(!!(state.micStarting || state.micStopping)));
    document.querySelector('.tracking-rx-bar').classList.toggle('is-receiving', !!state.micActive);
    $('trackingFileStop').hidden = !state.fileActive;
    $('trackingRecording').hidden = !state.hasRecording;
    $('trackingRecordingSummary').textContent = state.hasRecording ? `已暂存录音 · ${state.recordingSeconds.toFixed(1)} 秒` : '暂无暂存录音';
    $('trackingDownloadRecording').disabled = !state.hasRecording;
    $('trackingClearRecording').disabled = !state.hasRecording || state.micActive || state.micStarting || state.micStopping || state.fileActive;
  }
  const rxObserver = new window.MutationObserver(syncReceiver);
  for (const id of ['receiverStatus', 'receiverLevelText', 'micReceiveBtn', 'offlineDecodeBtn', 'downloadRecordingBtn']) rxObserver.observe($(id), { subtree: true, childList: true, attributes: true, characterData: true });
  function renderPosition() {
    $('orbitAz').textContent = position ? degrees(position.azimuth) : '—';
    $('orbitEl').textContent = position ? degrees(position.elevation) : '—';
    $('orbitRange').textContent = position ? `${Math.round(position.distance)} km` : '—';
    $('orbitVisibility').textContent = position ? (position.elevation >= 0 ? '地平线上方' : '地平线下方') : observer ? '等待星历' : '等待位置';
    $('orbitVisibility').classList.toggle('is-visible', !!position && position.elevation >= 0);
    $('satelliteCompact').textContent = position
      ? `${record()?.name || '卫星'} · AZ ${degrees(position.azimuth)} / EL ${degrees(position.elevation)}`
      : `${record()?.name || 'ISS'} · ${observer ? '等待有效星历' : '设置位置以预测过境'}`;
    frequency.render(); renderPose(); renderCountdown();
  }
  function renderPose() {
    const fresh = pose?.valid && Date.now() - pose.time <= 2000;
    $('poseAz').textContent = fresh ? degrees(pose.azimuth) : '—';
    $('poseEl').textContent = fresh ? degrees(pose.elevation) : '—';
    $('poseRoll').textContent = fresh ? degrees(pose.roll) : '—';
    const guide = pointingGuide(fresh ? pose : null, position);
    const pending = orientation.enabled && !fresh;
    const ready = fresh && pose.accuracy <= 20 && Date.now() < poseReadyUntil;
    const notice = pending ? (pose?.valid ? '等待新的方向数据…' : poseMessage)
      : fresh && pose.accuracy > 20 ? '指南针精度较低 · 请远离磁性配件后平放'
      : ready ? '方向已就绪 · 可抬起手机指向' : '';
    const noticeElement = $('orientationGuide');
    if (noticeElement.textContent !== notice) noticeElement.textContent = notice;
    noticeElement.hidden = !notice;
    $('pointingHint').hidden = !!notice;
    $('pointingAngle').hidden = !!notice || guide.angle == null;
    noticeElement.parentElement.dataset.state = !notice ? 'pointing' : ready ? 'ready'
      : /无需重新平放/.test(notice) ? 'waiting'
      : /平放|校准/.test(notice) && !/精度|不可靠|不足|失效/.test(notice) ? 'calibrating' : pending ? 'waiting' : 'warning';
    $('pointingHint').textContent = !orientation.enabled && $('orientationStatus').classList.contains('is-warning')
      ? '方向未就绪 · 可按方位角手动指向' : guide.text;
    $('pointingAngle').textContent = guide.angle == null ? '—' : `${guide.angle.toFixed(1)}°`;
    if (fresh) $('orientationStatus').textContent = `真北已校正 · 指南针精度约 ±${pose.accuracy.toFixed(0)}°${pose.accuracy > 20 ? ' · 请重新校准' : ''}`;
    else if (orientation.enabled) $('orientationStatus').textContent = pose?.valid ? '等待新的姿态数据…' : poseMessage;
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
      const actions = document.createElement('div'); actions.className = 'pass-calendar-actions';
      // Capture the target and location belonging to this prediction, including while the share sheet is open.
      const satellite = record(), location = observer;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-small btn-secondary'; button.textContent = '添加到日历';
      button.setAttribute('aria-label', `添加到日历：${satellite.name}，${localTime(pass.rise)}`);
      button.addEventListener('click', async () => {
        const status = $('passCalendarStatus'), requestGeneration = generation;
        button.disabled = true; status.textContent = '正在准备日历事件…';
        try {
          const result = await exportPassCalendar(createPassCalendar({ satellite, observer: location, pass }));
          if (generation === requestGeneration) status.textContent = result === 'cancelled' ? '已取消分享，尚未添加到日历。'
            : result === 'shared' ? '已分享日历文件；请在 iOS 中打开并确认添加到所选日历。'
            : '已下载日历文件；请打开并确认添加。iPhone 可通过 Apple Mail 附件导入。';
        } catch (error) { if (generation === requestGeneration) status.textContent = `日历导出失败：${error.message}`; }
        finally { button.disabled = false; }
      });
      actions.append(button);
      row.append(time, max, detail, actions); list.append(row);
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
    const compact = canvas.clientWidth < 200;
    const style = getComputedStyle(document.documentElement), color = key => style.getPropertyValue(key).trim();
    const center = 320, radius = 255;
    c.clearRect(0, 0, 640, 640); c.strokeStyle = color('--line-strong'); c.lineWidth = compact ? 3 : 1;
    for (const r of [radius, radius * 2 / 3, radius / 3]) { c.beginPath(); c.arc(center, center, r, 0, Math.PI * 2); c.stroke(); }
    for (let a = 0; a < 360; a += 30) { const angle = a * Math.PI / 180; c.beginPath(); c.moveTo(center + Math.sin(angle) * 16, center - Math.cos(angle) * 16); c.lineTo(center + Math.sin(angle) * radius, center - Math.cos(angle) * radius); c.stroke(); }
    c.font = `${compact ? 40 : 26}px monospace`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = color('--text-dim');
    for (const [text, x, y] of [['N / 北',320,38],['E',604,320],['S',320,603],['W',35,320]]) c.fillText(text,x,y);
    const xy = p => { const r = radius * (90 - Math.max(0, p.elevation)) / 90, a = p.azimuth * Math.PI / 180; return [center + Math.sin(a) * r, center - Math.cos(a) * r]; };
    const next = prediction?.passes.find(pass => pass.set >= Date.now());
    if (next) {
      c.strokeStyle = color('--accent'); c.lineWidth = compact ? 5 : 3; c.setLineDash([9,9]); c.beginPath();
      next.track.forEach((p,i) => { const [x,y] = xy(p); if (i) c.lineTo(x,y); else c.moveTo(x,y); }); c.stroke(); c.setLineDash([]);
      const [x,y] = xy(next.track[0]); if (!compact) { c.fillStyle = color('--text-dim'); c.font = '12px monospace'; c.fillText(next.ongoingStart ? 'NOW' : 'AOS',x,y-14); }
    }
    if (position?.elevation >= 0) { const [x,y] = xy(position); c.fillStyle = color('--accent'); c.beginPath(); c.arc(x,y,compact ? 15 : 7,0,Math.PI*2); c.fill(); c.beginPath(); c.arc(x,y,compact ? 25 : 14,0,Math.PI*2); c.strokeStyle=color('--accent-line'); c.stroke(); }
    if (pose?.valid && Date.now() - pose.time <= 2000 && pose.elevation >= 0) {
      const [x,y] = xy(pose), size=compact ? 20 : 10; c.strokeStyle=color('--accent-2'); c.lineWidth=compact ? 5 : 2; c.beginPath(); c.moveTo(x,y-size);c.lineTo(x+size,y);c.lineTo(x,y+size);c.lineTo(x-size,y);c.closePath();c.stroke();
    }
  }
  async function tick() {
    if (document.hidden) return;
    const now = Date.now();
    if (position && (now - position.time > 4000 || now < position.time)) { orbitError = '轨道结果已过期，等待更新…'; position = null; renderPosition(); }
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
      orbitError = '跟踪已暂停，返回前台后更新'; renderPosition();
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
    await frequency.ready;
    const [iss, imports, savedObserver, savedSelection, catalog, retained, savedFavorites] = await Promise.all(['iss','imports','observer','selected','amateur','catalogRetained','favorites'].map(key => store.get(key)));
    favorites = new Set(Array.isArray(savedFavorites) ? savedFavorites.filter(id => typeof id === 'string') : []);
    selected = savedSelection || selected;
    records = mergeCatalog([iss, ...(Array.isArray(imports) ? imports : []), ...(Array.isArray(retained) ? retained : [])].filter(Boolean),
      Array.isArray(catalog) ? catalog : [], favorites, selected);
    if (Array.isArray(catalog) && catalog.length) $('catalogDataStatus').textContent = `已读取 ${catalog.length} 颗卫星的本机目录缓存；进入跟踪页后检查更新。`;
    else if (navigator.onLine === false) $('catalogDataStatus').textContent = '当前离线，暂无自动目录缓存；可在设置中导入星历。';
    renderChoices();
    if (savedObserver) { try { await setObserver(savedObserver, '已保存位置'); } catch (_) { $('observerStatus').textContent = '已保存位置无效，请重新设置'; } }
    ready = true; renderData(); configure(); await refresh();
  })().catch(error => { ready = true; $('orbitDataStatus').textContent = `初始化失败，可重新导入：${error.message}`; });
  return { ready: initPromise, isActive: () => active, syncReceiver,
    destroy() { clearInterval(timer); clearInterval(refreshTimer); worker?.terminate(); orientation.stop(); picker.destroy(); rxObserver.disconnect(); themeObserver.disconnect(); } };
}
