// Cache minima per uso offline: pagina e ultimi dati scaricati (rete prima, cache come riserva)
const C = 'concerti-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(['./', 'index.html', 'manifest.webmanifest', 'icon.svg']))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const key = u.pathname.includes('/data/') ? new Request(u.origin + u.pathname) : e.request;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cl = r.clone(); caches.open(C).then(c => c.put(key, cl)); } return r; })
    .catch(() => caches.match(key).then(r => r || caches.match('index.html'))));
});
