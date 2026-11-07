/* AquaDisc — service worker : permet d'ouvrir l'app même sans internet.
   Réseau d'abord (toujours la dernière version), copie de secours si hors ligne. */
const CACHE = 'aquadisc-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './manifest.webmanifest']).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('aquadisc-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  /* Spotify, YouTube… : jamais touchés ; petit serveur local : jamais en cache */
  if (!same && !fonts) return;
  if (same && url.pathname.includes('/api/')) return;

  /* polices : cache d'abord (elles ne changent pas) */
  if (fonts) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((r) => {
        if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return r;
      }))
    );
    return;
  }

  /* fichiers du site : réseau d'abord, cache si hors ligne */
  e.respondWith(
    fetch(req).then((r) => {
      if (r.ok && !url.search) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    }).catch(async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('./')) || (await caches.match('./index.html')) || Response.error();
      return Response.error();
    })
  );
});
