const CACHE_NAME = "drksci-id-shell-v3";
const SHELL = [
  "/",
  "/carte/",
  "/catalog/",
  "/assist/",
  "/onboarding/",
  "/feedback/",
  "/assets/carte-seal.png",
  "/manifest.webmanifest",
  "/llms.txt",
  "/.well-known/agent-access.json"
];
const FEEDBACK_ENDPOINT = "/api/v1/feedback";
const QUEUE_DB = "drksci-id-feedback";
const QUEUE_STORE = "outbox";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method === "POST" && new URL(request.url).pathname === FEEDBACK_ENDPOINT) {
    event.respondWith(fetch(request).catch(() => queueFeedback(request).then(() => new Response(JSON.stringify({ queued: true }), { status: 202, headers: { "content-type": "application/json" } }))));
    return;
  }
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); return response; }).catch(() => caches.match("/"))));
});

function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(QUEUE_STORE, { keyPath: "id", autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueFeedback(request) {
  const body = await request.clone().text();
  const db = await openQueue();
  await new Promise((resolve, reject) => { const tx = db.transaction(QUEUE_STORE, "readwrite"); tx.objectStore(QUEUE_STORE).add({ body, created_at: new Date().toISOString() }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  if (self.registration.sync) await self.registration.sync.register("drksci-feedback-sync").catch(() => {});
}

self.addEventListener("sync", (event) => { if (event.tag === "drksci-feedback-sync") event.waitUntil(flushFeedback()); });

async function flushFeedback() {
  const db = await openQueue();
  const records = await new Promise((resolve, reject) => { const tx = db.transaction(QUEUE_STORE, "readonly"); const request = tx.objectStore(QUEUE_STORE).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  for (const record of records) {
    try { const response = await fetch(FEEDBACK_ENDPOINT, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: record.body }); if (!response.ok) continue; await new Promise((resolve, reject) => { const tx = db.transaction(QUEUE_STORE, "readwrite"); tx.objectStore(QUEUE_STORE).delete(record.id); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); } catch (_) { break; }
  }
}
