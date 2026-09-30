/* UniChat service worker: makes the site installable as an app and able to open without a connection.
   It only handles UniChat's own files (never chat, pictures or anything from another site), always asks the live site
   first so updates arrive straight away, and falls back to the copy it kept when the network doesn't answer. */
'use strict';

const CACHE = 'unichat-v1';
const APP_FILES = [
  './', 'index.html', 'settings.html', 'overlay.html', 'manifest.webmanifest', 'favicon.ico',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'css/style.css',
  'js/common.js', 'js/store.js', 'js/hub.js', 'js/emotes.js', 'js/twitch.js', 'js/tiktok.js', 'js/kick.js',
  'js/velora.js', 'js/blaze.js', 'js/nimo.js', 'js/dashboard.js', 'js/settings.js', 'js/overlay.js',
];

self.addEventListener('install', event => {
  // One file failing (e.g. a flaky connection) doesn't stop the rest from being kept.
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(APP_FILES.map(f => cache.add(f).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('unichat-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // other sites (chat servers, pictures, APIs) are left alone
  if (url.pathname.includes('/vendor/kokoro/model/')) return; // the voice model (~90 MB) is kept by the voice itself, not copied again here
  event.respondWith(fromNetwork(req, url));
});

async function fromNetwork(req, url) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // The part after "?" holds channel names only; one copy per file is enough.
    if (res.ok && res.type === 'basic') cache.put(url.pathname, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const kept = await cache.match(url.pathname, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('index.html'));
    if (kept) return kept;
    throw err;
  }
}
