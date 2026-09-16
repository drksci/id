const CACHE_NAME = "drksci-id-shell-v1";
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

const RETRYABLE_STATUS = new Set([408, 429]);
const BACKOFF_BASE_MS = 30000;
const BACKOFF_CEILING_MS = 6 * 60 * 60 * 1000;

// A 4xx means this request will never be accepted, however many times it is sent. Retrying it is not
// persistence, it is a loop: the record is never removed and the queue grows without bound. Only
// 5xx, 408 and 429 are worth another attempt.
function isRetryable(status) {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

function withStore(mode, run) {
  return openQueue().then((db) => new Promise((resolve, reject) => {
    const request = run(db.transaction(QUEUE_STORE, mode).objectStore(QUEUE_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

// Retrying a report forever is right — a service outage should not cost someone their feedback.
// Hammering is not, so retries back off rather than stopping, and the queue is never dropped.
function backoffRemaining(record, now) {
  if (!record.last_attempt) return 0;
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (record.attempts || 0), BACKOFF_CEILING_MS);
  return Math.max(0, Date.parse(record.last_attempt) + wait - now);
}

// Retained rather than deleted: a dropped report is worse than a stuck one, and a stuck one can be
// inspected and replayed once the cause is fixed.
function markStuck(db, id, status) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    const store = tx.objectStore(QUEUE_STORE);
    const read = store.get(id);
    read.onsuccess = () => {
      const record = read.result;
      if (!record) return;
      record.stuck = status;
      record.attempts = (record.attempts || 0) + 1;
      record.failed_at = new Date().toISOString();
      store.put(record);
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function markAttempt(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    const store = tx.objectStore(QUEUE_STORE);
    const read = store.get(id);
    read.onsuccess = () => {
      const record = read.result;
      if (!record) return;
      record.attempts = (record.attempts || 0) + 1;
      record.last_attempt = new Date().toISOString();
      store.put(record);
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function flushFeedback() {
  const db = await openQueue();
  const records = await new Promise((resolve, reject) => { const tx = db.transaction(QUEUE_STORE, "readonly"); const request = tx.objectStore(QUEUE_STORE).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  for (const record of records) {
    // Never retry something already known to be unacceptable, and give up on anything that has
    // failed too often rather than retrying it on every sync event for the life of the device.
    if (record.stuck) continue;
    if (backoffRemaining(record, Date.now()) > 0) continue;
    try {
      const response = await fetch(FEEDBACK_ENDPOINT, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: record.body });
      if (response.ok) {
        await withStore("readwrite", (store) => store.delete(record.id));
        continue;
      }
      if (isRetryable(response.status)) {
        // The endpoint is unwell, not the request. Keep it and back off instead of hammering.
        await markAttempt(db, record.id);
        break;
      }
      await markStuck(db, record.id, response.status);
    } catch (_) {
      await markAttempt(db, record.id).catch(() => {});
      break;
    }
  }
}
