// Service worker for the PC leg. Two jobs, and only two: make the page installable as an app, and make
// an installed (or merely visited) machine still open it when the school network is down.
//
// Bump VERSION whenever a heavy model file below is replaced with another file of the same name; the
// code files are revalidated on every load, so they do not need this.
const VERSION = 'focuschangeai-pc-v1';
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
// Files that only ever change when VERSION is bumped. Serving them from cache first is what keeps the
// app window opening in a second instead of re-pulling ~46 MB of models.
const HEAVY = ['.wasm', '.onnx', '.task', '.tflite', '.png'];

const isHeavy = (path) => HEAVY.some((ext) => path.endsWith(ext));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isHeavy(url.pathname)) {
    event.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(req);
        const refresh = fetch(req).then((res) => {
          if (res && res.ok) c.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || refresh;
      })
    );
    return;
  }

  // Everything the app can break on has to be current, so the network is tried first and the cache is
  // only the fallback for a machine that is offline right now.
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      // A page address is the one request that must never dead-end offline: the school links carry
      // ?faces=4 or ?selftest=1, and each query string is its own cache key. The screen behind them is
      // the same screen, so fall back to the cached page and let the query do its usual job.
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return Response.error();
    })
  );
});
