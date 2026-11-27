// zoomin-reader service worker
// - Archivos de la app (html, js, css, json): primero red, para que las actualizaciones lleguen enseguida;
//   si no hay internet, se usa la copia guardada.
// - Librerías pesadas e iconos (vendor/, icons/): primero caché (casi nunca cambian).
const CACHE = 'zoomin-reader-v5';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'voz.js',
  'manifest.json',
  'vendor/jszip.min.js',
  'vendor/unrar.bundle.js',
  'vendor/unrar.wasm',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const save = (req, res) => {
  if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  const path = new URL(req.url).pathname;
  const heavy = /\/(vendor|icons)\//.test(path);

  if (heavy) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => save(req, r))));
    return;
  }
  e.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((r) => save(req, r))
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
