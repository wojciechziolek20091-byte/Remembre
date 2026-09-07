/*
  Offline support for the installed app.

  Strategy: stale-while-revalidate for same-origin GETs. A visit is served from
  the cache immediately -- so the app opens instantly and works on a train --
  while a fresh copy is fetched in the background for next time. Bumping
  CACHE on a release retires every older cache in the activate step.
*/

const CACHE = "remembre-v2";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./favicon.svg",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./fonts/inter-var-latin.woff2",
  "./fonts/inter-var-latin-ext.woff2",
  "./fonts/fraunces-var-latin.woff2",
  "./fonts/fraunces-var-latin-ext.woff2",
  "./fonts/alexbrush-400-latin.woff2",
  "./fonts/alexbrush-400-latin-ext.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Individually, so one missing file cannot fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
