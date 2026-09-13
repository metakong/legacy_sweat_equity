/**
 * Agency OS — the Hold-to-Talk control.
 *
 * One widget, used by both the dialer and the canvass list, so the mic
 * behaviour and the outbox contract cannot diverge between modes.
 *
 * WHY HOLD RATHER THAN TAP-TO-START/TAP-TO-STOP
 * A tap toggle leaves the microphone open whenever the agent forgets the second
 * tap — at a front desk, in a car, mid-conversation with the next prospect. A
 * physical hold cannot be left on by accident, and its release IS the save.
 *
 * The capture itself belongs to modules/audio.js; this file only decides when
 * to start and stop it, and hands the finished blob to the outbox.
 */

import { startRecording, stopRecording, isRecording } from './audio.js';
import { enqueueAudio } from './state.js';

export const VOICE_WIDGET_LABELS = {
  idle: 'Hold to Talk',
  recording: 'Release to save',
  saving: 'Saving…',
  saved: 'Saved to outbox',
  empty: 'Nothing captured — hold longer',
  failed: 'Could not save — try again'
};

/**
 * @param {object} [options]
 * @param {string|null} [options.companyId] account the debrief belongs to
 * @param {'PHONE'|'FIELD'} [options.mode]
 * @param {(result: object|null, widget: object) => void} [options.onSaved]
 * @returns {{ element: Element, destroy: Function, setStatus: Function, isBusy: Function }}
 */
export function createVoiceWidget(options = {}) {
  const { companyId = null, mode = 'FIELD', onSaved = null } = options;

  const root = document.createElement('div');
  root.className = 'voice-widget';
  root.setAttribute('data-voice-widget', '');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'voice-hold-btn';
  button.setAttribute('data-voice-hold', '');
  button.setAttribute('aria-pressed', 'false');

  const glyph = document.createElement('span');
  glyph.className = 'voice-hold-icon';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '🎙️';

  const label = document.createElement('span');
  label.className = 'voice-hold-label';
  label.textContent = VOICE_WIDGET_LABELS.idle;

  button.append(glyph, label);

  const status = document.createElement('p');
  status.className = 'voice-widget-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  root.append(button, status);

  let busy = false;
  let destroyed = false;
  // Tracks the physical button state so an async getUserMedia gap cannot leave a
  // recording running with nothing pressed.
  let held = false;

  const setStatus = (message) => {
    status.textContent = message || '';
  };

  const setPressed = (pressed) => {
    button.setAttribute('aria-pressed', String(pressed));
    button.classList?.toggle('recording', pressed);
  };

  const setLabel = (text) => {
    label.textContent = text;
  };

  async function beginHold(event) {
    if (destroyed || busy || isRecording()) return;
    if (event?.pointerId !== undefined && typeof button.setPointerCapture === 'function') {
      try { button.setPointerCapture(event.pointerId); } catch { /* not supported */ }
    }

    setStatus('');
    try {
      const started = await startRecording({ company_id: companyId, mode });
      if (started?.started === false) return;

      // A fast tap can finish before the microphone opens. Stopping straight
      // away is correct: the agent held the button for less than the permission
      // prompt, so there is nothing to keep.
      if (held === false) {
        await finishHold();
        return;
      }

      if (destroyed) return;
      setPressed(true);
      setLabel(VOICE_WIDGET_LABELS.recording);
    } catch (err) {
      console.error('Agency OS microphone start failed:', err);
      setStatus(VOICE_WIDGET_LABELS.failed);
    }
  }

  async function finishHold() {
    if (destroyed || busy || !isRecording()) return;
    busy = true;
    setPressed(false);
    setLabel(VOICE_WIDGET_LABELS.saving);

    try {
      const blob = await stopRecording();
      if (!blob) {
        setStatus(VOICE_WIDGET_LABELS.empty);
        return;
      }

      const saved = await enqueueAudio(blob, { company_id: companyId, mode });
      setStatus(`${VOICE_WIDGET_LABELS.saved} (${Math.round(blob.size / 1024)} KB)`);
      if (typeof onSaved === 'function') onSaved({ ...saved, blob }, widget);
    } catch (err) {
      console.error('Agency OS voice outbox failed:', err);
      setStatus(VOICE_WIDGET_LABELS.failed);
    } finally {
      busy = false;
      if (!destroyed) setLabel(VOICE_WIDGET_LABELS.idle);
    }
  }

  const onPointerDown = (event) => {
    held = true;
    beginHold(event);
  };
  const onPointerUp = () => {
    held = false;
    finishHold();
  };
  const onKeyDown = (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (event.repeat) return;
    held = true;
    beginHold(event);
  };
  const onKeyUp = (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    held = false;
    finishHold();
  };

  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('pointerup', onPointerUp);
  button.addEventListener('pointercancel', onPointerUp);
  button.addEventListener('pointerleave', onPointerUp);
  // Keyboard parity: on a laptop this control is the only way to keep a note.
  button.addEventListener('keydown', onKeyDown);
  button.addEventListener('keyup', onKeyUp);

  const widget = {
    element: root,
    setStatus,
    isBusy: () => busy
  };

  widget.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    held = false;

    button.removeEventListener('pointerdown', onPointerDown);
    button.removeEventListener('pointerup', onPointerUp);
    button.removeEventListener('pointercancel', onPointerUp);
    button.removeEventListener('pointerleave', onPointerUp);
    button.removeEventListener('keydown', onKeyDown);
    button.removeEventListener('keyup', onKeyUp);

    // A mode switch during a recording must not leave the mic hot.
    if (isRecording()) stopRecording().catch(() => {});
  };

  return widget;
}
