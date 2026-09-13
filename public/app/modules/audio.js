/**
 * Agency OS — resilient microphone capture.
 *
 * The browser's MediaRecorder is the whole implementation; there is no encoder
 * and no worklet here. What this module adds is the lifecycle discipline the
 * raw API lacks:
 *
 *   - codec preference, because Chrome/Android give Opus-in-WebM and Firefox
 *     gives Opus-in-Ogg, and asking for the wrong one silently produces a
 *     container Whisper cannot read;
 *   - hardware release on every exit path, so the OS microphone indicator and
 *     the agent's Bluetooth earpiece actually turn off;
 *   - a visibility defense, because answering a phone call or locking the
 *     screen mid-note fires no `stop` event and would otherwise leave the mic
 *     hot and the capture lost.
 *
 * It owns a private recorder instance and does not touch the legacy recorder in
 * public/app/field.js, so both can coexist until Sprint 4 replaces the view.
 */

import { MODES, enqueueAudio, getState } from './state.js';

/** Ordered by preference. Do not reorder without checking Whisper support. */
export const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg'
];

export const AUDIO_QUEUED_EVENT = 'agency-os:audio-queued';

/** How long to wait for the recorder's final dataavailable before giving up. */
const STOP_GRACE_MS = 2000;

let recorder = null;
let stream = null;
let chunks = [];
let stopPromise = null;
let pendingMetadata = null;
let recordingStartedAt = 0;

/**
 * First candidate the browser accepts, or '' when the platform exposes no
 * opinion. Returning '' is deliberate: MediaRecorder then picks its own
 * default, which is always better than forcing an unsupported container.
 */
export function selectSupportedMimeType(candidates = AUDIO_MIME_CANDIDATES) {
  const Recorder = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null;
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return '';

  return candidates.find((type) => {
    try {
      return Recorder.isTypeSupported(type);
    } catch {
      return false;
    }
  }) || '';
}

export function isRecording() {
  return Boolean(recorder && recorder.state === 'recording');
}

export function recordingSeconds() {
  return recordingStartedAt ? (Date.now() - recordingStartedAt) / 1000 : 0;
}

function releaseStream(mediaStream) {
  try {
    mediaStream?.getTracks?.().forEach((track) => track.stop());
  } catch (err) {
    console.error('Could not release the microphone track:', err);
  }
}

function normalizeMetadata(metadata = {}) {
  return {
    company_id: typeof metadata?.company_id === 'string' && metadata.company_id.trim()
      ? metadata.company_id.trim()
      : null,
    mode: MODES.includes(metadata?.mode) ? metadata.mode : getState().mode,
    // Stamped at START, not at stop: a note interrupted by a phone call should
    // be filed at the moment the agent was actually standing there.
    timestamp: typeof metadata?.timestamp === 'string' && !Number.isNaN(Date.parse(metadata.timestamp))
      ? new Date(metadata.timestamp).toISOString()
      : new Date().toISOString()
  };
}

/**
 * Open the microphone and begin buffering.
 *
 * @param {{company_id?: string, mode?: string, timestamp?: string}} [metadata]
 * @returns {Promise<{started: true, mimeType: string}>}
 */
export async function startRecording(metadata = {}) {
  if (isRecording()) return { started: false, reason: 'already-recording' };

  const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Audio recording is not supported in this browser');
  }

  // Mono 16 kHz up front: a stereo 48 kHz stream costs three times the uplink
  // over field LTE for audio Whisper is going to downsample anyway.
  const acquired = await mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const mimeType = selectSupportedMimeType();

  let nextRecorder;
  try {
    nextRecorder = new MediaRecorder(acquired, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 24000
    });
  } catch (err) {
    // Never leave a hot microphone behind a failed constructor.
    releaseStream(acquired);
    throw err;
  }

  stream = acquired;
  recorder = nextRecorder;
  chunks = [];
  stopPromise = null;
  pendingMetadata = normalizeMetadata(metadata);
  recordingStartedAt = Date.now();

  recorder.ondataavailable = (event) => {
    if (event?.data && event.data.size > 0) chunks.push(event.data);
  };

  recorder.onerror = (event) => {
    console.error('Agency OS recorder error:', event?.error);
    releaseStream(stream);
  };

  // A one-second timeslice keeps chunks flowing, so a hard suspension still
  // leaves something recoverable rather than one buffer that never flushed.
  recorder.start(1000);

  return { started: true, mimeType: recorder.mimeType || mimeType || '' };
}

function cleanupRecorder() {
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onerror = null;
  }
  recorder = null;
  chunks = [];
  stopPromise = null;
  pendingMetadata = null;
  recordingStartedAt = 0;
  stream = null;
}

/**
 * Stop and assemble the capture.
 *
 * The final `dataavailable` fires AFTER `stop()`, so resolving on the stop call
 * itself loses the tail of the sentence. This waits for the event, and also
 * waits for the recorder to be genuinely inactive before the tracks are cut.
 */
function finalizeStop() {
  if (stopPromise) return stopPromise;

  if (!recorder) return Promise.resolve({ blob: null, metadata: null });

  const activeRecorder = recorder;
  const activeStream = stream;
  const metadata = pendingMetadata || {};

  stopPromise = new Promise((resolve) => {
    let settled = false;
    let guard = null;

    const settle = () => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);

      const type = activeRecorder.mimeType || chunks[0]?.type || 'audio/webm';
      const blob = new Blob(chunks, { type });

      // Release the hardware on EVERY path — normal stop, recorder error, or a
      // stop() that threw. A stuck track drains the battery and holds OS audio
      // focus away from the agent's next call.
      releaseStream(activeStream);
      cleanupRecorder();

      resolve({ blob: blob.size > 0 ? blob : null, metadata });
    };

    activeRecorder.addEventListener('stop', settle, { once: true });
    activeRecorder.addEventListener('error', settle, { once: true });
    // A browser that never fires either event must not hang the caller forever.
    guard = setTimeout(settle, STOP_GRACE_MS);

    try {
      if (activeRecorder.state !== 'inactive') activeRecorder.stop();
      else settle();
    } catch (err) {
      console.error('Agency OS recorder stop failed:', err);
      settle();
    }
  });

  return stopPromise;
}

/** @returns {Promise<Blob|null>} the finished capture, or null if empty. */
export async function stopRecording() {
  const { blob } = await finalizeStop();
  return blob;
}

function dispatchAudioQueued(detail) {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    if (typeof CustomEvent === 'undefined') return;
    window.dispatchEvent(new CustomEvent(AUDIO_QUEUED_EVENT, { detail }));
  } catch {
    /* an event nobody hears is not a failure */
  }
}

/**
 * Halt the recorder and park the partial capture in the outbox.
 *
 * Used by the visibility defense and available to any caller that needs to end
 * a recording without the user tapping stop.
 */
export async function suspendRecordingToOutbox() {
  const { blob, metadata } = await finalizeStop();
  if (!blob) return null;

  const { key, record } = await enqueueAudio(blob, {
    company_id: metadata?.company_id ?? null,
    mode: metadata?.mode,
    timestamp: metadata?.timestamp
  });

  dispatchAudioQueued({ key, size: blob.size, mode: record.mode, company_id: record.company_id, reason: 'visibility-hidden' });
  return { key, blob, record };
}

let visibilityHandler = null;

/**
 * If the document is hidden while recording — the agent answers a phone call,
 * locks the screen, or switches apps — stop, save what exists, and let go of
 * the microphone.
 */
export function initVisibilityRecordingDefense() {
  if (visibilityHandler) return visibilityHandler;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return null;

  visibilityHandler = () => {
    if (typeof document.visibilityState !== 'string' || document.visibilityState !== 'hidden') return;
    if (!isRecording()) return;

    suspendRecordingToOutbox().catch((err) => {
      console.error('Agency OS visibility recording defense failed:', err);
    });
  };

  document.addEventListener('visibilitychange', visibilityHandler);
  return visibilityHandler;
}

export function destroyVisibilityRecordingDefense() {
  if (!visibilityHandler) return;
  if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = null;
}
