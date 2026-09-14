/**
 * Offline-first queue.
 *
 * Every activity is written to IndexedDB FIRST and pushed to the edge second.
 * That ordering is the whole point: an agent standing in a metal warehouse
 * with no bars must be able to log a visit and walk away.
 *
 * Audio rides along in the queue as a real Blob (IndexedDB stores those
 * natively — base64 would inflate it by a third for nothing) and is uploaded
 * whenever connectivity returns.
 */

import { $, showToast, apiPost } from './ui.js';

async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    const isPersisted = await navigator.storage.persist();
    console.log(`Storage persistence granted: ${isPersisted}`);
  }
}

const DB_NAME = 'AflacProspectDB';
const DB_VERSION = 2;
const STORE = 'queue';
const DOSSIER_STORE = 'dossiers';

let db = null;
const readyCallbacks = [];

/** Resolves once IndexedDB is open, or rejects if storage is unavailable. */
export const dbReady = new Promise((resolve, reject) => {
  readyCallbacks.push({ resolve, reject });
});

export async function initStore() {
  await requestPersistentStorage();

  // The retired roofing app's database is dead weight in the same origin.
  // Deleting it reclaims whatever queued door photos were left behind.
  try { indexedDB.deleteDatabase('SweatEquityDB'); } catch { /* best effort */ }

  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = (event) => {
    const upgradeDb = event.target.result;
    if (!upgradeDb.objectStoreNames.contains(STORE)) {
      const store = upgradeDb.createObjectStore(STORE, { keyPath: 'log_id' });
      store.createIndex('by_timestamp', 'timestamp');
    }
    if (!upgradeDb.objectStoreNames.contains(DOSSIER_STORE)) {
      upgradeDb.createObjectStore(DOSSIER_STORE, { keyPath: 'key' });
    }
  };

  request.onsuccess = (event) => {
    db = event.target.result;
    readyCallbacks.forEach((cb) => cb.resolve(db));
    updatePendingBadge();
    syncQueue();
  };

  request.onerror = (event) => {
    console.error('IndexedDB error:', event.target.error);
    showToast('Local storage unavailable — activity will not persist offline.', 'error');
    readyCallbacks.forEach((cb) => cb.reject(event.target.error));
  };
}

// ---------------------------------------------------------------------
// DOSSIER CACHING (Offline Intelligence)
// ---------------------------------------------------------------------

/**
 * Cache a pre-call enrichment dossier by company ID or normalized name.
 */
export function cacheDossier(key, dossierData) {
  return new Promise((resolve) => {
    if (!db || !key) return resolve();
    try {
      const tx = db.transaction([DOSSIER_STORE], 'readwrite');
      tx.objectStore(DOSSIER_STORE).put({
        key: String(key).toLowerCase().trim(),
        data: dossierData,
        cached_at: Date.now()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Retrieve cached pre-call dossier from IndexedDB.
 */
export function getCachedDossier(key) {
  return new Promise((resolve) => {
    if (!db || !key) return resolve(null);
    try {
      const tx = db.transaction([DOSSIER_STORE], 'readonly');
      const req = tx.objectStore(DOSSIER_STORE).get(String(key).toLowerCase().trim());
      req.onsuccess = () => resolve(req.result?.data || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------
// QUEUE OPERATIONS
// ---------------------------------------------------------------------

export function enqueue(entry) {
  if (!entry.log_id) {
    entry.log_id = crypto.randomUUID();
  }
  if (!entry.timestamp) {
    entry.timestamp = new Date().toISOString();
  }
  if (!entry.client_timestamp_utc) {
    entry.client_timestamp_utc = new Date().toISOString();
  }
  if (entry.sync_version === undefined || entry.sync_version === null) {
    entry.sync_version = 1;
  }
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('Local storage is still initializing'));
    let tx;
    try {
      tx = db.transaction([STORE], 'readwrite');
      tx.objectStore(STORE).put(entry);
    } catch (err) {
      return reject(err);
    }
    tx.oncomplete = () => {
      updatePendingBadge();
      resolve(entry.log_id);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export const addToQueue = enqueue;

function readAll() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const request = db.transaction([STORE], 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function remove(logId) {
  return new Promise((resolve) => {
    if (!db) return resolve();
    const tx = db.transaction([STORE], 'readwrite');
    tx.objectStore(STORE).delete(logId);
    tx.oncomplete = resolve;
    tx.onerror = resolve; // a failed delete just retries next cycle
  });
}

export function count() {
  return new Promise((resolve) => {
    if (!db) return resolve(0);
    const request = db.transaction([STORE], 'readonly').objectStore(STORE).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(0);
  });
}

export const getQueueCount = () => count();

// ---------------------------------------------------------------------
// STATUS DISPLAY
// ---------------------------------------------------------------------

export async function updatePendingBadge() {
  const pending = await count();
  const stuck = pending > 0
    ? (await getQueueDiagnostics()).filter((e) => e.stuck)
    : [];

  const label = stuck.length > 0 ? `${pending} Pending · ${stuck.length} stuck` : `${pending} Pending`;
  let className = 'sync-badge';
  if (pending > 0) className += ' pending';
  if (stuck.length > 0) className += ' stuck';

  for (const id of ['syncCount', 'syncCountDesktop']) {
    const badge = $(id);
    if (!badge) continue;
    badge.textContent = label;
    badge.className = className;
    badge.title = stuck.length > 0
      ? `Stuck: ${stuck.map((e) => `${e.label} (${e.last_error || 'unknown error'})`).join('; ')}`
      : 'Tap to push queued visits now';
  }
}

if (typeof window !== 'undefined') {
  window.updatePendingBadge = updatePendingBadge;
  window.addEventListener('aflac:sync-badge-update', () => {
    updatePendingBadge();
  });
}

/**
 * Make the pending badge do something.
 *
 * "A field visit is never lost" is only credible if the agent can verify it.
 * Tapping the badge forces a push and reports what actually happened, instead
 * of leaving him to trust a number that may not have moved in an hour.
 */
export function initQueueInspector() {
  for (const id of ['syncCount', 'syncCountDesktop']) {
    const badge = $(id);
    if (!badge) continue;
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');

    const run = async () => {
      const pending = await count();
      if (pending === 0) {
        showToast('Everything is synced.', 'success');
        return;
      }
      if (!navigator.onLine) {
        showToast(`${pending} visit${pending === 1 ? '' : 's'} held offline — they will send automatically.`, 'info');
        return;
      }
      showToast(`Pushing ${pending} queued visit${pending === 1 ? '' : 's'}…`, 'info');
      const drained = await forceSync();
      const stuck = (await getQueueDiagnostics()).filter((e) => e.stuck);
      if (stuck.length > 0) {
        showToast(`${drained} sent · ${stuck.length} stuck: ${stuck[0].label} — ${stuck[0].last_error || 'unknown error'}`, 'error');
      } else if (drained > 0) {
        showToast(`${drained} visit${drained === 1 ? '' : 's'} synced.`, 'success');
      } else {
        showToast('Still queued — will keep retrying.', 'info');
      }
    };

    badge.addEventListener('click', run);
    badge.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        run();
      }
    });
  }
}

export function updateNetworkStatus() {
  const online = navigator.onLine;
  for (const id of ['onlineStatus', 'onlineStatusDesktop']) {
    const node = $(id);
    if (!node) continue;
    node.textContent = online ? 'Status: Connected' : 'Status: Offline (queue active)';
    node.classList.toggle('is-online', online);
    node.classList.toggle('is-offline', !online);
  }
  if (online) syncQueue();
}

// ---------------------------------------------------------------------
// SYNC ENGINE
// ---------------------------------------------------------------------

// Guard against overlapping runs (the online event, a save, and init can all
// fire in the same tick). Set synchronously before the first await.
let isSyncing = false;

/**
 * How many times one entry may fail before it stops holding up the queue.
 *
 * Chronological order matters for exactly one reason: an activity log can
 * reference a company that a queued `company_creation` has not created yet.
 * It does NOT matter for correctness otherwise — every log carries its own
 * client timestamp and is idempotent on log_id.
 *
 * The old code `break`-ed on any transient failure, which meant one entry the
 * server kept 500-ing stranded every visit behind it, permanently, with the
 * agent seeing only a "12 Pending" badge and no way to act. That is the exact
 * failure CLAUDE.md rule 12 forbids. After this many tries an entry steps
 * aside and lets the rest through; it is never discarded.
 */
const MAX_ORDERED_ATTEMPTS = 4;

/** Backoff between automatic retry runs while anything is still queued. */
const RETRY_DELAYS_MS = [15000, 30000, 60000, 120000, 300000];
let consecutiveFailedRuns = 0;
let retryTimer = null;

/** Listeners notified after a successful drain, so open tables can refresh. */
const syncListeners = new Set();
export const onSynced = (callback) => syncListeners.add(callback);

function cancelRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/**
 * Keep trying on a timer, not only on events.
 *
 * `online` is not reliable on Android: moving off a captive portal, or a weak
 * signal flapping, often fires nothing at all. Without a timer a queue that
 * failed once could sit untouched until the agent happened to log again.
 */
function scheduleRetry() {
  cancelRetry();
  const delay = RETRY_DELAYS_MS[Math.min(consecutiveFailedRuns, RETRY_DELAYS_MS.length - 1)];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    syncQueue();
  }, delay);
}

/** Record a failed attempt on the entry itself so it survives a reload. */
async function noteAttempt(entry, error) {
  entry.attempts = (entry.attempts || 0) + 1;
  entry.last_error = String(error?.message || error || 'unknown').slice(0, 300);
  entry.last_attempt_at = Date.now();
  try {
    await enqueue(entry);
  } catch {
    /* the counter is an optimization; losing it only costs extra retries */
  }
  return entry.attempts;
}

/** What is stuck and why — so the agent can see it rather than trust a number. */
export async function getQueueDiagnostics() {
  const entries = await readAll();
  return entries
    .map((entry) => ({
      log_id: entry.log_id,
      label: entry.company?.company_name || entry.payload?.company_name || entry.company_name || 'Field log',
      timestamp: entry.timestamp,
      attempts: entry.attempts || 0,
      last_error: entry.last_error || null,
      stuck: (entry.attempts || 0) >= MAX_ORDERED_ATTEMPTS
    }))
    .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
}

/** Manual "push now" for the sync badge. Returns how many entries drained. */
export async function forceSync() {
  consecutiveFailedRuns = 0;
  cancelRetry();
  const drained = await syncQueue();
  try {
    const { flushAllQueues } = await import('./modules/state.js');
    if (typeof flushAllQueues === 'function') {
      await flushAllQueues();
    }
  } catch {
    /* state outbox flush best-effort */
  }
  await updatePendingBadge();
  return drained;
}

export async function syncQueue() {
  if (!navigator.onLine || !db || isSyncing) return 0;
  isSyncing = true;

  let drained = 0;
  let sawFailure = false;
  // Companies whose creation is still queued or deferred. Any activity log
  // naming one of these must wait, or the server would reject it for a missing
  // FK and we would discard a real field visit as a 4xx.
  const blockedCompanyIds = new Set();

  try {
    const entries = await readAll();
    if (entries.length === 0) return 0;

    entries.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

    for (const entry of entries) {
      const entryCompanyId = entry.company_id || entry.payload?.company_id || entry.company?.company_id;
      if (entryCompanyId && blockedCompanyIds.has(entryCompanyId)) continue;

      /**
       * One place decides what a failure means.
       *   4xx  -> the server will never accept this; discard and say so.
       *   else -> transient. Retry in order until MAX_ORDERED_ATTEMPTS, then
       *           step aside so the rest of the day's work can still land.
       * Returns true when the caller should stop draining entirely.
       */
      const handleFailure = async (err, what) => {
        if (err.status >= 400 && err.status < 500) {
          console.warn(`${what} rejected, discarding:`, err.message);
          showToast(`Could not sync "${entry.company?.company_name || entry.payload?.company_name || 'an entry'}" — ${err.message}`, 'error');
          await remove(entry.log_id);
          return false;
        }
        sawFailure = true;
        const attempts = await noteAttempt(entry, err);
        console.error(`${what} sync failed (attempt ${attempts}), will retry:`, err);
        if (attempts < MAX_ORDERED_ATTEMPTS) return true;  // order still worth preserving
        if (entry.type === 'company_creation' && entryCompanyId) {
          blockedCompanyIds.add(entryCompanyId);
        }
        return false;  // step aside, keep draining the rest
      };

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
          await apiPost('/api/companies/import', { companies: [payload] });
          await remove(entry.log_id);
          drained += 1;
          if (typeof window !== 'undefined' && window.syncChannel?.postMessage) {
            window.syncChannel.postMessage({
              type: 'CRM_UPDATE',
              company_id: payload.company_id
            });
          }
        } catch (err) {
          if (await handleFailure(err, 'Company creation')) break;
        }
      } else if (entry.type === 'voice_debrief') {
        try {
          const form = new FormData();
          const baseBlob = entry.blob || entry.audioBlob;
          const base = String(baseBlob?.type || '').split(';')[0].trim().toLowerCase();
          const stamp = String(entry.timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
          const ext = base.includes('ogg') ? 'ogg' : 'webm';
          form.append('audio', baseBlob, `debrief-${stamp}.${ext}`);
          if (entry.company_id) form.append('company_id', entry.company_id);
          if (entry.mode) form.append('mode', entry.mode);
          if (entry.timestamp) form.append('timestamp', entry.timestamp);

          const res = await fetch('/api/voice-debrief', { method: 'POST', body: form });
          if (!res.ok) {
            const error = new Error(`Voice debrief rejected (${res.status})`);
            error.status = res.status;
            throw error;
          }
          const result = await res.json().catch(() => ({}));
          await remove(entry.log_id);
          drained += 1;
          if (typeof window !== 'undefined' && window.syncChannel?.postMessage) {
            window.syncChannel.postMessage({
              type: 'CRM_UPDATE',
              company_id: entry.company_id
            });
          }
          window.dispatchEvent(new CustomEvent('voicelogged', { detail: result }));
        } catch (err) {
          if (await handleFailure(err, 'Voice debrief')) break;
        }
      } else if (entry.type === 'quick_action') {
        try {
          const res = await fetch('/api/activity', {
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
          if (!res.ok) {
            const error = new Error(`Quick action rejected (${res.status})`);
            error.status = res.status;
            throw error;
          }
          await remove(entry.log_id);
          drained += 1;
          if (typeof window !== 'undefined' && window.syncChannel?.postMessage) {
            window.syncChannel.postMessage({
              type: 'CRM_UPDATE',
              company_id: entry.company_id,
              disposition: entry.disposition
            });
          }
        } catch (err) {
          if (await handleFailure(err, 'Quick action')) break;
        }
      } else if (entry.audioBlob) {
        try {
          const result = await uploadVoiceLog(entry);
          await remove(entry.log_id);
          drained += 1;
          if (typeof window !== 'undefined' && window.syncChannel?.postMessage) {
            window.syncChannel.postMessage({
              type: 'CRM_UPDATE',
              company_id: result.company_id || entry.company_id || entry.company?.company_id,
              stage: result.stage || null,
              disposition: result.disposition || entry.manual_disposition
            });
          }
          window.dispatchEvent(new CustomEvent('voicelogged', { detail: result }));
          if (result.degraded && !result.transcript) {
            showToast(`Logged "${entry.company?.company_name || 'activity'}" — transcription unavailable.`, 'info');
          }
        } catch (err) {
          if (await handleFailure(err, 'Voice log')) break;
        }
      } else {
        try {
          const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ logs: [toSyncPayload(entry)] })
          });
          if (!res.ok) {
            const error = new Error(`Sync rejected (${res.status})`);
            error.status = res.status;
            throw error;
          }
          const result = await res.json();

          for (const logId of result.accepted || []) {
            await remove(logId);
            drained += 1;
            if (typeof window !== 'undefined' && window.syncChannel?.postMessage) {
              window.syncChannel.postMessage({
                type: 'CRM_UPDATE',
                company_id: entry.company_id || entry.company?.company_id,
                stage: null,
                disposition: entry.manual_disposition || entry.disposition
              });
            }
          }
          for (const rejection of result.rejected || []) {
            console.warn('Server rejected log:', rejection);
            showToast(`Discarded an invalid entry — ${rejection.reason}`, 'error');
            if (rejection.log_id) await remove(rejection.log_id);
          }
        } catch (err) {
          if (await handleFailure(err, 'Batch')) break;
        }
      }
    }
  } catch (err) {
    console.error('Sync run failed:', err);
    sawFailure = true;
  } finally {
    isSyncing = false;
    await updatePendingBadge();
    if (drained > 0) syncListeners.forEach((cb) => cb(drained));

    consecutiveFailedRuns = sawFailure ? consecutiveFailedRuns + 1 : 0;
    // Anything left in the queue gets another attempt on a timer, whether or
    // not the browser ever tells us the network came back.
    const remaining = await count();
    if (remaining > 0 && navigator.onLine) scheduleRetry();
    else cancelRetry();
  }

  return drained;
}

/** Strip client-only fields before the log crosses the wire. */
function toSyncPayload(entry) {
  const { audioBlob, audioType, attempts, last_error, last_attempt_at, ...rest } = entry;
  return rest;
}

async function uploadVoiceLog(entry) {
  const form = new FormData();
  const extension = (entry.audioType || '').includes('ogg') ? 'ogg' : 'webm';
  form.append('audio', entry.audioBlob, `journal-${entry.log_id}.${extension}`);
  form.append('is_in_person', String(entry.is_in_person));
  form.append('is_initial', String(entry.is_initial));
  form.append('is_dm_contact', String(entry.is_dm_contact));
  form.append('log_id', entry.log_id);
  form.append('timestamp', entry.timestamp);
  if (entry.company_id) form.append('company_id', entry.company_id);
  if (entry.contact_id) form.append('contact_id', entry.contact_id);
  if (entry.manual_disposition) form.append('manual_disposition', entry.manual_disposition);
  if (entry.company) {
    const compStr = typeof entry.company === 'string' ? entry.company : JSON.stringify(entry.company);
    form.append('company', compStr);
  }

  const res = await fetch('/api/transcribe-and-log', {
    method: 'POST',
    body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Upload failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}

export function initConnectivityWatch() {
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
  // Returning to the app is the single most reliable "we probably have signal
  // again" signal on Android — far more so than the online event.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncQueue();
  });
  initQueueInspector();
  updateNetworkStatus();
}
