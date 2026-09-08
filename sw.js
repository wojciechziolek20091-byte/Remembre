/*
  Offline support for the installed app.

  Two strategies, split by what the file is.

  The shell -- the document, the stylesheet and the script -- is fetched from
  the network first, falling back to the cache when that fails or takes too
  long. Serving those from the cache first, as this once did, meant a release
  was never visible on the launch that downloaded it: the fresh copy only
  landed in the cache for next time, so every update needed two clean launches
  and an installed app that is resumed rather than relaunched could sit on an
  old version indefinitely.

  Everything else -- the fonts, the icons, the manifest -- is content-stable
  and large, so it is served from the cache and refreshed in the background.

  Bumping CACHE on a release retires every older cache in the activate step.

  A new worker deliberately does NOT skip waiting on its own. Taking over
  mid-session would leave the open page mixing old markup with new assets, so
  it waits until the page offers the reader the update and they accept it,
  which arrives here as a SKIP_WAITING message.
*/

const CACHE = "remembre-v5";

/* How long to wait for the network before falling back to the cached shell.
   Long enough for a slow connection, short enough not to feel broken. */
const NETWORK_TIMEOUT = 3500;

/* The parts that change on a release and must never be served stale. */
const SHELL_PATTERN = /(?:\/|\.html|\.css|\.js)$/;

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
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* Tapping a reminder should bring the app forward, not open a second copy. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of open) {
      if ("focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow("./");
    return undefined;
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function putInCache(request, response) {
  if (!response || !response.ok) return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response.clone());
}

/** Network first, with the cache as a fallback for failure and for slowness. */
function networkFirst(request) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled || !response) return;
      settled = true;
      resolve(response);
    };

    const fallback = setTimeout(async () => {
      const cached = await caches.match(request);
      finish(cached);
    }, NETWORK_TIMEOUT);

    fetch(request)
      .then((response) => {
        clearTimeout(fallback);
        putInCache(request, response);
        finish(response);
      })
      .catch(async () => {
        clearTimeout(fallback);
        const cached = await caches.match(request);
        // Nothing cached and no network: let the browser report the failure.
        finish(cached || Response.error());
      });
  });
}

/** Cache first, refreshed in the background, for files that rarely change. */
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => {
      putInCache(request, response);
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The sync and calendar routes are the live state of things. A cached copy
  // of either is worse than no answer at all, so they go straight to the
  // network and the app decides what to do when it is not there.
  if (url.pathname.startsWith("/api/")) return;

  const isShell = request.mode === "navigate" || SHELL_PATTERN.test(url.pathname);
  event.respondWith(isShell ? networkFirst(request) : staleWhileRevalidate(request));
});
