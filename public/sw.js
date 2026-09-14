// Bump on every change to precached asset contents or this file's logic.
const CACHE_NAME = 'aflac-prospect-v11';

// Background Sync tag. Must match SYNC_TAG in public/app/modules/state.js —
// the page registers this tag and this listener is the only thing that answers.
const SYNC_TAG = 'sync-agency-outbox';

// Service Worker targeting unified AflacProspectDB queue
const DB_NAME = 'AflacProspectDB';
const DB_VERSION = 2;
const QUEUE_STORE = 'queue';
const VOICE_DEBRIEF_URL = '/api/voice-debrief';
const ACTIVITY_URL = '/api/activity';
const SYNC_URL = '/api/sync';

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
 * Open AflacProspectDB without upgrading it.
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

    request.onupgradeneeded = () => {
      try {
        request.transaction?.abort();
      } catch { /* already gone */ }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('AflacProspectDB open failed'));
    request.onblocked = () => reject(new Error('AflacProspectDB open blocked'));
  });
}

/** Read all entries from the queue store. */
function readQueue(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([QUEUE_STORE], 'readonly');
    } catch {
      resolve([]);
      return;
    }

    const records = [];
    const request = tx.objectStore(QUEUE_STORE).openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      records.push({ key: cursor.key, value: cursor.value });
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('queue read failed'));
    tx.oncomplete = () => resolve(records);
    tx.onerror = () => reject(tx.error || new Error('queue read failed'));
    tx.onabort = () => reject(tx.error || new Error('queue read aborted'));
  });
}

/** Delete one record from queue by log_id/key. */
function deleteQueueRecord(db, key) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([QUEUE_STORE], 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    tx.objectStore(QUEUE_STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('queue delete failed'));
    tx.onabort = () => reject(tx.error || new Error('queue delete aborted'));
  });
}

async function postQueueEntry(entry) {
  if (entry.type === 'company_creation') {
    try {
      const payload = entry.payload || {
        company_id: entry.company_id,
        company_name: entry.company_name,
        lat: entry.lat,
        long: entry.long ?? entry.lng,
        street_1: entry.street_1,
        city: entry.city,
        state: entry.state,
        zip_code: entry.zip_code
      };
      const res = await fetch('/api/companies/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: [payload] })
      });
      if (res.status === 200) return 'sent';
      if (res.status >= 400 && res.status < 500) return 'rejected';
      return 'failed';
    } catch {
      return 'failed';
    }
  } else if (entry.type === 'voice_debrief' || entry.audioBlob || entry.blob) {
    try {
      const form = new FormData();
      const baseBlob = entry.blob || entry.audioBlob;
      if (!baseBlob) return 'rejected';
      const base = String(baseBlob?.type || '').split(';')[0].trim().toLowerCase();
      const stamp = String(entry.timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
      const ext = base.includes('ogg') ? 'ogg' : 'webm';

      if (entry.type === 'voice_debrief') {
        form.append('audio', baseBlob, `debrief-${stamp}.${ext}`);
        if (entry.company_id) form.append('company_id', entry.company_id);
        if (entry.mode) form.append('mode', entry.mode);
        if (entry.timestamp) form.append('timestamp', entry.timestamp);
        const res = await fetch(VOICE_DEBRIEF_URL, { method: 'POST', body: form });
        if (res.status === 200) return 'sent';
        if (res.status >= 400 && res.status < 500) return 'rejected';
        return 'failed';
      } else {
        form.append('audio', baseBlob, `journal-${entry.log_id || stamp}.${ext}`);
        form.append('is_in_person', String(entry.is_in_person ?? 1));
        form.append('is_initial', String(entry.is_initial ?? 1));
        form.append('is_dm_contact', String(entry.is_dm_contact ?? 0));
        if (entry.log_id) form.append('log_id', entry.log_id);
        if (entry.timestamp) form.append('timestamp', entry.timestamp);
        if (entry.company_id) form.append('company_id', entry.company_id);
        if (entry.contact_id) form.append('contact_id', entry.contact_id);
        if (entry.manual_disposition) form.append('manual_disposition', entry.manual_disposition);
        if (entry.company) {
          const compStr = typeof entry.company === 'string' ? entry.company : JSON.stringify(entry.company);
          form.append('company', compStr);
        }
        const res = await fetch('/api/transcribe-and-log', { method: 'POST', body: form });
        if (res.status === 200) return 'sent';
        if (res.status >= 400 && res.status < 500) return 'rejected';
        return 'failed';
      }
    } catch {
      return 'failed';
    }
  } else if (entry.type === 'quick_action') {
    try {
      const res = await fetch(ACTIVITY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: entry.company_id,
          disposition: entry.disposition,
          mode: entry.mode,
          next_action: entry.next_action,
          next_action_date: entry.next_action_date,
          timestamp: entry.timestamp
        })
      });
      if (res.status === 200) return 'sent';
      if (res.status >= 400 && res.status < 500) return 'rejected';
      return 'failed';
    } catch {
      return 'failed';
    }
  } else {
    try {
      const { audioBlob, audioType, attempts, last_error, last_attempt_at, ...payload } = entry;
      const res = await fetch(SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: [payload] })
      });
      if (res.status === 200) return 'sent';
      if (res.status >= 400 && res.status < 500) return 'rejected';
      return 'failed';
    } catch {
      return 'failed';
    }
  }
}

/** Drain AflacProspectDB queue store. */
async function drainOutbox() {
  let db = null;
  try {
    db = await openOutboxDatabase();
  } catch {
    return { attempted: 0, sent: 0, failed: 0 };
  }

  if (!db) return { attempted: 0, sent: 0, failed: 0 };

  const summary = { attempted: 0, sent: 0, rejected: 0, failed: 0 };

  try {
    const records = await readQueue(db);
    records.sort((a, b) => new Date(a.value?.timestamp || 0) - new Date(b.value?.timestamp || 0));

    for (const item of records) {
      summary.attempted += 1;
      const outcome = await postQueueEntry(item.value);
      if (outcome === 'failed') {
        summary.failed += 1;
        break; // preserve FIFO order on network/transient failure
      }
      try {
        await deleteQueueRecord(db, item.key);
      } catch {
        summary.failed += 1;
        continue;
      }
      if (outcome === 'sent') summary.sent += 1;
      else summary.rejected += 1;
    }
  } catch (err) {
    console.warn('Background sync queue drain error:', err);
  } finally {
    try { db.close(); } catch {}
  }
  return summary;
}

self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(drainOutbox());
});

