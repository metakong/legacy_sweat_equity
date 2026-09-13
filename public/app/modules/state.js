/**
 * Agency OS — reactive state and the offline audio outbox.
 *
 * Two responsibilities, deliberately in one file so a module that reads state
 * also owns the queue that state feeds:
 *
 *   1. A tiny pub-sub store holding the active workspace (PHONE | FIELD |
 *      TRIAGE). Views subscribe; the store never reaches into the DOM.
 *   2. An IndexedDB outbox for voice captures. A debrief recorded in a metal
 *      warehouse with no bars is written here FIRST and uploaded when signal
 *      returns. That ordering is the entire point.
 *
 * Nothing at module scope touches window, document, localStorage or
 * indexedDB, so this file imports cleanly under Node for its own tests.
 */

export const MODES = ['PHONE', 'FIELD', 'TRIAGE'];

const DEFAULT_MODE = 'FIELD';
const MODE_STORAGE_KEY = 'agency_os_mode';

/** Fired on window whenever the store changes. */
export const STATE_CHANGE_EVENT = 'agency-os:statechange';

export const AUDIO_DB_NAME = 'AgencyOS_DB';
// Bumped to 2 when the action outbox landed. An existing v1 database upgrades in
// place — onupgradeneeded creates only the store that is missing — so a phone
// that has not been reopened since Sprint 3 keeps every queued capture.
export const AUDIO_DB_VERSION = 2;
export const AUDIO_STORE = 'audio_outbox';
/** JSON-only queue for quick drops that never reached the network. */
export const ACTION_STORE = 'action_outbox';
export const VOICE_DEBRIEF_URL = '/api/voice-debrief';
export const ACTIVITY_URL = '/api/activity';

// ---------------------------------------------------------------------
// STORAGE GUARDS
// ---------------------------------------------------------------------

/**
 * localStorage throws on ACCESS in some privacy modes rather than on write, so
 * every touch of it is wrapped. A blocked store must never take down the app.
 */
function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readStoredMode() {
  try {
    const saved = storage()?.getItem(MODE_STORAGE_KEY);
    return MODES.includes(saved) ? saved : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

function persistMode(mode) {
  try {
    storage()?.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* a preference that cannot be saved is not worth failing a mode switch */
  }
}

// ---------------------------------------------------------------------
// PUB-SUB STORE
// ---------------------------------------------------------------------

let state = Object.freeze({ mode: readStoredMode() });
const listeners = new Set();

export function getState() {
  return state;
}

/**
 * Register a listener. Returns the unsubscribe function, which is the part
 * people forget to keep — a view that never unsubscribes keeps rendering into
 * a detached DOM after a mode switch.
 */
export function subscribe(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('subscribe requires a listener function');
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Merge a partial update into the store.
 *
 * Subscribers receive both snapshots plus the changed keys, so a view can
 * ignore an update it does not care about instead of re-rendering the world.
 */
export function setState(partial = {}) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new TypeError('setState requires an object');
  }

  if (partial.mode !== undefined && !MODES.includes(partial.mode)) {
    throw new RangeError(`mode must be one of ${MODES.join(', ')}`);
  }

  const next = { ...state, ...partial };
  const changedKeys = Object.keys(next).filter((key) => next[key] !== state[key]);
  if (changedKeys.length === 0) return state;

  const previousState = state;
  state = Object.freeze(next);

  if (changedKeys.includes('mode')) persistMode(state.mode);

  const detail = { state, previousState, changedKeys };
  dispatchStateChange(detail);

  for (const listener of [...listeners]) {
    try {
      listener(detail);
    } catch (err) {
      // One broken view must not stop the others from updating.
      console.error('Agency OS state listener failed:', err);
    }
  }

  return state;
}

function dispatchStateChange(detail) {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    if (typeof CustomEvent === 'undefined') return;
    window.dispatchEvent(new CustomEvent(STATE_CHANGE_EVENT, { detail }));
  } catch {
    /* a missing event bus must not block the state change itself */
  }
}

// ---------------------------------------------------------------------
// AUDIO OUTBOX (IndexedDB)
// ---------------------------------------------------------------------

let dbPromise = null;

function idbFactory() {
  try {
    return typeof indexedDB !== 'undefined' ? indexedDB : null;
  } catch {
    return null;
  }
}

/**
 * Open (and on first run create) the Agency OS database.
 *
 * The object stores are created with autoIncrement and NO keyPath, so records
 * are out-of-line and the generated key is the queue position. A keyPath would
 * put the key inside the record, and a cursor would then be unable to tell two
 * identical debriefs — or two identical quick drops — apart.
 */
export function openAgencyDatabase() {
  if (dbPromise) return dbPromise;

  const factory = idbFactory();
  if (!factory) {
    return Promise.reject(new Error('IndexedDB is unavailable in this environment'));
  }

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Both stores, each guarded: an upgrade from v1 must add the action queue
      // without disturbing the captures already in the audio queue.
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(ACTION_STORE)) {
        db.createObjectStore(ACTION_STORE, { autoIncrement: true });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  }).catch((err) => {
    // Let the next call retry rather than caching a transient failure forever.
    dbPromise = null;
    throw err;
  });

  return dbPromise;
}

/** Drop the cached handle. Used by tests and by a hard sign-out. */
export function closeAgencyDatabase() {
  const pending = dbPromise;
  dbPromise = null;
  return pending
    ? pending.then((db) => { try { db.close(); } catch { /* already closed */ } }).catch(() => {})
    : Promise.resolve();
}

function isBlobLike(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  return typeof value.size === 'number' && typeof value.type === 'string';
}

function normalizeCompanyId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeTimestamp(value) {
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Write one capture to the outbox.
 *
 * Resolves only after the transaction commits, so a UI that says "saved
 * offline" is not lying when the tab is closed a moment later.
 */
export async function enqueueAudio(blob, metadata = {}) {
  if (!isBlobLike(blob) || blob.size === 0) {
    throw new TypeError('enqueueAudio requires a non-empty Blob');
  }

  const record = Object.freeze({
    blob,
    company_id: normalizeCompanyId(metadata?.company_id),
    mode: MODES.includes(metadata?.mode) ? metadata.mode : getState().mode,
    timestamp: normalizeTimestamp(metadata?.timestamp)
  });

  const db = await openAgencyDatabase();

  return new Promise((resolve, reject) => {
    let key = null;
    let tx;
    try {
      tx = db.transaction([AUDIO_STORE], 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    const request = tx.objectStore(AUDIO_STORE).add(record);
    request.onsuccess = () => { key = request.result; };
    tx.oncomplete = () => resolve({ key, record });
    tx.onerror = () => reject(tx.error || new Error('audio_outbox write failed'));
    tx.onabort = () => reject(tx.error || new Error('audio_outbox write aborted'));
  });
}

function readOutbox(db, storeName = AUDIO_STORE) {
  return new Promise((resolve, reject) => {
    const records = [];
    let tx;
    try {
      tx = db.transaction([storeName], 'readonly');
    } catch (err) {
      reject(err);
      return;
    }

    const request = tx.objectStore(storeName).openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      records.push({ key: cursor.key, value: cursor.value });
      cursor.continue();
    };
    tx.oncomplete = () => resolve(records);
    tx.onerror = () => reject(tx.error || new Error(`${storeName} read failed`));
  });
}

function deleteRecord(db, key, storeName = AUDIO_STORE) {
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
  });
}

const AUDIO_EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/flac': 'flac'
};

/**
 * Build the multipart body for one queued capture.
 *
 * Content-Type is deliberately NOT set on the request: the browser has to
 * append the multipart boundary itself, and naming the type by hand produces a
 * body the Worker rejects as "Expected multipart/form-data".
 */
export function buildVoiceDebriefForm(record) {
  const form = new FormData();
  const base = String(record?.blob?.type || '').split(';')[0].trim().toLowerCase();
  const stamp = String(record?.timestamp || new Date().toISOString()).replace(/[:.]/g, '-');

  form.append('audio', record.blob, `debrief-${stamp}.${AUDIO_EXTENSIONS[base] || 'webm'}`);
  if (record?.company_id) form.append('company_id', record.company_id);
  form.append('mode', MODES.includes(record?.mode) ? record.mode : DEFAULT_MODE);
  if (record?.timestamp) form.append('timestamp', record.timestamp);

  return form;
}

export async function getAudioQueueCount() {
  const db = await openAgencyDatabase().catch(() => null);
  if (!db) return 0;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([AUDIO_STORE], 'readonly');
      const request = tx.objectStore(AUDIO_STORE).count();
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

let flushInFlight = null;

/**
 * Drain the outbox. Overlapping calls (an `online` event landing on top of a
 * manual push) share ONE run, so a record is never uploaded twice.
 */
export function flushAudioQueue(options = {}) {
  if (flushInFlight) return flushInFlight;
  flushInFlight = runFlush(options).finally(() => { flushInFlight = null; });
  return flushInFlight;
}

async function runFlush({ fetchImpl } = {}) {
  const summary = { attempted: 0, sent: 0, failed: 0, remaining: 0 };
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return summary;

  const db = await openAgencyDatabase().catch(() => null);
  if (!db) return summary;

  const records = await readOutbox(db).catch(() => []);
  if (records.length === 0) return summary;

  for (const entry of records) {
    summary.attempted += 1;
    try {
      const response = await doFetch(VOICE_DEBRIEF_URL, {
        method: 'POST',
        body: buildVoiceDebriefForm(entry.value)
      });

      if (response && response.status === 200) {
        await deleteRecord(db, entry.key);
        summary.sent += 1;
      } else {
        // Any non-200 leaves the record queued. The server not being able to use
        // the audio right now is not a reason to destroy the only copy of a
        // field visit.
        summary.failed += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }

  summary.remaining = (await readOutbox(db).catch(() => [])).length;
  return summary;
}

let onlineHandler = null;

// ---------------------------------------------------------------------
// ACTION OUTBOX (JSON quick drops)
//
// A quick drop is one tap between calls. When the tower is gone the tap must
// still count: the agent has already hung up and is dialing the next number, and
// a disposition that only exists in a toast is a dial lost. So the payload goes
// to IndexedDB and the dialer moves on.
//
// No blob here, unlike the audio queue: this is a few hundred bytes of JSON, so
// it is cheap enough to write on every tap and to replay by the dozen.
// ---------------------------------------------------------------------

/**
 * Queue one quick-drop disposition for later delivery.
 *
 * @param {{company_id: string, disposition: string, mode?: string, timestamp?: string}} payload
 * @returns {Promise<{key: number, record: object}>}
 */
export async function enqueueAction(payload = {}) {
  const companyId = normalizeCompanyId(payload?.company_id);
  if (!companyId) throw new TypeError('enqueueAction requires a company_id');

  const disposition = typeof payload?.disposition === 'string' ? payload.disposition.trim().toUpperCase() : '';
  if (!disposition) throw new TypeError('enqueueAction requires a disposition');

  const record = Object.freeze({
    company_id: companyId,
    disposition,
    mode: MODES.includes(payload?.mode) ? payload.mode : getState().mode,
    timestamp: normalizeTimestamp(payload?.timestamp)
  });

  const db = await openAgencyDatabase();

  return new Promise((resolve, reject) => {
    let key = null;
    let tx;
    try {
      tx = db.transaction([ACTION_STORE], 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    const request = tx.objectStore(ACTION_STORE).add(record);
    request.onsuccess = () => { key = request.result; };
    tx.oncomplete = () => resolve({ key, record });
    tx.onerror = () => reject(tx.error || new Error('action_outbox write failed'));
    tx.onabort = () => reject(tx.error || new Error('action_outbox write aborted'));
  });
}

export async function getActionQueueCount() {
  const db = await openAgencyDatabase().catch(() => null);
  if (!db) return 0;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([ACTION_STORE], 'readonly');
      const request = tx.objectStore(ACTION_STORE).count();
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

let actionFlushInFlight = null;

/** Drain the quick-drop queue. Overlapping calls share one run. */
export function flushActionQueue(options = {}) {
  if (actionFlushInFlight) return actionFlushInFlight;
  actionFlushInFlight = runActionFlush(options).finally(() => { actionFlushInFlight = null; });
  return actionFlushInFlight;
}

async function runActionFlush({ fetchImpl } = {}) {
  const summary = { attempted: 0, sent: 0, failed: 0, rejected: 0, remaining: 0 };
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return summary;

  const db = await openAgencyDatabase().catch(() => null);
  if (!db) return summary;

  const records = await readOutbox(db, ACTION_STORE).catch(() => []);
  if (records.length === 0) return summary;

  for (const entry of records) {
    summary.attempted += 1;
    try {
      const response = await doFetch(ACTIVITY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.value)
      });

      if (response && response.status === 200) {
        await deleteRecord(db, entry.key, ACTION_STORE);
        summary.sent += 1;
      } else if (response && response.status >= 400 && response.status < 500) {
        // A 4xx will fail identically forever — the account was suppressed on
        // another device, or the payload has a typo. Retrying it 5,000 times
        // would wedge every later drop behind it, so it is dropped instead.
        await deleteRecord(db, entry.key, ACTION_STORE);
        summary.rejected += 1;
      } else {
        // 5xx or no response: the server could not take it right now, which is
        // exactly the case the queue exists for.
        summary.failed += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }

  summary.remaining = (await readOutbox(db, ACTION_STORE).catch(() => [])).length;
  return summary;
}

/**
 * Wire both outboxes to the `online` event. Idempotent.
 *
 * One handler for the whole outbox: signal returning is the trigger for
 * everything queued, and two listeners would just race each other.
 *
 * NOTE: this deliberately does NOT drain at wire time. flushAudioQueue() and
 * flushActionQueue() share one in-flight run per queue so a record can never be
 * uploaded twice, and a boot-time run that has already read its cursor would
 * swallow the very next trigger. A backlog left over from a previous session is
 * therefore sent by the next `online` transition, the next queued drop, or an
 * explicit push — see the sync badge in the legacy console.
 */
export function initAudioQueueSync() {
  if (onlineHandler) return onlineHandler;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;

  onlineHandler = () => {
    flushAudioQueue();
    flushActionQueue();
  };
  window.addEventListener('online', onlineHandler);
  return onlineHandler;
}

/** Drain both queues. Used by boot and by the sync badge. */
export function flushAllQueues(options = {}) {
  return Promise.all([flushAudioQueue(options), flushActionQueue(options)]);
}

export function destroyAudioQueueSync() {
  if (!onlineHandler) return;
  if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    window.removeEventListener('online', onlineHandler);
  }
  onlineHandler = null;
}
