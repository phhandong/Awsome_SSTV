export function initPwa({ isBusy = () => false, isReceiving = () => false } = {}) {
  const shell = document.createElement('aside');
  shell.className = 'pwa-tools'; shell.setAttribute('aria-label', '应用与离线状态');
  shell.innerHTML = `<details id="installHelp"><summary>添加到主屏幕</summary><p>在 iPhone Safari 中点“共享” → “添加到主屏幕”；若有“作为网页 App 打开”，请启用。桌面应用是独立会话，需要重新启用接收。</p></details><span id="offlineStatus" role="status">正在准备离线资源…</span><button id="applyAppUpdate" class="btn" type="button" hidden>更新应用</button><span id="wakeStatus" role="status"></span>`;
  document.querySelector('main')?.after(shell);
  const $ = id => shell.querySelector(`#${id}`);
  const standalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  $('installHelp').hidden = standalone();
  let registration, updateRequested = false, trackingActive = false, wake = null, wakePending = false, wakeFailed = false;
  const status = text => { $('offlineStatus').textContent = text; };
  async function updateWake() {
    const wanted = !document.hidden && (trackingActive || isReceiving());
    if (!wanted) { if (wake) { const lock = wake; wake = null; void lock.release().catch(() => {}); } $('wakeStatus').textContent = ''; return; }
    if (wake || wakePending || wakeFailed) return;
    if (!navigator.wakeLock) { wakeFailed = true; $('wakeStatus').textContent = '常亮不可用，请检查自动锁屏设置'; return; }
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (document.hidden || !(trackingActive || isReceiving())) { await lock.release(); return; }
      wake = lock; $('wakeStatus').textContent = '屏幕常亮已启用';
      lock.addEventListener('release', () => {
        if (wake === lock) { wake = null; wakeFailed = true; $('wakeStatus').textContent = '常亮已释放，请留意自动锁屏'; }
      });
    } catch (_) { wakeFailed = true; $('wakeStatus').textContent = '无法保持常亮，请检查自动锁屏设置'; }
    finally { wakePending = false; }
  }
  function sync() {
    const waiting = registration?.waiting;
    $('applyAppUpdate').hidden = !waiting;
    $('applyAppUpdate').disabled = isBusy() || updateRequested;
    if (waiting && isBusy()) status('新版本已就绪，接收或解码结束后可更新');
    void updateWake();
  }
  $('applyAppUpdate').addEventListener('click', () => {
    if (isBusy() || !registration?.waiting) return;
    updateRequested = true;
    document.body.setAttribute('inert', '');
    registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    sync();
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updateRequested && !isBusy()) location.reload();
    });
    navigator.serviceWorker.addEventListener('message', ({ data }) => {
      if (data?.type === 'UPDATE_BLOCKED') { updateRequested = false; document.body.removeAttribute('inert'); status('请关闭此应用的其他窗口后再更新'); sync(); }
    });
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { updateViaCache: 'none' })
      .then(reg => {
        registration = reg;
        const watch = worker => worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed') { status(reg.waiting && navigator.serviceWorker.controller ? '新版本已就绪，可在空闲时更新' : '离线资源已就绪'); sync(); }
          if (worker.state === 'redundant') status('离线资源准备失败，联网重开后重试');
        });
        watch(reg.installing); reg.addEventListener('updatefound', () => watch(reg.installing));
        if (reg.active) status('离线资源已就绪');
        sync();
      }).catch(() => status('离线缓存不可用；当前页面仍可使用'));
  } else status('离线安装需要 HTTPS 和支持 Service Worker 的浏览器');
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { wakeFailed = false; void registration?.update().catch(() => {}); }
    void updateWake();
  });
  window.addEventListener('pagehide', () => { void wake?.release().catch(() => {}); });
  const timer = setInterval(sync, 1000);
  return { setTrackingActive(value) { trackingActive = value; wakeFailed = false; void updateWake(); },
    refresh() { wakeFailed = false; sync(); }, destroy() { clearInterval(timer); void wake?.release(); shell.remove(); } };
}
