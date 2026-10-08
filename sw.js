// ============================================================
// TSG フレットトレーナー — Service Worker（オフライン対応）
// ============================================================
// 方針（更新事故を起こさないための設計。TSGの他アプリと同じ考え方）
//   ・ページとプログラム（.html / .js / .json）は「ネット優先」：オンラインなら必ず最新版を取り、
//     電波が無い／4秒応答が無い時だけ、保存しておいたコピーで起動する。
//     → index.html と app.js の版がずれて壊れることがない。
//   ・画像・フォントは「保存版優先＋裏で更新」：一度取ったものは保存版で即表示し、裏で取り直す。
//
// CACHE の版名を上げるべき時：画像など「保存しておくファイル」を追加・削除した時。
// ============================================================
const CACHE = 'tsg-fret-v1';

const CORE = [
  './',
  './index.html',
  './core.js',
  './app.js',
  './manifest.json',
  './images/favicon-64.png',
  './images/favicon-32.png',
  './images/apple-touch-icon-180.png',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/icon-192-maskable.png',
  './images/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('tsg-fret-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)); }

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), timeout(4000)]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !isFont) return;
  if (sameOrigin && (req.mode === 'navigate' || /\.(html|js|json)$/.test(url.pathname) || url.pathname.endsWith('/'))) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req));
  }
});
