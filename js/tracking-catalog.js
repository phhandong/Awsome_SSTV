export const ISS_ID = 'celestrak:25544';

// Keep local imports distinct; retain only protected targets absent from a new snapshot.
export function mergeCatalog(records, snapshot, favorites, selected) {
  const fresh = new Map(snapshot.filter(item => item.id !== ISS_ID).map(item => [item.id, { ...item, missingFromCatalog: false }]));
  const protectedIds = new Set([...favorites, selected]);
  const keep = records.filter(item => item.source === 'import' || item.id === ISS_ID);
  for (const item of records) {
    if (item.source !== 'import' && item.id !== ISS_ID && !fresh.has(item.id) && protectedIds.has(item.id)) {
      fresh.set(item.id, { ...item, missingFromCatalog: true });
    }
  }
  return [...keep, ...fresh.values()];
}

export function retainedCatalog(records, favorites, selected) {
  const protectedIds = new Set([...favorites, selected]);
  return records.filter(item => item.source !== 'import' && item.id !== ISS_ID && protectedIds.has(item.id));
}

export function catalogChoices(records, favorites, query = '', filter = 'all') {
  const term = query.trim().toLocaleLowerCase();
  const items = records.some(item => item.id === ISS_ID) ? records : [
    { id: ISS_ID, name: 'ISS', catalogId: '25544', source: 'celestrak', epoch: null }, ...records];
  return items.filter(item => (filter !== 'favorites' || favorites.has(item.id)) &&
    (filter !== 'imports' || item.source === 'import') &&
    (!term || `${item.name} ${item.catalogId}`.toLocaleLowerCase().includes(term)))
    .sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)) ||
      Number(b.id === ISS_ID) - Number(a.id === ISS_ID) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function orbitStatus(item, now = Date.now()) {
  if (!Number.isFinite(item.epoch)) return '等待星历';
  const age = now - item.epoch;
  const status = item.missingFromCatalog ? '未在最新目录中' : '星历已缓存';
  return `${status}${age > 72 * 3600000 ? ' · 星历较旧' : age < -86400000 ? ' · 历元在未来' : ''}`;
}
