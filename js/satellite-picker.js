import { catalogChoices, orbitStatus } from './tracking-catalog.js';

const $ = id => document.getElementById(id);
export function initSatellitePicker({ state, select, favorite }) {
  const dialog = $('satelliteDialog'), opener = $('satelliteSelect'), search = $('satelliteSearch');
  const list = $('satelliteResults'), filters = [...dialog.querySelectorAll('[data-catalog-filter]')];
  let filter = 'all';
  function resize() {
    if (!dialog.open) return;
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    dialog.classList.toggle('is-compact', height < 400);
    dialog.style.top = `${(viewport?.offsetTop || 0) + 8}px`;
    dialog.style.maxHeight = `${Math.max(100, height - 16)}px`;
  }
  function render(force = false) {
    if (!dialog.open && force !== true) return;
    const current = state();
    const focused = document.activeElement;
    const focusId = list.contains(focused) ? focused.dataset.favoriteId || focused.dataset.satelliteId : null;
    const wasFavorite = !!focused?.dataset.favoriteId;
    const items = catalogChoices(current.records, current.favorites, search.value, filter);
    list.replaceChildren();
    $('satelliteCatalogStatus').textContent = current.status;
    $('satelliteResultStatus').textContent = items.length ? `${items.length} 个目标` :
      search.value.trim() ? '没有匹配的卫星，试试名称或 NORAD 编号。' :
      filter === 'favorites' ? '尚未收藏卫星，点击列表中的星标添加。' :
      filter === 'imports' ? '暂无本地导入卫星，可在设置中导入星历。' : '暂无可用目录。';
    list.setAttribute('aria-busy', String(current.loading));
    for (const item of items) {
      const row = document.createElement('li'); row.className = 'satellite-row';
      row.classList.toggle('is-selected', item.id === current.selected);
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'satellite-choice';
      choose.dataset.satelliteId = item.id;
      choose.setAttribute('aria-label', `选择 ${item.name}，NORAD ${item.catalogId}，${item.source === 'import' ? '本地导入' : '自动更新'}`);
      if (item.id === current.selected) choose.setAttribute('aria-current', 'true');
      const name = document.createElement('strong'); name.textContent = item.name;
      const detail = document.createElement('small'); detail.textContent = `NORAD ${item.catalogId} · ${item.source === 'import' ? '本地导入' : '自动更新'}`;
      const status = document.createElement('small'); status.textContent = orbitStatus(item);
      status.classList.toggle('is-warning', item.missingFromCatalog || /较旧|未来/.test(status.textContent));
      choose.append(name, detail, status);
      choose.addEventListener('click', () => { select(item.id); dialog.close(); });
      const star = document.createElement('button'); star.type = 'button'; star.className = 'satellite-favorite';
      star.dataset.favoriteId = item.id; star.textContent = current.favorites.has(item.id) ? '★' : '☆';
      star.setAttribute('aria-pressed', String(current.favorites.has(item.id)));
      star.setAttribute('aria-label', `${current.favorites.has(item.id) ? '取消收藏' : '收藏'} ${item.name}（${item.source === 'import' ? '本地导入' : '自动更新'}）`);
      star.addEventListener('click', () => favorite(item.id));
      row.append(choose, star); list.append(row);
    }
    for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.catalogFilter === filter));
    if (focusId) {
      const buttons = [...list.querySelectorAll('button')];
      (buttons.find(button => (wasFavorite ? button.dataset.favoriteId : button.dataset.satelliteId) === focusId) || search).focus({ preventScroll: true });
    }
  }
  const open = () => {
    filter = 'all'; search.value = ''; render(true); dialog.showModal();
    opener.setAttribute('aria-expanded', 'true'); resize(); search.focus({ preventScroll: true });
  };
  const close = () => { opener.setAttribute('aria-expanded', 'false'); if (opener.isConnected && !opener.closest('[hidden]')) opener.focus({ preventScroll: true }); };
  opener.addEventListener('click', open);
  $('satelliteDialogClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', close);
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); dialog.close(); }
  });
  search.addEventListener('input', render);
  for (const button of filters) button.addEventListener('click', () => { filter = button.dataset.catalogFilter; render(); });
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  window.addEventListener('resize', resize);
  return { render, close() { if (dialog.open) dialog.close(); }, destroy() {
    window.visualViewport?.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('scroll', resize);
    window.removeEventListener('resize', resize);
  } };
}
