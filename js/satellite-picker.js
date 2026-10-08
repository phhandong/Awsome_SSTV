import { catalogChoices, orbitStatus } from './tracking-catalog.js';
import { formatMHz } from './radio-profiles.js';

const $ = id => document.getElementById(id);
export function initSatellitePicker({ state, select, favorite, profiles = () => [] }) {
  const dialog = $('satelliteDialog'), opener = $('satelliteSelect'), search = $('satelliteSearch');
  const list = $('satelliteResults'), filters = [...dialog.querySelectorAll('[data-catalog-filter]')];
  let filter = 'all', limit = 100;
  function radioCard(profile) {
    const card = document.createElement('span'); card.className = 'satellite-radio';
    const heading = document.createElement('span'); heading.className = 'satellite-radio-heading';
    const mode = document.createElement('span'); mode.className = 'satellite-radio-mode';
    mode.textContent = profile.mode || 'RX';
    const title = document.createElement('span'); title.className = 'satellite-radio-title';
    title.textContent = profile.name; title.title = profile.name;
    heading.append(mode, title); card.append(heading);
    for (const [label, low, high, className] of [
      ['下行', profile.lowHz, profile.highHz, 'downlink'],
      ['上行', profile.uplinkLowHz, profile.uplinkHighHz, 'uplink']
    ]) {
      if (low == null) continue;
      const line = document.createElement('span'); line.className = `satellite-radio-line ${className}`;
      const caption = document.createElement('small'); caption.textContent = label;
      const value = document.createElement('span'); value.className = 'satellite-radio-value';
      const first = document.createElement('b'); first.textContent = formatMHz(low); value.append(first);
      if (high != null && high !== low) {
        value.classList.add('is-band');
        const last = document.createElement('b'); last.textContent = `– ${formatMHz(high)}`; value.append(last);
      }
      const unit = document.createElement('small'); unit.textContent = 'MHz'; value.append(unit);
      line.append(caption, value); card.append(line);
    }
    const tags = [];
    if (profile.isRepeater) tags.push(`亚音 ${profile.tone || '未提供'}`);
    if (profile.uplinkMode && profile.uplinkMode !== profile.mode) tags.push(`上行 ${profile.uplinkMode}`);
    if (profile.invert) tags.push('反相');
    if (profile.inactive) tags.push('停用');
    if (profile.unconfirmed) tags.push('未确认');
    if (tags.length) {
      const details = document.createElement('span'); details.className = 'satellite-radio-tags';
      for (const tag of tags) { const value = document.createElement('span'); value.textContent = tag; details.append(value); }
      card.append(details);
    }
    return card;
  }
  function radioChoices(catalogId) {
    const priority = profile => profile.isRepeater && profile.tone && profile.tone !== '未提供' ? 0
      : /SSTV/i.test(profile.name) ? 1 : profile.isRepeater ? 2 : profile.uplinkLowHz != null ? 3 : 4;
    const ordered = [...profiles(catalogId)].sort((a, b) => Number(!!a.inactive) - Number(!!b.inactive) ||
      priority(a) - priority(b));
    const unique = new Map();
    for (const profile of ordered) {
      const key = JSON.stringify([profile.mode, profile.lowHz, profile.highHz, profile.uplinkLowHz,
        profile.uplinkHighHz, profile.uplinkMode, profile.tone, !!profile.invert, !!profile.inactive]);
      if (!unique.has(key)) unique.set(key, profile);
    }
    return [...unique.values()];
  }
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
    const focusId = list.contains(focused) ? focused.dataset.favoriteId || focused.dataset.satelliteId || focused.dataset.frequencyDetailsId : null;
    const wasFavorite = !!focused?.dataset.favoriteId;
    const wasDetails = !!focused?.dataset.frequencyDetailsId;
    const expanded = new Set([...list.querySelectorAll('details[open]')].map(details => details.dataset.satellite));
    const items = catalogChoices(current.records, current.favorites, search.value, filter);
    list.replaceChildren();
    $('satelliteCatalogStatus').textContent = current.loading ? '更新中…' : '';
    $('satelliteCatalogStatus').hidden = !current.loading;
    $('satelliteResultStatus').textContent = items.length ? `${items.length} 颗${items.length > limit ? ` · 显示 ${limit} 颗` : ''}` :
      search.value.trim() ? '没有匹配的卫星' :
      filter === 'favorites' ? '尚未收藏' : filter === 'imports' ? '暂无本地导入' : '暂无卫星';
    list.setAttribute('aria-busy', String(current.loading));
    $('satelliteMore').hidden = items.length <= limit;
    for (const item of items.slice(0, limit)) {
      const row = document.createElement('li'); row.className = 'satellite-row';
      row.classList.toggle('is-selected', item.id === current.selected);
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'satellite-choice';
      choose.dataset.satelliteId = item.id;
      choose.setAttribute('aria-label', `选择 ${item.name}，NORAD ${item.catalogId}，${item.source === 'import' ? '本地导入' : '自动更新'}`);
      if (item.id === current.selected) choose.setAttribute('aria-current', 'true');
      const name = document.createElement('strong'); name.className = 'satellite-name'; name.textContent = item.name;
      const detail = document.createElement('small'); detail.textContent = `NORAD ${item.catalogId}${item.source === 'import' ? ' · 导入' : ''}`;
      const status = document.createElement('small'); status.textContent = orbitStatus(item).replace(/^星历已缓存(?: · )?/, '');
      status.className = 'satellite-orbit-warning'; status.hidden = !status.textContent;
      choose.append(name, detail, status);
      const radio = document.createElement('span'); radio.className = 'satellite-radio-list';
      radio.id = `satellite-radio-${list.children.length}`;
      const channels = radioChoices(item.catalogId);
      for (const profile of channels.slice(0, 2)) radio.append(radioCard(profile));
      if (!channels.length) { const empty = document.createElement('small'); empty.textContent = '频率 —'; radio.append(empty); }
      choose.setAttribute('aria-describedby', radio.id); choose.append(radio);
      choose.addEventListener('click', () => { select(item.id); dialog.close(); });
      const content = document.createElement('div'); content.className = 'satellite-row-content'; content.append(choose);
      if (channels.length > 2) {
        const more = document.createElement('details'); more.className = 'satellite-radio-more'; more.dataset.satellite = item.id;
        more.open = expanded.has(item.id);
        const summary = document.createElement('summary'); summary.textContent = `其余 ${channels.length - 2} 组频率`;
        summary.dataset.frequencyDetailsId = item.id; more.append(summary);
        for (const profile of channels.slice(2)) more.append(radioCard(profile));
        content.append(more);
      }
      const star = document.createElement('button'); star.type = 'button'; star.className = 'satellite-favorite';
      star.dataset.favoriteId = item.id; star.textContent = current.favorites.has(item.id) ? '★' : '☆';
      star.setAttribute('aria-pressed', String(current.favorites.has(item.id)));
      star.setAttribute('aria-label', `${current.favorites.has(item.id) ? '取消收藏' : '收藏'} ${item.name}（${item.source === 'import' ? '本地导入' : '自动更新'}）`);
      star.addEventListener('click', () => favorite(item.id));
      row.append(content, star); list.append(row);
    }
    for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.catalogFilter === filter));
    if (focusId) {
      const buttons = [...list.querySelectorAll('button, summary')];
      (buttons.find(button => (wasFavorite ? button.dataset.favoriteId : wasDetails ? button.dataset.frequencyDetailsId : button.dataset.satelliteId) === focusId) || search).focus({ preventScroll: true });
    }
  }
  const open = () => {
    filter = 'all'; limit = 100; search.value = ''; render(true); dialog.showModal();
    opener.setAttribute('aria-expanded', 'true'); resize(); search.focus({ preventScroll: true });
  };
  const close = () => { opener.setAttribute('aria-expanded', 'false'); if (opener.isConnected && !opener.closest('[hidden]')) opener.focus({ preventScroll: true }); };
  opener.addEventListener('click', open);
  $('satelliteDialogClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', close);
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); dialog.close(); }
  });
  search.addEventListener('input', () => { limit = 100; render(); });
  $('satelliteMore').addEventListener('click', () => { limit += 100; render(); });
  for (const button of filters) button.addEventListener('click', () => { filter = button.dataset.catalogFilter; limit = 100; render(); });
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  window.addEventListener('resize', resize);
  return { render, close() { if (dialog.open) dialog.close(); }, destroy() {
    window.visualViewport?.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('scroll', resize);
    window.removeEventListener('resize', resize);
  } };
}
