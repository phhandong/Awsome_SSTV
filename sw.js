/* Atomic, versioned application shell. Orbital data belongs to IndexedDB. */
importScripts('./sw-assets.js');
const CACHE_PREFIX = `sstv-shell:${new URL(self.registration.scope).pathname}:`;
const CACHE_NAME = CACHE_PREFIX + self.OFFLINE_VERSION;
const resourceURLs = self.OFFLINE_ASSETS.map(path => new URL(path, self.registration.scope).href);
const resources = new Set(resourceURLs);
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(resourceURLs.map(url => new Request(url, { cache:'reload' })));
    // Stay waiting on upgrades until an idle, sole client explicitly requests it.
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    // Do not claim an already open, uncontrolled first-install page.
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'ACTIVATE_UPDATE') return;
  event.waitUntil((async () => {
    const windows = (await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(client => client.url.startsWith(self.registration.scope));
    if (windows.length > 1) { event.source?.postMessage({type:'UPDATE_BLOCKED'}); return; }
    await self.skipWaiting();
  })());
});
self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;
  url.search = ''; url.hash = '';
  if(url.href === self.registration.scope) url.pathname += 'index.html';
  if(!resources.has(url.href)) return;
  event.respondWith((async () => {
    const cache=await caches.open(CACHE_NAME);
    // A missing cached module must not silently mix a newer network release.
    return await cache.match(url.href) || new Response('离线资源缺失，请关闭应用后联网重新打开。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  })());
});
