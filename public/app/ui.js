/**
 * Shared UI primitives: toasts, DOM building, and the desktop view switcher.
 *
 * Everything here builds DOM with textContent/createElement. Company names,
 * transcripts and model output all flow through this layer, and none of it is
 * trusted enough for innerHTML.
 */

export const $ = (id) => document.getElementById(id);

/** createElement with class, text and attributes in one call. */
export function el(tag, { className, text, attrs, children } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (children) node.append(...children.filter(Boolean));
  return node;
}

/** A <td>. `text` is always escaped by virtue of textContent. */
export const td = (text, className) => el('td', { text: text ?? '', className });

// ---------------------------------------------------------------------
// TOASTS
// ---------------------------------------------------------------------
export function showToast(message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;

  const toast = el('div', { className: `toast ${type}`, children: [el('span', { text: message })] });
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    // animationend may never fire (reduced motion, background tab, interrupted
    // animation) — a timed fallback guarantees the node is reclaimed.
    const remove = () => toast.remove();
    toast.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 1000);
  }, 3600);
}

// ---------------------------------------------------------------------
// BUTTON BUSY STATE
// ---------------------------------------------------------------------

/** Swap a button's label for a spinner, and restore it afterwards. */
export function setButtonBusy(button, busy, busyLabel = 'Working…') {
  if (!button) return;
  const slot = button.querySelector('.btn-text') || button;
  if (busy) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = slot.textContent;
    button.disabled = true;
    slot.replaceChildren(el('span', { className: 'spinner' }), document.createTextNode(` ${busyLabel}`));
  } else {
    button.disabled = false;
    slot.textContent = button.dataset.idleLabel || slot.textContent;
  }
}

// ---------------------------------------------------------------------
// VIEW SWITCHER (desktop sidebar)
// ---------------------------------------------------------------------

const viewListeners = new Map();

/** Run a callback the first time a view is opened — lazy data loading. */
export function onViewOpen(view, callback) {
  viewListeners.set(view, { callback, loaded: false });
}

export function activateView(view) {
  document.querySelectorAll('.view').forEach((section) => {
    const isTarget = section.id === `view-${view}`;
    section.classList.toggle('active', isTarget);
    section.hidden = !isTarget;
  });

  document.querySelectorAll('.nav-item').forEach((button) => {
    const isTarget = button.dataset.view === view;
    button.classList.toggle('active', isTarget);
    button.setAttribute('aria-selected', String(isTarget));
  });

  const listener = viewListeners.get(view);
  if (listener && !listener.loaded) {
    listener.loaded = true;
    listener.callback();
  }

  // Leaflet renders nothing into a display:none container, so any map inside a
  // freshly revealed view has to be told its size changed.
  window.dispatchEvent(new CustomEvent('viewactivated', { detail: { view } }));
}

export function initViewSwitcher() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => activateView(button.dataset.view));
  });
}

// ---------------------------------------------------------------------
// FETCH HELPERS
// ---------------------------------------------------------------------

/** JSON fetch that turns a non-2xx into a thrown Error carrying the message. */
export async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': 'LEGACY_EDGE_KEY_2026',
    ...(options.headers || {})
  };
  const res = await fetch(path, { ...options, headers });
  const contentType = res.headers.get('Content-Type') || '';
  const data = contentType.includes('json') ? await res.json().catch(() => ({})) : {};

  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const apiPost = (path, body) => apiFetch(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': 'LEGACY_EDGE_KEY_2026' },
  body: JSON.stringify(body)
});

// ---------------------------------------------------------------------
// MISC
// ---------------------------------------------------------------------

export const BUSINESS_TZ = 'America/Chicago';

/**
 * Today in Springfield. An agent checking the console at 9pm must not ask for
 * tomorrow's UTC date and get an empty table.
 */
export const businessDate = (instant = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(instant);

/** 'HH:MM' in Springfield time, from a D1 'YYYY-MM-DD HH:MM:SS' UTC stamp. */
export function localTime(timestamp) {
  if (!timestamp) return '';
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(timestamp)
    ? timestamp
    : `${String(timestamp).replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(parsed));
}

export const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;
