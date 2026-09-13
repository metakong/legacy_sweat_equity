/**
 * Agency OS — Phone Mode (the dialer).
 *
 * Built for 100 dials a day, which means the whole card is a touch target, the
 * three dead-end outcomes are one tap each, and nothing on screen requires a
 * second look. The card stack never shows more than the account being dialed:
 * a list invites browsing, and browsing is not dialing.
 *
 * POST-CALL RESUME
 * Tapping the number hands control to the native dialer, so the page goes
 * hidden and comes back with no event of its own. The `visibilitychange`
 * listener is that event: it pulses the disposition controls on return, because
 * the agent's next action is always "record what happened", and forgetting it
 * costs the call.
 *
 * OFFLINE BEHAVIOUR
 * The agent taps a quick drop AFTER the call has already ended, so the tap is
 * the record of a dial that really happened. If it cannot reach the server the
 * payload goes to the IndexedDB action outbox and the card advances anyway:
 * freezing the stack to argue with a dropped connection costs the next dial too.
 *
 * A 4xx is the exception to the queueing rule — it will fail identically on
 * every retry, so it is reported and dropped rather than replayed forever. The
 * card still advances; the agent is told it was not recorded.
 */

import { el } from '../ui.js';
import { telHref } from '../field.js';
import { enqueueAction } from './state.js';
import { createVoiceWidget } from './voice-widget.js';

export const LEADS_ENDPOINT = '/api/leads';
export const ACTIVITY_ENDPOINT = '/api/activity';

/** The three dead ends. Order matches the muscle memory of a phone block. */
export const DIALER_QUICK_DROPS = [
  { key: 'VM_NO_ANSWER', label: 'VM / No Answer', hint: 'Voicemail or nobody picked up' },
  { key: 'GATEKEEPER_BLOCK', label: 'Gatekeeper', hint: 'Blocked at the front desk' },
  { key: 'WRONG_NUMBER', label: 'Wrong Number', hint: 'Disqualifies this record' }
];

/** How long the post-call prompt stays lit before it stops nagging. */
const PULSE_MS = 6000;

async function requestJson(url, { fetchImpl, init } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    const error = new Error('network unavailable');
    error.status = 0;
    error.retryable = true;
    throw error;
  }

  let res;
  try {
    res = await doFetch(url, init);
  } catch (cause) {
    // The request never reached the server: offline, DNS, or a dropped socket.
    const error = new Error('network unreachable');
    error.status = 0;
    error.retryable = true;
    error.cause = cause;
    throw error;
  }

  if (!res || !res.ok) {
    const error = new Error(`request failed (${res?.status ?? 'no response'})`);
    // status 0 (no response at all) and 5xx are transient and worth queueing;
    // 4xx is the server rejecting the payload and will reject it again.
    error.status = res?.status ?? 0;
    error.retryable = !error.status || error.status >= 500;
    throw error;
  }

  return res.json();
}

/**
 * @param {Element} container
 * @param {{fetchImpl?: Function, onExhausted?: Function}} [options]
 * @returns {Function} teardown
 */
export function mountDialerView(container, options = {}) {
  const { fetchImpl, onExhausted } = options;

  let leads = [];
  let index = 0;
  let busy = false;
  let destroyed = false;
  let pulseTimer = null;
  let voiceWidget = null;

  const root = el('div', { className: 'dialer-view' });
  const progress = el('p', {
    className: 'dialer-progress',
    attrs: { role: 'status', 'aria-live': 'polite' }
  });
  const status = el('p', { className: 'dialer-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const cardHost = el('div', { className: 'dialer-card-host' });
  const actions = el('div', { className: 'dialer-actions' });

  root.append(progress, cardHost, status, actions);
  container.replaceChildren(root);

  const setStatus = (message) => { status.textContent = message || ''; };

  function setProgress() {
    progress.textContent = leads.length
      ? `Lead ${Math.min(index + 1, leads.length)} of ${leads.length}`
      : '';
  }

  function pulse() {
    if (destroyed) return;
    // classList is optional so a minimal DOM double still runs this path.
    root.classList?.add('needs-disposition');
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => root.classList?.remove('needs-disposition'), PULSE_MS);
  }

  function renderExhausted() {
    cardHost.replaceChildren(el('div', {
      className: 'agency-empty',
      children: [
        el('h2', { text: '🎉 Call list cleared' }),
        el('p', {
          text: 'No phone leads left in the 30–79 confidence band. Switch to 📍 Field, or import more targets in 📋 Triage.'
        })
      ]
    }));
    actions.replaceChildren();
    if (voiceWidget) { voiceWidget.destroy(); voiceWidget = null; }
    progress.textContent = 'Queue cleared';
    if (typeof onExhausted === 'function') onExhausted();
  }

  function renderCard() {
    const lead = leads[index];
    if (!lead) { renderExhausted(); return; }

    const name = el('h2', { className: 'dialer-company', text: lead.company_name || 'Unknown account' });
    // The company column is decision_maker; /api/leads also aliases it to
    // decision_maker_name so the two spellings cannot drift.
    const dm = el('p', {
      className: 'dialer-dm',
      text: lead.decision_maker_name || lead.decision_maker || 'Decision maker unknown'
    });

    const phone = lead.company_phone || '';
    const href = telHref(phone);
    const dial = href
      ? el('a', {
        className: 'dialer-call',
        text: phone,
        // telHref already restricts the value to digits, an optional + and
        // ;ext=, so a CRM string can never smuggle a scheme into the href.
        attrs: { href, 'data-dial': '' }
      })
      : el('div', { className: 'dialer-call dialer-call-missing', text: 'No phone on file' });

    const metaBits = [
      Number.isFinite(Number(lead.confidence_score)) ? `${lead.confidence_score}% confidence` : null,
      lead.current_voluntary_carrier ? `Carrier: ${lead.current_voluntary_carrier}` : null,
      lead.estimated_w2_count ? `${lead.estimated_w2_count} W-2` : null,
      lead.pipeline_stage || null
    ].filter(Boolean);

    cardHost.replaceChildren(el('article', {
      className: 'dialer-card',
      children: [
        name,
        dm,
        dial,
        el('p', { className: 'dialer-meta', text: metaBits.join(' · ') })
      ]
    }));
  }

  async function quickDrop(key) {
    const lead = leads[index];
    if (!lead || busy || destroyed) return;

    // Captured before any await: renderCard() replaces `leads[index]` underneath
    // this call, and the disposition belongs to the account that was on screen.
    const dropped = lead;

    busy = true;
    setStatus('');
    const buttons = actions.querySelectorAll?.('[data-quick-drop]') || [];
    for (const button of buttons) button.disabled = true;

    let message = 'Logged';

    try {
      const result = await requestJson(ACTIVITY_ENDPOINT, {
        fetchImpl,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company_id: dropped.company_id, disposition: key, mode: 'PHONE' })
        }
      });

      if (result?.disqualified) message = 'Logged · record disqualified';
    } catch (err) {
      console.error('Agency OS quick drop failed:', err);

      if (err?.retryable) {
        // Offline or a server-side outage. The tap already happened, so the
        // queue keeps it and the dialer keeps moving.
        const queued = await enqueueAction({
          company_id: dropped.company_id,
          disposition: key,
          mode: 'PHONE'
        }).catch(() => null);

        message = queued
          ? 'Offline — queued, will sync when signal returns'
          : 'Offline — could not queue this disposition';
      } else {
        message = `Server rejected this (${err?.status}) — not recorded`;
      }
    } finally {
      busy = false;
    }

    // Advance on every outcome. An agent mid-phone-block must never be stopped
    // by the network, and the disposition is either logged or safely queued.
    index += 1;
    setProgress();
    renderCard();
    setStatus(message);
  }

  function renderActions() {
    if (voiceWidget) { voiceWidget.destroy(); voiceWidget = null; }
    actions.replaceChildren();

    const lead = leads[index];
    if (!lead) return;

    const grid = el('div', { className: 'quick-drop-grid' });
    for (const drop of DIALER_QUICK_DROPS) {
      const button = el('button', {
        className: `quick-drop-btn quick-drop-${drop.key.toLowerCase()}`,
        text: drop.label,
        attrs: {
          type: 'button',
          title: drop.hint,
          'data-quick-drop': drop.key,
          'aria-label': `${drop.label} — ${drop.hint}`
        }
      });
      button.addEventListener('click', () => quickDrop(drop.key));
      grid.append(button);
    }

    voiceWidget = createVoiceWidget({
      companyId: lead.company_id,
      mode: 'PHONE',
      // A substantive conversation is the one outcome the quick drops cannot
      // express, so saving the note is what moves the stack on.
      onSaved: () => {
        index += 1;
        setProgress();
        renderCard();
        setStatus('Voice note queued — transcribes when online.');
      }
    });

    actions.append(grid, voiceWidget.element);
  }

  async function load() {
    setStatus('Loading today’s call list…');
    try {
      const payload = await requestJson(`${LEADS_ENDPOINT}?mode=PHONE`, { fetchImpl });
      leads = Array.isArray(payload?.data) ? payload.data : [];
      index = 0;
      setStatus('');
      setProgress();
      renderActions();
      renderCard();
    } catch (err) {
      console.error('Agency OS dialer load failed:', err);
      leads = [];
      cardHost.replaceChildren(el('div', {
        className: 'agency-empty',
        children: [
          el('h2', { text: 'Call list unavailable' }),
          el('p', { text: 'Could not load leads. Check the connection and reload.' })
        ]
      }));
      actions.replaceChildren();
      progress.textContent = '';
      setStatus('');
    }
  }

  // The OS dialer takes over the screen, so returning is the only signal that a
  // call ended and a disposition is now owed.
  const onVisibilityChange = () => {
    if (destroyed) return;
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    if (!leads.length) return;
    pulse();
  };

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  load();

  return function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (pulseTimer) clearTimeout(pulseTimer);
    if (voiceWidget) { voiceWidget.destroy(); voiceWidget = null; }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    root.replaceChildren();
    // The view mounted itself as the container's only child; leaving an empty
    // wrapper behind would accumulate one more per mode switch.
    container.replaceChildren();
  };
}

