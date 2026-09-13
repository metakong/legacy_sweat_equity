// Bump on every change to precached asset contents or this file's logic.
const CACHE_NAME = 'aflac-prospect-v11';

// Background Sync tag. Must match SYNC_TAG in public/app/modules/state.js —
// the page registers this tag and this listener is the only thing that answers.
const SYNC_TAG = 'sync-agency-outbox';

// Copied from state.js deliberately. A Service Worker is a separate global
// with no import map into the page's module graph, so it cannot import those
// constants; they are duplicated here under test coverage instead.
const DB_NAME = 'AgencyOS_DB';
const DB_VERSION = 2;
const AUDIO_STORE = 'audio_outbox';
const ACTION_STORE = 'action_outbox';
const VOICE_DEBRIEF_URL = '/api/voice-debrief';
const ACTIVITY_URL = '/api/activity';

// Same-origin app shell — install fails if any of these are missing.
// These are native ES modules; each one is a separate request, so each one
// has to be listed.
const CORE_ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/app.js',
  '/app/ui.js',
  '/app/store.js',
  '/app/field.js',
  '/app/d365.js',
  '/app/markdown.js',
  '/app/desktop.js',
  '/app/pipeline.js',
  '/app/modules/state.js',
  '/app/modules/audio.js',
  '/app/modules/navigation.js',
  '/app/modules/voice-widget.js',
  '/app/modules/dialer-view.js',
  '/app/modules/canvass-view.js',
  '/app/modules/triage-view.js',
  '/app/modules/d365-export.js',
  '/app/app.css',
  '/manifest.json',
  '/icon.jpg'
];

// CDN assets needed for full offline field use — best-effort precache.
// SheetJS is deliberately absent: it is ~950KB, desktop-only, and lazily
// loaded, so the runtime cache below picks it up after first use instead of
// making every phone pay for it on install.
const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // CDN precache is best-effort: an unpkg hiccup must not block install
      cache.addAll(CDN_ASSETS).catch((err) => console.warn('CDN precache skipped:', err));
      return cache.addAll(CORE_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate
self.addEventListener('fetch', (e) => {
  const { request } = e;

  // Only GETs are cacheable — let POST /api/sync etc. hit the network directly
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never serve API reads from cache. A stale activity list would show an
  // agent yesterday's pipeline as though it were today's.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  e.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        // Cache good responses, including opaque ones from CDNs (status 0)
        if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => { /* quota or scheme errors are non-fatal */ });
        }
        return networkResponse;
      }).catch(async () => {
        // Offline fallback. Only navigations get the app shell — returning HTML
        // for a failed stylesheet, script, or image request just swaps a clean
        // network error for a confusing MIME-type error.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/app/');
          if (shell) return shell;
        }
        return Response.error();
      });

      return cachedResponse || fetchPromise;
    })
  );
});

// ---------------------------------------------------------------------
// BACKGROUND SYNC — drain both outboxes with no page open
// ---------------------------------------------------------------------

/**
 * Open AgencyOS_DB without upgrading it.
 *
 * The version is pinned to 2 to match state.js. The upgrade callback below is
 * the guard that matters: a Service Worker that silently created an empty
 * database would strand every queued capture in the real store, so reaching an
 * upgrade here aborts the open instead of writing anything.
 */
function openOutboxDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable in this Service Worker'));
      return;
    }

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    // Never create stores here: an upgrade is the page's job, and there is
    // nothing to drain from a database that does not exist yet.
    request.onupgradeneeded = () => {
      try {
        request.transaction?.abort();
      } catch { /* already gone */ }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('AgencyOS_DB open failed'));
    request.onblocked = () => reject(new Error('AgencyOS_DB open blocked'));
  });
}

/** Read every record from one store. A missing store resolves to []. */
function readAll(db, storeName) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([storeName], 'readonly');
    } catch {
      // The store does not exist — nothing to drain, not an error.
      resolve([]);
      return;
    }

    const records = [];
    const request = tx.objectStore(storeName).openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      // The terminal callback (cursor === null) is NOT the end of the read:
      // IndexedDB guarantees the transaction commits after the last cursor
      // step, so resolving here would return a half-read list. The commit below
      // is the only correct place to resolve.
      if (!cursor) return;
      records.push({ key: cursor.key, value: cursor.value });
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error(`${storeName} read failed`));
    tx.oncomplete = () => resolve(records);
    tx.onerror = () => reject(tx.error || new Error(`${storeName} read failed`));
    tx.onabort = () => reject(tx.error || new Error(`${storeName} read aborted`));
  });
}

/** Delete one record and resolve only once the transaction commits. */
function deleteRecord(db, storeName, key) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([storeName], 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error(`${storeName} delete failed`));
    tx.onabort = () => reject(tx.error || new Error(`${storeName} delete aborted`));
  });
}

/** Rebuild the multipart body the voice endpoint expects. */
function audioFormData(record) {
  const form = new FormData();
  const blob = record?.blob;
  if (!blob) return null;

  form.append('audio', blob, `offline-${record?.timestamp || Date.now()}.webm`);
  if (record?.company_id) form.append('company_id', record.company_id);
  if (record?.mode) form.append('mode', record.mode);
  return form;
}

/**
 * POST one audio capture. Resolves 'sent' | 'rejected' | 'failed'.
 *
 * A 4xx is terminal: the server will answer the same way forever (a suppressed
 * account, a malformed payload), and retrying it would wedge every later
 * capture behind it. A 5xx or a throw is transient, so the record stays.
 */
async function postAudio(record) {
  const form = audioFormData(record);
  if (!form) return 'rejected';

  try {
    const response = await fetch(VOICE_DEBRIEF_URL, { method: 'POST', body: form });
    if (response.status === 200) return 'sent';
    if (response.status >= 400 && response.status < 500) return 'rejected';
    return 'failed';
  } catch {
    return 'failed';
  }
}

/** POST one quick drop. Same status contract as postAudio. */
async function postAction(record) {
  try {
    const response = await fetch(ACTIVITY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    });
    if (response.status === 200) return 'sent';
    if (response.status >= 400 && response.status < 500) return 'rejected';
    return 'failed';
  } catch {
    return 'failed';
  }
}

/** Walk one store, POSTing each record and removing what the server accepted. */
async function drainStore(db, storeName, post) {
  const records = await readAll(db, storeName);
  const summary = { attempted: 0, sent: 0, rejected: 0, failed: 0 };

  for (const entry of records) {
    summary.attempted += 1;
    const outcome = await post(entry.value);

    if (outcome === 'failed') {
      summary.failed += 1;
      // Preserve FIFO: a later record may depend on an earlier one landing, and
      // hammering a dead connection with the rest of the queue only burns the
      // browser's short sync budget.
      break;
    }

    // 'sent' and 'rejected' both mean "stop trying this one".
    try {
      await deleteRecord(db, storeName, entry.key);
    } catch {
      summary.failed += 1;
      continue;
    }

    if (outcome === 'sent') summary.sent += 1;
    else summary.rejected += 1;
  }

  return summary;
}

/**
 * Drain both outboxes. Never rejects — a rejected sync event would make the
 * browser retry the tag with the same records, which is precisely the loop the
 * 'failed' handling above exists to avoid.
 */
async function drainOutbox() {
  let db = null;
  try {
    db = await openOutboxDatabase();
  } catch {
    return { audio: null, action: null };
  }

  try {
    return {
      audio: await drainStore(db, AUDIO_STORE, postAudio),
      action: await drainStore(db, ACTION_STORE, postAction)
    };
  } catch {
    return { audio: null, action: null };
  } finally {
    try {
      db.close();
    } catch { /* already closing */ }
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  // waitUntil keeps the worker alive until the drain finishes; without it the
  // browser is free to terminate the worker mid-upload.
  event.waitUntil(drainOutbox());
});

