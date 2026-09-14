/**
 * Sprint 6 — Background Sync drain in public/sw.js.
 *
 * The Service Worker cannot be imported as a module: it is a classic script
 * that attaches itself to `self`. So it is read from disk and evaluated inside
 * a hand-built worker global, which is the same technique test/views.test.js
 * uses for the DOM and test/frontend.test.js uses for IndexedDB — this project
 * deliberately carries zero test dependencies.
 *
 * What is faked:
 *   - self / addEventListener : so the `sync` listener can be captured and fired
 *   - indexedDB              : a real-enough AgencyOS_DB with both stores
 *   - fetch                  : so uploads are observable without a network
 *   - caches / clients       : the install/activate/fetch handlers must load
 *
 * The point of the assertions below is the QUEUE CONTRACT: a 200 deletes, a 4xx
 * deletes (it can never succeed), a 5xx or a throw keeps the record for the next
 * wake-up, and a failure stops the walk instead of burning the sync budget.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SW_PATH = path.join(process.cwd(), 'public', 'sw.js');
const SOURCE = fs.readFileSync(SW_PATH, 'utf8');

const SYNC_TAG = 'sync-agency-outbox';
const QUEUE_STORE = 'queue';

// ---------------------------------------------------------------------
// FAKE INDEXEDDB
// ---------------------------------------------------------------------

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }

  succeed(result) { this.result = result; queueMicrotask(() => this.onsuccess?.({ target: this })); }
  fail(error) { this.error = error; queueMicrotask(() => this.onerror?.({ target: this })); }
}

class FakeObjectStore {
  constructor(store) { this._store = store; }

  delete(key) {
    const request = new FakeRequest();
    this._store.records.delete(key);
    request.succeed(true);
    return request;
  }

  openCursor() {
    const request = new FakeRequest();
    const entries = [...this._store.records.entries()];
    let index = 0;

    const step = () => {
      if (index >= entries.length) {
        request.result = null;
        queueMicrotask(() => request.onsuccess?.({ target: request }));
        return;
      }
      const [key, value] = entries[index];
      index += 1;
      request.result = { key, value, continue: step };
      queueMicrotask(() => request.onsuccess?.({ target: request }));
    };

    step();
    return request;
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    // Commit AFTER the request callbacks, exactly like the real thing.
    setTimeout(() => this.oncomplete?.(), 0);
  }

  objectStore(name) {
    const store = this.db._stores.get(name);
    if (!store) throw new Error(`No object store named ${name}`);
    return new FakeObjectStore(store);
  }

  abort() { setTimeout(() => this.onabort?.(), 0); }
}

class FakeDatabase {
  constructor() {
    this._stores = new Map();
    this.closed = false;
  }

  transaction(names) {
    // Mirror the real API: naming a store that does not exist throws.
    for (const name of names) {
      if (!this._stores.has(name)) throw new Error(`No object store named ${name}`);
    }
    return new FakeTransaction(this);
  }

  close() { this.closed = true; }
}

function createFakeIndexedDB({ stores = [QUEUE_STORE], blocked = false } = {}) {
  // The database exists BEFORE the worker opens it, so a test can seed a
  // backlog without first triggering an open.
  const db = new FakeDatabase();
  for (const storeName of stores) db._stores.set(storeName, { records: new Map() });

  const databases = new Map([['AflacProspectDB', db]]);

  return {
    open(name) {
      const request = new FakeRequest();

      queueMicrotask(() => {
        if (blocked) {
          request.onblocked?.();
          return;
        }
        request.result = db;
        request.onsuccess?.({ target: request });
      });

      return request;
    },
    _databases: databases
  };
}

// ---------------------------------------------------------------------
// WORKER HARNESS
// ---------------------------------------------------------------------

/**
 * Load public/sw.js into a fresh worker global.
 *
 * `records` is a map of storeName -> [values], seeded before any handler runs.
 */
function loadServiceWorker({ records = {}, fetchImpl, indexedDB = createFakeIndexedDB() } = {}) {
  const listeners = new Map();

  const self = {
    location: { origin: 'https://agency.example', href: 'https://agency.example/sw.js' },
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() }
  };

  const caches = {
    open: async () => ({ addAll: async () => {}, put: async () => {} }),
    keys: async () => [],
    delete: async () => true,
    match: async () => undefined
  };

  const sandbox = {
    self,
    caches,
    indexedDB,
    fetch: fetchImpl,
    FormData,
    Blob,
    Response,
    Request,
    Headers,
    URL,
    console,
    Promise,
    setTimeout,
    queueMicrotask,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Math,
    JSON,
    Error,
    TypeError,
    Date,
    RegExp
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'sw.js' });

  // Seed after the script ran so a drain sees a real backlog.
  const db = indexedDB._databases.get('AflacProspectDB');
  if (db) {
    for (const [storeName, values] of Object.entries(records)) {
      const store = db._stores.get(storeName);
      if (!store) continue;
      values.forEach((value, index) => store.records.set(index + 1, value));
    }
  }

  const emit = async (type, event) => {
    const handlers = listeners.get(type) || [];
    const waits = [];
    const scoped = { ...event, waitUntil: (promise) => waits.push(promise) };
    for (const handler of handlers) handler(scoped);
    await Promise.all(waits);
  };

  return {
    sandbox,
    listeners,
    emit,
    syncEvent: (tag = SYNC_TAG) => emit('sync', { tag }),
    indexedDB
  };
}

/** Values left in a store after a drain. */
function remaining(harness, storeName = QUEUE_STORE) {
  const db = harness.indexedDB._databases.get('AflacProspectDB');
  const store = db?._stores.get(storeName);
  return store ? [...store.records.values()] : [];
}

function audioRecord(over = {}) {
  return {
    type: 'voice_debrief',
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
    company_id: 'acct-1',
    mode: 'PHONE',
    timestamp: '2026-10-06T12:00:00.000Z',
    ...over
  };
}

const ok = (body = '{}') => new Response(body, { status: 200 });
const httpStatus = (code) => new Response('{}', { status: code });

// ---------------------------------------------------------------------
// LISTENER WIRING
// ---------------------------------------------------------------------

test('the worker registers a sync listener alongside the caching handlers', () => {
  const harness = loadServiceWorker({ fetchImpl: async () => ok() });

  assert.ok(harness.listeners.has('sync'), 'a sync listener must be installed');
  assert.deepEqual(
    [...harness.listeners.keys()].sort(),
    ['activate', 'fetch', 'install', 'sync']
  );
});

test('an unrelated sync tag does nothing', async () => {
  const calls = [];
  const harness = loadServiceWorker({
    fetchImpl: async (url) => { calls.push(String(url)); return ok(); },
    records: { [QUEUE_STORE]: [audioRecord()] }
  });

  await harness.syncEvent('some-other-tag');

  assert.equal(calls.length, 0, 'a tag this worker does not own must not be drained');
  assert.equal(remaining(harness, QUEUE_STORE).length, 1);
});

// ---------------------------------------------------------------------
// AUDIO DRAIN
// ---------------------------------------------------------------------

test('a 200 response uploads the debrief and deletes the record', async () => {
  const calls = [];
  const harness = loadServiceWorker({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return ok('{"success":true}');
    },
    records: { [QUEUE_STORE]: [audioRecord()] }
  });

  await harness.syncEvent();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/voice-debrief$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.body instanceof FormData, 'the voice endpoint takes multipart');
  assert.equal(calls[0].init.body.get('company_id'), 'acct-1');
  assert.equal(calls[0].init.body.get('mode'), 'PHONE');
  assert.ok(calls[0].init.body.get('audio'), 'the blob travels with the request');

  assert.equal(remaining(harness, QUEUE_STORE).length, 0, 'only a 200 may delete');
});

test('a 4xx deletes the record instead of retrying it forever', async () => {
  const harness = loadServiceWorker({
    fetchImpl: async () => httpStatus(422),
    records: { [QUEUE_STORE]: [audioRecord(), audioRecord()] }
  });

  await harness.syncEvent();

  assert.equal(remaining(harness, QUEUE_STORE).length, 0);
});

test('a 5xx keeps the record for the next wake-up', async () => {
  const harness = loadServiceWorker({
    fetchImpl: async () => httpStatus(503),
    records: { [QUEUE_STORE]: [audioRecord()] }
  });

  await harness.syncEvent();

  assert.equal(remaining(harness, QUEUE_STORE).length, 1, 'a server outage is not a rejection');
});

test('a network throw keeps the record', async () => {
  const harness = loadServiceWorker({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    records: { [QUEUE_STORE]: [audioRecord()] }
  });

  await harness.syncEvent();

  assert.equal(remaining(harness, QUEUE_STORE).length, 1);
});

test('a failure stops the walk so later records keep their FIFO position', async () => {
  let call = 0;
  const harness = loadServiceWorker({
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return ok();
      throw new TypeError('offline');
    },
    records: {
      [QUEUE_STORE]: [
        audioRecord({ company_id: 'first' }),
        audioRecord({ company_id: 'second' }),
        audioRecord({ company_id: 'third' })
      ]
    }
  });

  await harness.syncEvent();

  const left = remaining(harness, QUEUE_STORE);
  assert.equal(call, 2, 'the queue is not hammered after the first failure');
  assert.deepEqual(left.map((record) => record.company_id), ['second', 'third']);
});

test('a record with no blob is dropped rather than retried forever', async () => {
  const calls = [];
  const harness = loadServiceWorker({
    fetchImpl: async (url) => { calls.push(String(url)); return ok(); },
    records: { [QUEUE_STORE]: [audioRecord({ blob: null, audioBlob: null })] }
  });

  await harness.syncEvent();

  assert.equal(calls.length, 0, 'nothing to upload');
  assert.equal(remaining(harness, QUEUE_STORE).length, 0);
});

// ---------------------------------------------------------------------
// ACTION DRAIN
// ---------------------------------------------------------------------

test('a quick drop is POSTed as JSON and deleted on 200', async () => {
  const calls = [];
  const harness = loadServiceWorker({
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return ok(); },
    records: {
      [QUEUE_STORE]: [{
        type: 'quick_action',
        company_id: 'acct-1',
        disposition: 'GATEKEEPER_BLOCK',
        mode: 'FIELD',
        next_action: 'Try Tuesday',
        next_action_date: '2026-10-06'
      }]
    }
  });

  await harness.syncEvent();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/activity$/);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.disposition, 'GATEKEEPER_BLOCK');
  assert.equal(body.next_action, 'Try Tuesday');
  assert.equal(body.next_action_date, '2026-10-06');

  assert.equal(remaining(harness, QUEUE_STORE).length, 0);
});

test('one wake-up drains both outboxes', async () => {
  const urls = [];
  const harness = loadServiceWorker({
    fetchImpl: async (url) => { urls.push(String(url)); return ok(); },
    records: {
      [QUEUE_STORE]: [
        audioRecord(),
        { type: 'quick_action', company_id: 'acct-2', disposition: 'VM_NO_ANSWER', mode: 'PHONE' }
      ]
    }
  });

  await harness.syncEvent();

  assert.equal(urls.length, 2, 'a debrief behind a quick drop must not need a second wake-up');
  assert.ok(urls.some((url) => url.includes('/api/voice-debrief')));
  assert.ok(urls.some((url) => url.includes('/api/activity')));
  assert.equal(remaining(harness, QUEUE_STORE).length, 0);
});

test('an empty outbox is a no-op rather than an error', async () => {
  const calls = [];
  const harness = loadServiceWorker({
    fetchImpl: async (url) => { calls.push(String(url)); return ok(); },
    records: {}
  });

  await harness.syncEvent();

  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------
// DEGRADED ENVIRONMENTS
// ---------------------------------------------------------------------

test('a missing store is drained as empty rather than throwing', async () => {
  const calls = [];
  const harness = loadServiceWorker({
    fetchImpl: async (url) => { calls.push(String(url)); return ok(); },
    indexedDB: createFakeIndexedDB({ stores: [QUEUE_STORE] }),
    records: { [QUEUE_STORE]: [{ type: 'quick_action', company_id: 'acct-1', disposition: 'VM_NO_ANSWER', mode: 'PHONE' }] }
  });

  await harness.syncEvent();

  assert.equal(calls.length, 1, 'the store that exists is still drained');
});

test('a blocked database open does not reject the sync event', async () => {
  const harness = loadServiceWorker({
    fetchImpl: async () => ok(),
    indexedDB: createFakeIndexedDB({ blocked: true }),
    records: { [QUEUE_STORE]: [audioRecord()] }
  });

  await assert.doesNotReject(() => harness.syncEvent());
  assert.equal(remaining(harness, QUEUE_STORE).length, 1, 'nothing was lost');
});

test('a permanent 4xx failure never rejects the event', async () => {
  const harness = loadServiceWorker({
    fetchImpl: async () => httpStatus(400),
    records: { [QUEUE_STORE]: [audioRecord()] }
  });

  await assert.doesNotReject(() => harness.syncEvent());
  assert.equal(remaining(harness, QUEUE_STORE).length, 0);
});
