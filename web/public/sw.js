/**
 * Weder Field Tracker — Module Service Worker
 *
 * Placeholders filled by scripts/build-sw.mjs after vite build:
 *   __CACHE_NAME__  → a hash of the precached files' contents
 *   __PRECACHE__    → JSON array of URL strings to precache
 */

import { classifyRequest } from './sw-routing.js';

const CACHE_NAME = '__CACHE_NAME__';
const PRECACHE_URLS = /** @type {string[]} */ (JSON.parse('__PRECACHE__'));
const PRECACHE_SET = new Set(PRECACHE_URLS);

// ── Install ──────────────────────────────────────────────────────────────────
// Open the versioned cache and fetch every precached URL with cache:'reload'
// so we always get a fresh copy, not a stale browser-cached one.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })))
    ).then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────
// Delete any cache that isn't the current one, then take control immediately.
// Trade-off: tabs already open run the old JS until the user reloads.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const outcome = classifyRequest(
    { method: event.request.method, url: event.request.url, mode: event.request.mode },
    self.location.origin,
    PRECACHE_SET,
  );

  if (outcome === 'asset') {
    // Cache-first: serve from cache, fall back to network.
    event.respondWith(
      caches.match(event.request).then((cached) => cached ?? fetch(event.request))
    );
    return;
  }

  if (outcome === 'navigation') {
    // Serve the cached shell; fall back to network for the first load.
    event.respondWith(
      caches.match('/index.html').then((cached) => cached ?? fetch(event.request))
    );
    return;
  }

  // 'bypass' — don't call respondWith; browser handles the request normally.
});
