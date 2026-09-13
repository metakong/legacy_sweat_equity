/**
 * Agency OS — D365 compliance export.
 *
 * The agent has to hand Dynamics 365 five numbers at the end of every day. Doing
 * that by hand from three screens is where the numbers go wrong, so this module
 * reads the merged counters once and puts the exact paste-block on the
 * clipboard.
 *
 * WHY THE DATE MATH IS DUPLICATED HERE
 * src/lib/time.js owns businessDate() for the Worker, but the PWA cannot import
 * it: public/ is the Worker's asset root, so ../../src/ is not a path that
 * exists at runtime — and even where it resolved, it would sit outside the
 * service worker's precache list and break the offline case this module exists
 * for. One Intl call is a cheaper price than a broken precache.
 */

import { el, showToast } from '../ui.js';

export const D365_AGGREGATES_URL = '/api/eod-aggregates';

/** Same zone the Worker keys its business days to. */
export const BUSINESS_TZ = 'America/Chicago';

/** Field order and labels are exactly what the D365 paste target expects. */
export const D365_LABELS = {
  walk_ins: 'WALK-INS',
  dm_contacts: 'DM CONTACTS',
  phone_dials: 'PHONE DIALS',
  appointments_set: 'APPOINTMENTS'
};

export const D365_FIELD_ORDER = ['walk_ins', 'dm_contacts', 'phone_dials', 'appointments_set'];

/**
 * Today's date in Springfield, as YYYY-MM-DD.
 *
 * UTC would roll the report over at 7pm local (6pm in winter), which is the
 * middle of an evening phone block — the day's last five dials would land on
 * tomorrow's report.
 */
export function todayInSpringfield(instant = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** A counter that is missing or NaN is zero, never "NaN" on the clipboard. */
export function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/**
 * The clipboard block, byte for byte:
 *
 *   DATE: 2026-09-12
 *   WALK-INS: 3
 *   DM CONTACTS: 5
 *   PHONE DIALS: 42
 *   APPOINTMENTS: 2
 */
export function formatD365Report(payload = {}, { date } = {}) {
  const resolvedDate = date || payload?.date || todayInSpringfield();

  return [
    `DATE: ${resolvedDate}`,
    ...D365_FIELD_ORDER.map((key) => `${D365_LABELS[key]}: ${toCount(payload?.[key])}`)
  ].join('\n');
}

/** Read the merged counters. Throws with a readable message on failure. */
export async function fetchD365Aggregates({ fetchImpl, date } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('network unavailable');

  const url = date
    ? `${D365_AGGREGATES_URL}?date=${encodeURIComponent(date)}`
    : D365_AGGREGATES_URL;

  let res;
  try {
    res = await doFetch(url);
  } catch (cause) {
    const error = new Error('network unreachable');
    error.cause = cause;
    throw error;
  }

  if (!res || !res.ok) {
    throw new Error(`request failed (${res?.status ?? 'no response'})`);
  }

  return res.json();
}

/**
 * Render the "Generate D365 Report" control.
 *
 * @param {Element} [container] host to append into
 * @param {{fetchImpl?: Function, copyImpl?: Function, showToastImpl?: Function, date?: string}} [options]
 * @returns {{element: Element, generate: Function, isBusy: Function, destroy: Function}}
 */
export function mountD365Exporter(container, options = {}) {
  const { fetchImpl, copyImpl, showToastImpl, date } = options;

  let destroyed = false;
  let busy = false;

  const root = el('div', { className: 'd365-export' });
  const button = el('button', {
    className: 'd365-export-btn',
    text: '📋 Generate D365 Report',
    attrs: { type: 'button', 'data-d365-export': '' }
  });
  const status = el('p', {
    className: 'd365-export-status',
    attrs: { role: 'status', 'aria-live': 'polite' }
  });
  // Shown only when the clipboard is out of reach, so the numbers are still
  // recoverable instead of vanishing behind a failed tap.
  const fallback = el('pre', { className: 'd365-export-fallback', attrs: { hidden: 'hidden' } });

  root.append(button, status, fallback);
  if (container) container.append(root);

  const toast = (message, type) => {
    // A toast is a nicety; it must never be the reason a copy fails.
    try {
      (showToastImpl || showToast)(message, type);
    } catch {
      /* no toast container in this context */
    }
  };

  const setStatus = (message) => { status.textContent = message || ''; };

  async function generate() {
    if (destroyed || busy) return null;
    busy = true;
    setStatus('Reading today’s counters…');
    fallback.setAttribute('hidden', 'hidden');

    try {
      const payload = await fetchD365Aggregates({ fetchImpl, date });
      const text = formatD365Report(payload, { date });

      const copied = await (copyImpl || copyToClipboard)(text);

      if (copied) {
        setStatus('✅ Copied! Paste it into D365.');
        toast('D365 report copied', 'success');
      } else {
        fallback.textContent = text;
        fallback.removeAttribute('hidden');
        setStatus('Clipboard unavailable — select the block above and copy it.');
        toast('Could not reach the clipboard', 'error');
      }

      return text;
    } catch (err) {
      console.error('Agency OS D365 export failed:', err);
      setStatus(`Could not build the report (${err.message}).`);
      toast('D365 report failed', 'error');
      return null;
    } finally {
      busy = false;
    }
  }

  button.addEventListener('click', generate);

  return {
    element: root,
    generate,
    isBusy: () => busy,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      button.removeEventListener('click', generate);
      root.replaceChildren();
    }
  };
}

/**
 * Copy text, falling back to the legacy textarea trick.
 *
 * navigator.clipboard needs a secure context; a PWA opened over http on a
 * tethered laptop does not have one, and "retype five numbers" is not an
 * acceptable failure mode for a button whose whole job is to save that typing.
 *
 * @returns {Promise<boolean>} whether the text reached the clipboard
 */
export async function copyToClipboard(text, options = {}) {
  const nav = options.nav || (typeof navigator !== 'undefined' ? navigator : null);
  const doc = options.doc || (typeof document !== 'undefined' ? document : null);

  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* insecure context or a denied permission — try the legacy path */
  }

  try {
    if (!doc?.body || typeof doc.createElement !== 'function') return false;

    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // Positioning is cosmetic and a minimal DOM double may not have `style`;
    // failing here would skip the copy itself, which is the part that matters.
    if (area.style) {
      area.style.position = 'fixed';
      area.style.top = '-1000px';
    }
    doc.body.append(area);

    area.select?.();
    const copied = typeof doc.execCommand === 'function' ? doc.execCommand('copy') : false;
    area.remove?.();
    return Boolean(copied);
  } catch {
    return false;
  }
}
