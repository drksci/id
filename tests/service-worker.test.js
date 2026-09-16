import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

/**
 * Exercises the service worker's offline feedback outbox directly.
 *
 * The bug this covers: a non-retryable response (a 401, which is what the endpoint returns to an
 * unauthenticated reporter) was met with `continue`, so the record was never removed and was
 * re-sent on every sync event, forever, growing the queue. These tests pin the behaviour that
 * replaced it.
 *
 * sw.js is loaded in a VM with a small in-memory IndexedDB rather than through a browser, because
 * the interesting logic is the retry decision, not the storage.
 */

const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function makeIndexedDB(initial = []) {
  const records = new Map();
  let nextId = 1;
  for (const record of initial) {
    const id = record.id ?? nextId++;
    records.set(id, { ...record, id });
  }

  const request = (result) => {
    const req = {};
    queueMicrotask(() => { req.result = result; req.onsuccess?.({ target: req }); });
    return req;
  };

  function transaction(mode) {
    const tx = { oncomplete: null, onerror: null, error: null };
    tx.objectStore = () => ({
      getAll: () => request([...records.values()].map((r) => ({ ...r }))),
      get: (id) => request(records.has(id) ? { ...records.get(id) } : undefined),
      add: (value) => { const id = value.id ?? nextId++; records.set(id, { ...value, id }); queueMicrotask(() => tx.oncomplete?.()); return request(id); },
      put: (value) => { records.set(value.id, { ...value }); queueMicrotask(() => tx.oncomplete?.()); return request(value.id); },
      delete: (id) => { records.delete(id); queueMicrotask(() => tx.oncomplete?.()); return request(undefined); },
    });
    tx.__records = records;
    return tx;
  }

  return {
    open: () => {
      const req = { result: { transaction, createObjectStore: () => {} }, onsuccess: null, onupgradeneeded: null, onerror: null };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
    __records: records,
  };
}

/** Load sw.js against a fake environment and return the handles the tests need. */
function loadWorker({ fetchImpl, queued = [], clock = { now: Date.now() } }) {
  const listeners = new Map();
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(clock.now); else super(...args); }
    static now() { return clock.now; }
  }
  const indexedDB = makeIndexedDB(queued);
  const calls = [];

  const self = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    registration: { sync: { register: async () => {} }, showNotification: async () => {} },
    location: { origin: 'https://id.drksci.com' },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  const context = vm.createContext({
    self,
    indexedDB,
    caches: { open: async () => ({ addAll: async () => {}, put: async () => {} }), keys: async () => [], delete: async () => {}, match: async () => undefined },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
    Response: class { constructor(body, init) { this.body = body; this.status = init?.status ?? 200; } },
    URL,
    Promise,
    Date: FakeDate,
    Set,
    Map,
    console,
    queueMicrotask,
  });

  vm.runInContext(SOURCE, context, { filename: 'sw.js' });

  async function sync() {
    const handler = listeners.get('sync');
    assert.ok(handler, 'sw.js must register a sync handler');
    let pending;
    handler({ tag: 'drksci-feedback-sync', waitUntil: (promise) => { pending = promise; } });
    await pending;
  }

  return { sync, indexedDB, calls, listeners, clock };
}

const ok = (status = 201) => ({ ok: status >= 200 && status < 300, status });

test('a delivered report is removed from the queue', async () => {
  const worker = loadWorker({ fetchImpl: async () => ok(201), queued: [{ body: '{"a":1}' }] });
  await worker.sync();

  assert.equal(worker.indexedDB.__records.size, 0);
  assert.equal(worker.calls.length, 1);
});

test('a non-retryable failure is not retried forever', async () => {
  // 401 is exactly what the endpoint returns to an unauthenticated reporter.
  const worker = loadWorker({ fetchImpl: async () => ok(401), queued: [{ body: '{"a":1}' }] });

  await worker.sync();
  assert.equal(worker.calls.length, 1, 'one attempt');
  assert.equal(worker.indexedDB.__records.size, 1, 'the report is kept, not discarded');

  const [record] = [...worker.indexedDB.__records.values()];
  assert.equal(record.stuck, 401, 'the reason is recorded');
  assert.equal(record.attempts, 1);

  // The whole point: further syncs must not re-send it.
  await worker.sync();
  await worker.sync();
  assert.equal(worker.calls.length, 1, 'a stuck record must never be retried again');
});

test('a server error is retried, and the pass stops rather than hammering', async () => {
  const worker = loadWorker({
    fetchImpl: async () => ok(503),
    queued: [{ body: '{"a":1}' }, { body: '{"a":2}' }, { body: '{"a":3}' }],
  });

  await worker.sync();
  assert.equal(worker.calls.length, 1, 'a 5xx stops the pass instead of trying the rest');
  assert.equal(worker.indexedDB.__records.size, 3, 'everything is retained for a later attempt');

  const [record] = [...worker.indexedDB.__records.values()];
  assert.equal(record.stuck, undefined, 'a 5xx is not permanent');

  await worker.sync();
  assert.equal(worker.calls.length, 2, 'it is retried on a later sync');
});

test('a queue of failures does not grow the number of sends without bound', async () => {
  const worker = loadWorker({
    fetchImpl: async () => ok(403),
    queued: [{ body: '{"a":1}' }, { body: '{"a":2}' }],
  });

  for (let i = 0; i < 20; i += 1) await worker.sync();

  assert.equal(worker.calls.length, 2, 'two records, one attempt each, however many syncs happen');
  assert.equal(worker.indexedDB.__records.size, 2, 'and nothing is silently thrown away');
});

test('a network failure is retryable and preserves the queue', async () => {
  let calls = 0;
  const worker = loadWorker({
    fetchImpl: async () => { calls += 1; throw new Error('offline'); },
    queued: [{ body: '{"a":1}' }, { body: '{"a":2}' }],
  });

  await worker.sync();
  assert.equal(calls, 1, 'a network error stops the pass');
  assert.equal(worker.indexedDB.__records.size, 2);
  assert.equal([...worker.indexedDB.__records.values()][0].stuck, undefined);
});

test('429 and 408 are treated as worth retrying', async () => {
  for (const status of [429, 408]) {
    const worker = loadWorker({ fetchImpl: async () => ok(status), queued: [{ body: '{"a":1}' }] });
    await worker.sync();
    const [record] = [...worker.indexedDB.__records.values()];
    assert.equal(record.stuck, undefined, `${status} must remain retryable`);
  }
});

test('a permanently failed record never blocks the ones behind it', async () => {
  let status = 400;
  const worker = loadWorker({
    fetchImpl: async () => {
      const current = status;
      status = 201; // only the first request is unacceptable
      return ok(current);
    },
    queued: [{ body: '{"a":1}' }, { body: '{"a":2}' }],
  });

  await worker.sync();
  assert.equal(worker.calls.length, 2, 'the second record is still attempted');
  assert.equal(worker.indexedDB.__records.size, 1, 'the good one was delivered and removed');
});

test('an outage backs off instead of being hammered', async () => {
  const worker = loadWorker({ fetchImpl: async () => ok(500), queued: [{ body: '{"a":1}' }] });

  for (let i = 0; i < 12; i += 1) await worker.sync();
  assert.equal(worker.calls.length, 1, 'the backoff must suppress the immediate retries');
  assert.equal(worker.indexedDB.__records.size, 1, 'the report is held, not lost');
});

test('a report is never abandoned because the service was down for a while', async () => {
  const worker = loadWorker({ fetchImpl: async () => ok(503), queued: [{ body: '{"a":1}' }] });

  // A long outage: many syncs across a day of backoff, then the service recovers.
  for (let i = 0; i < 40; i += 1) {
    worker.clock.now += 60 * 60 * 1000; // an hour passes
    await worker.sync();
  }
  const [record] = [...worker.indexedDB.__records.values()];
  assert.equal(record.stuck, undefined, 'a server error is never treated as permanent');
  assert.ok(record.attempts > 1, 'it kept trying across the outage');

  // Recovery: the next attempt succeeds and the report is delivered.
  const recovered = loadWorker({
    fetchImpl: async () => ok(201),
    queued: [...worker.indexedDB.__records.values()],
    clock: { now: worker.clock.now + 24 * 60 * 60 * 1000 }, // a day later, well past the backoff
  });
  await recovered.sync();
  assert.equal(recovered.indexedDB.__records.size, 0, 'the held report is finally delivered');
});
