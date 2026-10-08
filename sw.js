const CACHE = "abastecimento-1.0.0-26a13d7e87";
const FILES = ["./", "index.html", "store.js", "lib/xlsx.core.min.js", "lib/jszip.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if(e.request.method !== "GET") return;
  const url = new URL(e.request.url); if(url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, {ignoreSearch:true}).then(r => r || fetch(e.request).then(resp => {
    if(resp.ok){ const cp = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return resp;
  }).catch(() => caches.match("index.html"))));
});
