/**
 * Sprint 3 — Agency OS frontend foundation.
 *
 * These modules are browser code, but the browser APIs they use are small and
 * well-specified, so they are stubbed by hand here rather than pulling jsdom
 * into a project that has deliberately kept zero test dependencies (see
 * test/markdown.test.js for the same approach).
 *
 * What is faked, and why:
 *   - indexedDB  : a faithful enough IDBObjectStore (out-of-line keys, cursors,
 *                  transaction completion fired after request callbacks) that
 *                  ordering bugs in the outbox would still be caught.
 *   - window/document : EventTarget-lite + a minimal Element, so mount teardown,
 *                  the online listener and the theme attribute are all real.
 *   - MediaRecorder / getUserMedia : a recorder that emits dataavailable BEFORE
 *                  stop, which is the ordering the capture module relies on.
 *   - localStorage : plain Map-backed, so persistence is observable.
 *
 * Blob, FormData, Response and CustomEvent are Node natives and are NOT faked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODES,
  STATE_CHANGE_EVENT,
  getState,
  subscribe,
  setState,
  enqueueAudio,
  flushAudioQueue,
  getAudioQueueCount,
  buildVoiceDebriefForm,
  initAudioQueueSync,
  destroyAudioQueueSync,
  closeAgencyDatabase,
  enqueueAction,
  flushActionQueue,
  flushAllQueues,
  getActionQueueCount,
  ACTION_STORE
} from '../public/app/modules/state.js';

// Sprint 5 pulls two more browser modules into this harness: the dialer (to
// prove a failed quick drop reaches IndexedDB) and the triage parser.
import { mountDialerView } from '../public/app/modules/dialer-view.js';
import { parseCsv, parseApifyLeads, buildImportPayload, parseLatitude, parseLongitude } from '../public/app/modules/triage-view.js';

import {
  AUDIO_QUEUED_EVENT,
  selectSupportedMimeType,
  isRecording,
  startRecording,
  stopRecording,
  initVisibilityRecordingDefense,
  destroyVisibilityRecordingDefense
} from '../public/app/modules/audio.js';

import {
  VIEW_CONTAINER_ID,
  THEME_STORAGE_KEY,
  THEME_HIGH_CONTRAST,
  initializeTheme,
  isSunGlareTheme,
  toggleSunGlareTheme,
  mountMode,
  mountPhoneMode,
  mountFieldMode,
  mountTriageMode,
  unmountCurrentMode,
  getMountedMode,
  initNavigation,
  destroyNavigation
} from '../public/app/modules/navigation.js';

// ---------------------------------------------------------------------
// BROWSER DOUBLES
// ---------------------------------------------------------------------

class FakeEventTarget {
  constructor() { this._listeners = new Map(); }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this._listeners.get(type)?.delete(handler);
  }

  dispatchEvent(event) {
    for (const handler of [...(this._listeners.get(event.type) || [])]) handler(event);
    return true;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = {};
    this._text = '';
  }

  set className(value) { this.attributes.class = String(value); }
  get className() { return this.attributes.class || ''; }

  set id(value) { this.attributes.id = String(value); }
  get id() { return this.attributes.id || ''; }

  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join('')
      : this._text;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  removeAttribute(name) { delete this.attributes[name]; }

  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ''; }
  querySelectorAll() { return []; }
}

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }

  succeed(result) {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }

  fail(error) {
    this.error = error;
    queueMicrotask(() => this.onerror?.({ target: this }));
  }
}

class FakeObjectStore {
  constructor(store) { this._store = store; }

  add(value) {
    const request = new FakeRequest();
    const key = this._store.nextKey++;
    this._store.records.set(key, value);
    request.succeed(key);
    return request;
  }

  delete(key) {
    const request = new FakeRequest();
    this._store.records.delete(key);
    request.succeed(true);
    return request;
  }

  count() {
    const request = new FakeRequest();
    request.succeed(this._store.records.size);
    return request;
  }

  /**
   * Mirrors the real cursor protocol: ONE request whose `result` is replaced on
   * every step, driven by the consumer calling cursor.continue().
   */
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
    // Real IndexedDB commits after every request callback has run, so this must
    // be a MACROtask: a microtask would beat the request's onsuccess and the
    // generated key would still be unset when the caller's promise resolves.
    setTimeout(() => this.oncomplete?.(), 0);
  }

  objectStore(name) {
    const store = this.db._stores.get(name);
    if (!store) throw new Error(`No object store named ${name}`);
    return new FakeObjectStore(store);
  }
}

class FakeDatabase {
  constructor() {
    this._stores = new Map();
    this.closed = false;
    this.objectStoreNames = { contains: (name) => this._stores.has(name) };
  }

  createObjectStore(name) {
    const store = { records: new Map(), nextKey: 1 };
    this._stores.set(name, store);
    return store;
  }

  transaction() { return new FakeTransaction(this); }

  close() { this.closed = true; }
}

function createFakeIndexedDB() {
  const databases = new Map();

  return {
    open(name) {
      const request = new FakeRequest();
      let db = databases.get(name);
      const isNew = !db;
      if (!db) {
        db = new FakeDatabase();
        databases.set(name, db);
      }

      queueMicrotask(() => {
        request.result = db;
        if (isNew) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });

      return request;
    }
  };
}

class FakeMediaRecorder extends FakeEventTarget {
  static supported = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

  constructor(stream, options = {}) {
    super();
    this.stream = stream;
    this.mimeType = options.mimeType || '';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onerror = null;
  }

  static isTypeSupported(type) {
    return FakeMediaRecorder.supported.includes(type);
  }

  start() { this.state = 'recording'; }

  /** dataavailable fires BEFORE stop — the capture module depends on it. */
  stop() {
    this.state = 'inactive';
    const chunk = new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType || 'audio/webm' });
    this.ondataavailable?.({ data: chunk });
    queueMicrotask(() => this.dispatchEvent({ type: 'stop' }));
  }
}

// ---------------------------------------------------------------------
// ENVIRONMENT
// ---------------------------------------------------------------------

let micTracks = [];
let micCalls = 0;

function createFakeLocalStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    _values: values
  };
}

function installBrowser() {
  const hosts = new Map();
  const modeButtons = [];
  const windowTarget = new FakeEventTarget();

  const document = Object.assign(new FakeEventTarget(), {
    documentElement: new FakeElement('html'),
    visibilityState: 'visible',
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => hosts.get(id) || null,
    querySelectorAll: (selector) => (selector === '[data-agency-mode]' ? modeButtons : [])
  });

  micTracks = [];
  micCalls = 0;

  const navigator = {
    onLine: true,
    mediaDevices: {
      getUserMedia: async () => {
        micCalls += 1;
        const track = { stopped: false, stop() { this.stopped = true; } };
        micTracks.push(track);
        return { getTracks: () => micTracks };
      }
    }
  };

  globalThis.window = windowTarget;
  globalThis.document = document;
  // Node exposes `navigator` as a getter-only global, so a plain assignment
  // throws. defineProperty works; the assignment form is kept as a fallback for
  // runtimes where it is a normal writable property.
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: navigator,
      configurable: true,
      writable: true
    });
  } catch {
    globalThis.navigator.mediaDevices = navigator.mediaDevices;
    globalThis.navigator.onLine = true;
  }
  globalThis.localStorage = createFakeLocalStorage();
  globalThis.indexedDB = createFakeIndexedDB();
  globalThis.MediaRecorder = FakeMediaRecorder;

  return {
    document,
    window: windowTarget,
    hosts,
    modeButtons,
    storage: globalThis.localStorage,
    mountHost(id = VIEW_CONTAINER_ID) {
      const host = new FakeElement('div');
      hosts.set(id, host);
      return host;
    },
    addModeButton(mode) {
      const button = new FakeElement('button');
      button.setAttribute('data-agency-mode', mode);
      modeButtons.push(button);
      return button;
    }
  };
}

/** Text renderer for the fake Element tree, used for content assertions. */
function textOf(node) {
  return node.children.length
    ? node.children.map((child) => textOf(child)).join(' ')
    : node.textContent;
}

async function freshBrowser() {
  const browser = installBrowser();
  await closeAgencyDatabase();
  setState({ mode: 'FIELD' });
  return browser;
}

function audioBlob(type = 'audio/webm;codecs=opus') {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type });
}

// ---------------------------------------------------------------------
// STATE STORE
// ---------------------------------------------------------------------

test('the store exposes the three Agency OS modes and a default', () => {
  assert.deepEqual(MODES, ['PHONE', 'FIELD', 'TRIAGE']);
  assert.ok(MODES.includes(getState().mode));
});

test('a stored mode is restored on the next boot, and junk falls back', async () => {
  installBrowser();
  // The key is internal; asserted literally so a rename cannot pass silently.
  globalThis.localStorage.setItem('agency_os_mode', 'TRIAGE');
  const restored = await import('../public/app/modules/state.js?boot=1');
  assert.equal(restored.getState().mode, 'TRIAGE');

  globalThis.localStorage.setItem('agency_os_mode', 'NOT_A_MODE');
  const fallback = await import('../public/app/modules/state.js?boot=2');
  assert.equal(fallback.getState().mode, 'FIELD');
});

test('setState notifies subscribers, dispatches a DOM event and persists', async () => {
  const browser = await freshBrowser();
  const seen = [];
  const domEvents = [];

  const unsubscribe = subscribe((detail) => seen.push(detail));
  browser.window.addEventListener(STATE_CHANGE_EVENT, (event) => domEvents.push(event.detail));

  const next = setState({ mode: 'PHONE' });

  assert.equal(next.mode, 'PHONE');
  assert.equal(getState().mode, 'PHONE');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].changedKeys, ['mode']);
  assert.equal(seen[0].state.mode, 'PHONE');
  assert.equal(seen[0].previousState.mode, 'FIELD');
  assert.equal(domEvents.length, 1, 'the DOM event lets non-importing code react');
  assert.equal(domEvents[0].state.mode, 'PHONE');
  assert.equal(browser.storage.getItem('agency_os_mode'), 'PHONE');

  unsubscribe();
  setState({ mode: 'FIELD' });
  assert.equal(seen.length, 1, 'unsubscribe really detaches');
});

test('setState validates the mode and ignores a no-op update', async () => {
  await freshBrowser();
  assert.throws(() => setState({ mode: 'LUNCH' }), RangeError);
  assert.throws(() => setState('PHONE'), TypeError);

  let calls = 0;
  const unsubscribe = subscribe(() => { calls += 1; });
  setState({ mode: 'FIELD' });
  assert.equal(calls, 0, 'an unchanged mode must not re-render the world');
  unsubscribe();
});

test('one broken subscriber cannot stop the others', async () => {
  await freshBrowser();
  const good = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);

  const offBad = subscribe(() => { throw new Error('view blew up'); });
  const offGood = subscribe(() => good.push(getState().mode));

  try {
    setState({ mode: 'TRIAGE' });
  } finally {
    console.error = originalError;
    offBad();
    offGood();
  }

  assert.deepEqual(good, ['TRIAGE']);
  assert.equal(errors.length, 1, 'the failure is reported, not swallowed silently');
});

// ---------------------------------------------------------------------
// AUDIO OUTBOX
// ---------------------------------------------------------------------

test('enqueueAudio stores the blob with its metadata under an autoIncrement key', async () => {
  await freshBrowser();
  setState({ mode: 'PHONE' });

  const first = await enqueueAudio(audioBlob(), { company_id: 'acct-1' });
  const second = await enqueueAudio(audioBlob('audio/webm'), { company_id: '   ', mode: 'FIELD' });

  assert.equal(first.key, 1, 'out-of-line keys start at 1');
  assert.equal(second.key, 2);
  assert.equal(first.record.company_id, 'acct-1');
  assert.equal(first.record.mode, 'PHONE', 'mode defaults to the active workspace');
  assert.equal(second.record.company_id, null, 'a blank id is stored as null, not ""');
  assert.equal(second.record.mode, 'FIELD');
  assert.match(first.record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await getAudioQueueCount(), 2);
});

test('enqueueAudio refuses an empty or missing blob', async () => {
  await freshBrowser();
  await assert.rejects(() => enqueueAudio(new Blob([])), TypeError);
  await assert.rejects(() => enqueueAudio(null), TypeError);
});

test('the outbox request is multipart and carries the debrief fields', async () => {
  const form = buildVoiceDebriefForm({
    blob: audioBlob('audio/ogg'),
    company_id: 'acct-9',
    mode: 'FIELD',
    timestamp: '2026-09-12T15:04:05.678Z'
  });

  assert.equal(form.get('company_id'), 'acct-9');
  assert.equal(form.get('mode'), 'FIELD');
  assert.equal(form.get('timestamp'), '2026-09-12T15:04:05.678Z');

  const file = form.get('audio');
  assert.ok(file && typeof file.arrayBuffer === 'function');
  assert.match(file.name, /^debrief-2026-09-12T15-04-05-678Z\.ogg$/);
});

test('flushAudioQueue deletes a record only after the server returns 200', async () => {
  await freshBrowser();
  await enqueueAudio(audioBlob(), { company_id: 'acct-1' });

  const requests = [];
  const summary = await flushAudioQueue({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { status: 200 };
    }
  });

  assert.deepEqual(summary, { attempted: 1, sent: 1, failed: 0, remaining: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/voice-debrief');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers, undefined,
    'Content-Type must be left to the browser so the multipart boundary is valid');
  assert.equal(await getAudioQueueCount(), 0);
});

test('a failed or offline upload leaves the capture queued', async () => {
  await freshBrowser();
  await enqueueAudio(audioBlob(), { company_id: 'acct-1' });
  await enqueueAudio(audioBlob(), { company_id: 'acct-2' });

  let call = 0;
  const summary = await flushAudioQueue({
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return { status: 503 };
      throw new TypeError('Failed to fetch');
    }
  });

  assert.deepEqual(summary, { attempted: 2, sent: 0, failed: 2, remaining: 2 });
  assert.equal(await getAudioQueueCount(), 2, 'the only copy of a field visit survives');

  // A later run with signal drains both.
  const recovered = await flushAudioQueue({ fetchImpl: async () => ({ status: 200 }) });
  assert.equal(recovered.sent, 2);
  assert.equal(await getAudioQueueCount(), 0);
});

test('overlapping flushes share one run instead of uploading twice', async () => {
  await freshBrowser();
  await enqueueAudio(audioBlob(), { company_id: 'acct-1' });

  let uploads = 0;
  const fetchImpl = async () => {
    uploads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: 200 };
  };

  const [first, second] = await Promise.all([
    flushAudioQueue({ fetchImpl }),
    flushAudioQueue({ fetchImpl })
  ]);

  assert.equal(uploads, 1, 'a duplicate POST would double-log the same touch');
  assert.equal(first.sent, 1);
  assert.deepEqual(second, first);
});

test('initAudioQueueSync wires the online listener exactly once', async () => {
  const browser = await freshBrowser();

  const handler = initAudioQueueSync();
  assert.equal(typeof handler, 'function');
  assert.equal(initAudioQueueSync(), handler, 'idempotent');

  await enqueueAudio(audioBlob(), { company_id: 'acct-1' });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200 });
  try {
    browser.window.dispatchEvent({ type: 'online' });
    // The listener kicks off an async flush; give the timers a turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await getAudioQueueCount(), 0, 'reconnecting drained the outbox');
  } finally {
    globalThis.fetch = originalFetch;
    destroyAudioQueueSync();
  }
});

// ---------------------------------------------------------------------
// WEB AUDIO CAPTURE
// ---------------------------------------------------------------------

test('mime selection prefers Opus/WebM and never invents support', async () => {
  await freshBrowser();

  assert.equal(selectSupportedMimeType(), 'audio/webm;codecs=opus');

  // A browser that offers only MP4 gets MP4, not a forced WebM.
  FakeMediaRecorder.supported = ['audio/mp4'];
  assert.equal(selectSupportedMimeType(), 'audio/mp4');

  // No opinion at all returns '' so MediaRecorder picks its own default.
  FakeMediaRecorder.supported = [];
  assert.equal(selectSupportedMimeType(), '');
  assert.equal(selectSupportedMimeType(['audio/webm']), '');

  FakeMediaRecorder.supported = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
});

test('startRecording acquires the microphone once and reports recorder state', async () => {
  await freshBrowser();
  assert.equal(isRecording(), false);

  const started = await startRecording({ company_id: 'acct-1', mode: 'FIELD' });

  assert.equal(started.started, true);
  assert.equal(started.mimeType, 'audio/webm;codecs=opus');
  assert.equal(micCalls, 1);
  assert.equal(isRecording(), true);

  const again = await startRecording();
  assert.deepEqual(again, { started: false, reason: 'already-recording' });
  assert.equal(micCalls, 1, 'a second tap must not open a second microphone');

  await stopRecording();
});

test('stopRecording returns the finished blob and releases the hardware', async () => {
  await freshBrowser();
  await startRecording({ company_id: 'acct-1', mode: 'PHONE' });

  const blob = await stopRecording();

  assert.ok(blob instanceof Blob);
  assert.ok(blob.size > 0, 'the final dataavailable chunk must be included');
  assert.equal(blob.type, 'audio/webm;codecs=opus');
  assert.equal(isRecording(), false);
  assert.ok(micTracks.length >= 1);
  assert.ok(micTracks.every((track) => track.stopped), 'every track is stopped');
  assert.equal(await stopRecording(), null, 'a second stop has nothing left to return');
});

test('concurrent stop calls resolve from the same capture', async () => {
  await freshBrowser();
  await startRecording();

  const [first, second] = await Promise.all([stopRecording(), stopRecording()]);

  assert.ok(first instanceof Blob);
  assert.equal(second, first, 'two taps on stop must not race the recorder');
});

test('a hidden document stops recording, saves the partial capture and frees the mic', async () => {
  const browser = await freshBrowser();
  const queued = [];
  browser.window.addEventListener(AUDIO_QUEUED_EVENT, (event) => queued.push(event.detail));

  initVisibilityRecordingDefense();
  await startRecording({ company_id: 'acct-1', mode: 'FIELD' });

  browser.document.visibilityState = 'hidden';
  browser.document.dispatchEvent({ type: 'visibilitychange' });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(isRecording(), false, 'the recorder must not stay live in the background');
  assert.ok(micTracks.every((track) => track.stopped), 'the OS microphone indicator is released');
  assert.equal(await getAudioQueueCount(), 1, 'the partial note is parked in the outbox');

  assert.equal(queued.length, 1);
  assert.equal(queued[0].reason, 'visibility-hidden');
  assert.equal(queued[0].company_id, 'acct-1');

  destroyVisibilityRecordingDefense();
});

test('a visible document leaves the recording alone', async () => {
  const browser = await freshBrowser();
  initVisibilityRecordingDefense();
  await startRecording();

  browser.document.visibilityState = 'visible';
  browser.document.dispatchEvent({ type: 'visibilitychange' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(isRecording(), true, 'only a hidden document suspends a capture');
  assert.equal(await getAudioQueueCount(), 0);

  await stopRecording();
  destroyVisibilityRecordingDefense();
});

// ---------------------------------------------------------------------
// NAVIGATION + THEME
// ---------------------------------------------------------------------

test('each mode mounts its own placeholder into the container', async () => {
  const browser = await freshBrowser();
  const host = browser.mountHost();

  const field = mountFieldMode(host);
  assert.equal(field.getAttribute('data-agency-view'), 'FIELD');
  assert.match(textOf(field), /Field Mode Active/);
  assert.equal(host.children.length, 1, 'the previous view is replaced, not appended');

  const phone = mountPhoneMode(host);
  assert.equal(phone.getAttribute('data-agency-view'), 'PHONE');
  assert.match(textOf(phone), /Phone Mode Active/);
  assert.equal(host.children.length, 1, 'switching modes must not stack subtrees');

  const triage = mountTriageMode(host);
  assert.equal(triage.getAttribute('data-agency-view'), 'TRIAGE');
  assert.match(textOf(triage), /Triage Mode Active/);
  assert.equal(getMountedMode(), 'TRIAGE');

  unmountCurrentMode(host);
  assert.equal(host.children.length, 0, 'unmount leaves an empty host');
  assert.equal(getMountedMode(), null);
});

test('mounting rejects an unknown mode and tolerates a missing host', async () => {
  const browser = await freshBrowser();

  // Before the shell exists there is nothing to mount into, and that is not an
  // error: initNavigation() returns null and the legacy field log keeps running.
  assert.equal(mountMode('PHONE'), null, 'no host, no crash');
  assert.equal(initNavigation(), null);

  const host = browser.mountHost();
  assert.equal(
    mountMode('PHONE', null).getAttribute('data-agency-view'),
    'PHONE',
    'an omitted container falls back to the default #view-container'
  );

  assert.throws(() => mountMode('ELEVATOR', host), RangeError);
});

test('initNavigation follows the store and reacts to mode buttons', async () => {
  const browser = await freshBrowser();
  const host = browser.mountHost();
  const triageButton = browser.addModeButton('TRIAGE');

  const cleanup = initNavigation({ container: host });
  assert.equal(typeof cleanup, 'function');
  assert.equal(host.children[0].getAttribute('data-agency-view'), 'FIELD');

  // A programmatic mode change swaps the mounted view.
  setState({ mode: 'PHONE' });
  assert.equal(host.children[0].getAttribute('data-agency-view'), 'PHONE');
  assert.equal(getMountedMode(), 'PHONE');

  // A shell button drives the same path.
  triageButton.dispatchEvent({ type: 'click' });
  assert.equal(getState().mode, 'TRIAGE');
  assert.equal(host.children[0].getAttribute('data-agency-view'), 'TRIAGE');

  // Initialising twice must not double-subscribe.
  assert.equal(initNavigation({ container: host }), cleanup);

  destroyNavigation();
  setState({ mode: 'FIELD' });
  assert.equal(getMountedMode(), null, 'after teardown the store no longer mounts');
});

test('initNavigation is a no-op until the shell provides a container', async () => {
  await freshBrowser();
  assert.equal(initNavigation(), null);
});

test('the sun-glare theme toggles the html attribute and persists', async () => {
  const browser = await freshBrowser();

  assert.equal(initializeTheme(), false, 'dark is the default');
  assert.equal(browser.document.documentElement.getAttribute('data-theme'), null);

  assert.equal(toggleSunGlareTheme(), true);
  assert.equal(browser.document.documentElement.getAttribute('data-theme'), THEME_HIGH_CONTRAST);
  assert.equal(browser.storage.getItem(THEME_STORAGE_KEY), THEME_HIGH_CONTRAST);
  assert.equal(isSunGlareTheme(), true);

  assert.equal(toggleSunGlareTheme(), false);
  assert.equal(browser.document.documentElement.getAttribute('data-theme'), null);
  assert.equal(browser.storage.getItem(THEME_STORAGE_KEY), 'default');

  // An explicit value is honoured rather than flipped.
  assert.equal(toggleSunGlareTheme(true), true);
  assert.equal(isSunGlareTheme(), true);
});

test('a saved high-contrast preference is restored on boot', async () => {
  const browser = await freshBrowser();
  browser.storage.setItem(THEME_STORAGE_KEY, THEME_HIGH_CONTRAST);

  assert.equal(initializeTheme(), true);
  assert.equal(isSunGlareTheme(), true);
});

// ---------------------------------------------------------------------
// ACTION OUTBOX — offline quick drops (Sprint 5)
// ---------------------------------------------------------------------

/** Depth-first search for the first descendant carrying `attribute`. */
function findByAttribute(node, attribute) {
  for (const child of node.children || []) {
    if (Object.prototype.hasOwnProperty.call(child.attributes, attribute)) return child;
    const nested = findByAttribute(child, attribute);
    if (nested) return nested;
  }
  return null;
}

test('enqueueAction stores a JSON quick drop under an autoIncrement key', async () => {
  await freshBrowser();
  setState({ mode: 'PHONE' });

  const first = await enqueueAction({ company_id: 'acct-1', disposition: 'vm_no_answer', mode: 'PHONE' });
  const second = await enqueueAction({ company_id: 'acct-2', disposition: 'WRONG_NUMBER', mode: 'FIELD' });

  assert.equal(first.key, 1, 'out-of-line keys start at 1');
  assert.equal(second.key, 2);
  assert.equal(first.record.disposition, 'VM_NO_ANSWER', 'canonicalised before it is stored');
  assert.equal(first.record.mode, 'PHONE');
  assert.equal(second.record.mode, 'FIELD');
  assert.ok(!Number.isNaN(Date.parse(first.record.timestamp)), 'every drop carries when it happened');

  assert.equal(await getActionQueueCount(), 2);
  assert.equal(await getAudioQueueCount(), 0, 'the audio queue is a separate store');
  assert.equal(ACTION_STORE, 'action_outbox');
});

test('enqueueAction refuses a payload that could never be delivered', async () => {
  await freshBrowser();

  await assert.rejects(() => enqueueAction({}), TypeError);
  await assert.rejects(() => enqueueAction({ company_id: 'acct-1' }), TypeError, 'no disposition');
  await assert.rejects(() => enqueueAction({ company_id: '   ', disposition: 'VM_NO_ANSWER' }), TypeError);
  await assert.rejects(() => enqueueAction({ company_id: 'acct-1', disposition: '  ' }), TypeError);

  assert.equal(await getActionQueueCount(), 0, 'nothing unusable is left to replay forever');
});

test('flushActionQueue posts JSON and removes only what the server accepted', async () => {
  await freshBrowser();
  await enqueueAction({ company_id: 'acct-1', disposition: 'VM_NO_ANSWER', mode: 'PHONE' });
  await enqueueAction({ company_id: 'acct-2', disposition: 'GATEKEEPER_BLOCK', mode: 'PHONE' });
  await enqueueAction({ company_id: 'acct-3', disposition: 'WRONG_NUMBER', mode: 'PHONE' });

  const seen = [];
  const statuses = [200, 503, 404];
  let call = 0;

  const summary = await flushActionQueue({
    fetchImpl: async (url, init) => {
      seen.push({ url, contentType: init.headers['Content-Type'], body: JSON.parse(init.body) });
      return { status: statuses[call++] };
    }
  });

  assert.equal(summary.attempted, 3);
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 1, 'a 5xx is transient, so it stays queued');
  assert.equal(summary.rejected, 1, 'a 4xx will fail identically forever, so it is dropped');
  assert.equal(summary.remaining, 1);

  assert.equal(seen[0].url, '/api/activity');
  assert.equal(seen[0].contentType, 'application/json');
  assert.equal(seen[0].body.company_id, 'acct-1');
  assert.equal(seen[0].body.disposition, 'VM_NO_ANSWER');
  assert.equal(seen[0].body.mode, 'PHONE');

  // Whatever is left is exactly the transient failure.
  const retried = [];
  await flushActionQueue({
    fetchImpl: async (url, init) => { retried.push(JSON.parse(init.body)); return { status: 200 }; }
  });

  assert.deepEqual(retried.map((entry) => entry.company_id), ['acct-2']);
  assert.equal(await getActionQueueCount(), 0, 'a healthy server drains the queue');
});

test('flushAllQueues drains both stores with one multipart and one JSON request', async () => {
  await freshBrowser();
  await enqueueAudio(audioBlob(), { company_id: 'acct-1' });
  await enqueueAction({ company_id: 'acct-1', disposition: 'VM_NO_ANSWER', mode: 'PHONE' });

  let posts = 0;
  const [audioSummary, actionSummary] = await flushAllQueues({
    fetchImpl: async () => { posts += 1; return { status: 200 }; }
  });

  assert.equal(audioSummary.sent, 1);
  assert.equal(actionSummary.sent, 1);
  assert.equal(posts, 2);
  assert.equal(await getAudioQueueCount(), 0);
  assert.equal(await getActionQueueCount(), 0);
});

test('a dialer quick drop that cannot reach the server is queued and the stack advances', async () => {
  await freshBrowser();
  setState({ mode: 'PHONE' });

  const host = new FakeElement('div');
  const leads = [
    { company_id: 'acct-1', company_name: 'Alpha Co', decision_maker_name: 'Dana', company_phone: '4175550001', confidence_score: 60 },
    { company_id: 'acct-2', company_name: 'Bravo Co', company_phone: '4175550002', confidence_score: 55 }
  ];

  const fetchImpl = async (url) => {
    if (String(url).includes('/api/leads')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: leads }) };
    }
    // Offline: the request never reaches the server at all.
    throw new TypeError('Failed to fetch');
  };

  const originalError = console.error;
  console.error = () => {};

  try {
    const destroy = mountDialerView(host, { fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(textOf(host), /Alpha Co/);

    findByAttribute(host, 'data-quick-drop').dispatchEvent({ type: 'click' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(await getActionQueueCount(), 1, 'the dial recovered into the outbox');
    assert.equal(await getAudioQueueCount(), 0, 'and did not pollute the audio queue');
    assert.match(textOf(host), /Bravo Co/, 'the agent is never blocked from dialing on');
    assert.match(textOf(host), /Offline/);

    // The queued record replays as the account that was on screen when tapped.
    const retried = [];
    await flushActionQueue({
      fetchImpl: async (url, init) => { retried.push(JSON.parse(init.body)); return { status: 200 }; }
    });

    assert.equal(retried.length, 1);
    assert.equal(retried[0].company_id, 'acct-1');
    assert.equal(retried[0].disposition, 'VM_NO_ANSWER');
    assert.equal(retried[0].mode, 'PHONE');
    assert.equal(await getActionQueueCount(), 0);

    destroy();
    assert.equal(host.children.length, 0, 'teardown leaves no empty wrapper');
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------
// CSV PARSER — Apify ingestion (Sprint 5)
// ---------------------------------------------------------------------

test('parseCsv handles quoted commas, doubled quotes and embedded newlines', () => {
  const rows = parseCsv([
    'title,phone,city',
    '"Ozark Machining, LLC",417-555-0001,Springfield',
    '"The ""Old"" Mill",417-555-0002,Nixa',
    '"Two\nLines Co",417-555-0003,Republic'
  ].join('\n'));

  assert.deepEqual(rows[0], ['title', 'phone', 'city']);
  assert.deepEqual(rows[1], ['Ozark Machining, LLC', '417-555-0001', 'Springfield']);
  assert.deepEqual(rows[2], ['The "Old" Mill', '417-555-0002', 'Nixa']);
  assert.deepEqual(rows[3], ['Two\nLines Co', '417-555-0003', 'Republic']);
});

test('parseCsv tolerates CRLF, a BOM, blank lines and a missing final newline', () => {
  const rows = parseCsv('\uFEFFtitle,phone\r\nA Co,111\r\n\r\nB Co,222');

  assert.deepEqual(rows, [['title', 'phone'], ['A Co', '111'], ['B Co', '222']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
});

test('parseApifyLeads maps the scrape headers onto company columns', () => {
  const csv = [
    'title,phone,website,street,city,state,postalCode,location/lat,location/lng',
    '"Ozark Machining, LLC",417-555-0001,https://ozark.example,1 Mill St,Springfield,MO,65806,37.208957,-93.292298'
  ].join('\n');

  const { leads, skipped, headers } = parseApifyLeads(csv);

  assert.equal(skipped, 0);
  assert.equal(leads.length, 1);
  assert.equal(headers[0], 'title');
  assert.equal(leads[0].company_name, 'Ozark Machining, LLC');
  assert.equal(leads[0].company_phone, '417-555-0001');
  assert.equal(leads[0].street_1, '1 Mill St');
  assert.equal(leads[0].zip_code, '65806');

  const [payload] = buildImportPayload(leads);
  assert.equal(payload.lat, 37.208957);
  assert.equal(payload.long, -93.292298);
  // companies has no website column, so the scraped URL rides along in notes.
  assert.equal(payload.notes, 'Website: https://ozark.example');
});

test('a scraped row with no business name is skipped, not imported as garbage', () => {
  const { leads, skipped } = parseApifyLeads(['title,phone', ',417-555-0000', 'Real Co,417-555-0001'].join('\n'));

  assert.equal(leads.length, 1);
  assert.equal(leads[0].company_name, 'Real Co');
  assert.equal(skipped, 1);
});

test('impossible coordinates are dropped rather than sent as zero', () => {
  assert.equal(parseLatitude(''), null);
  assert.equal(parseLatitude(null), null);
  assert.equal(parseLatitude('north'), null);
  assert.equal(parseLatitude('91'), null, 'out of range');
  assert.equal(parseLongitude('-181'), null);
  assert.equal(parseLatitude('0'), 0, 'a real zero is a real coordinate');

  // A lone latitude is not a location; sending it would put the account at
  // latitude 37 with no longitude to go with it.
  const [half] = buildImportPayload([{ company_name: 'Half Located', lat: '37.2' }]);
  assert.equal('lat' in half, false);
  assert.equal('long' in half, false);

  // Blank text fields are omitted rather than written as empty strings.
  const [sparse] = buildImportPayload([{ company_name: 'Sparse Co', city: '   ', zip_code: '65806' }]);
  assert.equal(sparse.city, undefined);
  assert.equal(sparse.zip_code, '65806');
});

