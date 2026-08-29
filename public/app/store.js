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

import { $, showToast } from './ui.js';

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

export function initStore() {
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
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('Local storage is still initializing'));
    let tx;
    try {
      tx = db.transaction([STORE], 'readwrite');
      tx.objectStore(STORE).put(entry);
    } catch (err) {
      return reject(err);
    }
    tx.oncomplete = () => resolve(entry.log_id);
    tx.onerror = () => reject(tx.error);
  });
}

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

function count() {
  return new Promise((resolve) => {
    if (!db) return resolve(0);
    const request = db.transaction([STORE], 'readonly').objectStore(STORE).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(0);
  });
}

// ---------------------------------------------------------------------
// STATUS DISPLAY
// ---------------------------------------------------------------------

export async function updatePendingBadge() {
  const pending = await count();
  const label = `${pending} Pending`;
  const className = pending > 0 ? 'sync-badge pending' : 'sync-badge';
  for (const id of ['syncCount', 'syncCountDesktop']) {
    const badge = $(id);
    if (badge) {
      badge.textContent = label;
      badge.className = className;
    }
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

/** Listeners notified after a successful drain, so open tables can refresh. */
const syncListeners = new Set();
export const onSynced = (callback) => syncListeners.add(callback);

export async function syncQueue() {
  if (!navigator.onLine || !db || isSyncing) return;
  isSyncing = true;

  let drained = 0;
  try {
    const entries = await readAll();
    if (entries.length === 0) return;

    const withAudio = entries.filter((e) => e.audioBlob);
    const plain = entries.filter((e) => !e.audioBlob);

    // Voice journals go one at a time — each is a multipart upload plus two
    // model calls, and batching them would blow the request timeout.
    for (const entry of withAudio) {
      try {
        const result = await uploadVoiceLog(entry);
        await remove(entry.log_id);
        drained += 1;
        // The field view fills in the transcript if the agent is still looking
        // at the entry they just logged.
        window.dispatchEvent(new CustomEvent('voicelogged', { detail: result }));
        if (result.degraded && !result.transcript) {
          showToast(`Logged "${entry.company?.company_name || 'activity'}" — transcription unavailable.`, 'info');
        }
      } catch (err) {
        if (err.status >= 400 && err.status < 500) {
          // The server will never accept this record. Retrying forever would
          // wedge the queue behind it.
          console.warn('Voice log rejected, discarding:', err.message);
          showToast(`Could not sync a voice log — ${err.message}`, 'error');
          await remove(entry.log_id);
        } else {
          console.error('Voice log sync failed, will retry:', err);
        }
      }
    }

    // Silent logs batch cleanly.
    for (let i = 0; i < plain.length; i += 50) {
      const batch = plain.slice(i, i + 50);
      try {
        const res = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs: batch.map(toSyncPayload) })
        });
        if (!res.ok) throw new Error(`Sync rejected (${res.status})`);
        const result = await res.json();

        for (const logId of result.accepted || []) {
          await remove(logId);
          drained += 1;
        }
        for (const rejection of result.rejected || []) {
          console.warn('Server rejected log:', rejection);
          showToast(`Discarded an invalid entry — ${rejection.reason}`, 'error');
          if (rejection.log_id) await remove(rejection.log_id);
        }
      } catch (err) {
        console.error('Batch sync failed, will retry:', err);
      }
    }
  } catch (err) {
    console.error('Sync run failed:', err);
  } finally {
    isSyncing = false;
    await updatePendingBadge();
    if (drained > 0) syncListeners.forEach((cb) => cb(drained));
  }
}

/** Strip client-only fields before the log crosses the wire. */
function toSyncPayload(entry) {
  const { audioBlob, audioType, ...rest } = entry;
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
  if (entry.company) form.append('company', JSON.stringify(entry.company));

  const res = await fetch('/api/transcribe-and-log', { method: 'POST', body: form });
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
  updateNetworkStatus();
}
