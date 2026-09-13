/**
 * Agency OS — workspace mounting and the sun-glare theme.
 *
 * Sprint 4 will drop real views (the dialer card stack, the Leaflet canvass
 * map, the triage grid) into the same contract this file establishes: a mode
 * goes in, a mounted subtree comes out, and whatever the previous mode left
 * behind is torn down before the next one renders.
 *
 * The placeholders below are intentionally boring. They exist so the state
 * machine, the unmount path and the theme can be exercised end to end before
 * any map engine is on the other side of them.
 *
 * Nothing here runs at import time, and nothing touches the DOM until a mount
 * function is actually called with a container.
 */

import { MODES, getState, setState, subscribe } from './state.js';
import { mountDialerView } from './dialer-view.js';
import { mountCanvassView } from './canvass-view.js';
import { mountTriageView } from './triage-view.js';

export const VIEW_CONTAINER_ID = 'view-container';
export const THEME_STORAGE_KEY = 'agency_os_theme';
export const THEME_HIGH_CONTRAST = 'high-contrast';
export const THEME_DEFAULT = 'default';

const MODE_HEADINGS = {
  PHONE: 'Phone Mode Active',
  FIELD: 'Field Mode Active',
  TRIAGE: 'Triage Mode Active'
};

const MODE_ICONS = {
  PHONE: '📞',
  FIELD: '📍',
  TRIAGE: '📋'
};

/**
 * Which module renders each workspace.
 *
 * A mode with no factory falls through to a placeholder note rather than to an
 * empty screen, so adding a fourth mode cannot produce a blank workspace.
 */
const VIEW_FACTORIES = {
  PHONE: mountDialerView,
  FIELD: mountCanvassView,
  TRIAGE: mountTriageView
};

// ---------------------------------------------------------------------
// SHELL VISIBILITY
// ---------------------------------------------------------------------

/**
 * Toggle between the Agency OS workspaces and the legacy console.
 *
 * The two shells coexist in the document and neither is ever removed: the
 * legacy scripts keep their element references and their listeners, and this
 * attribute is the only thing that decides which one is painted. That is why
 * `#legacy-shell` is hidden with CSS rather than detached.
 */
export function applyShellVisibility(agencyActive) {
  try {
    const body = typeof document !== 'undefined' ? document.body : null;
    if (!body || typeof body.setAttribute !== 'function') return agencyActive;

    if (agencyActive) body.setAttribute('data-agency-shell', 'active');
    else body.removeAttribute('data-agency-shell');

    if (!agencyActive) revealLegacyView();
    return Boolean(agencyActive);
  } catch {
    return Boolean(agencyActive);
  }
}

/**
 * The legacy pair of tabs predate this shell, so nothing re-measures them when
 * they come back from `display: none`. Re-emitting the event they already
 * listen for makes the Leaflet map re-measure instead of showing a grey box.
 */
function revealLegacyView() {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    if (typeof CustomEvent === 'undefined') return;

    const active = typeof document !== 'undefined'
      ? document.querySelector?.('.view.active')
      : null;
    const view = active?.id ? active.id.replace('view-', '') : 'field';

    window.dispatchEvent(new CustomEvent('viewactivated', { detail: { view } }));
  } catch {
    /* the console still works; only the map resize hint is lost */
  }
}

/** Reflect the active mode on the top-bar buttons. */
function syncChrome(mode) {
  if (typeof document === 'undefined') return;
  try {
    for (const button of document.querySelectorAll('[data-agency-mode]')) {
      const isActive = String(button.getAttribute('data-agency-mode') || '').toUpperCase() === mode;
      // classList is optional so a minimal DOM double still exercises this.
      button.classList?.toggle('active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    }
    for (const button of document.querySelectorAll('[data-agency-theme-toggle]')) {
      button.setAttribute('aria-pressed', String(isSunGlareTheme()));
    }
  } catch {
    /* chrome is cosmetic; never let it break a mode switch */
  }
}

// ---------------------------------------------------------------------
// SUN GLARE THEME
// ---------------------------------------------------------------------

function themeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function applyTheme(highContrast) {
  try {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (root) {
      if (highContrast) root.setAttribute('data-theme', THEME_HIGH_CONTRAST);
      else root.removeAttribute('data-theme');
    }
  } catch {
    /* no document — the preference is still returned to the caller */
  }

  try {
    themeStorage()?.setItem(THEME_STORAGE_KEY, highContrast ? THEME_HIGH_CONTRAST : THEME_DEFAULT);
  } catch {
    /* private mode: the toggle still works for this session */
  }

  return highContrast;
}

/**
 * Restore the last theme on boot.
 *
 * Applied before any paint path runs, because a high-contrast agent flipping to
 * a dark screen for one frame outdoors is exactly the problem this solves.
 */
export function initializeTheme() {
  let saved = null;
  try {
    saved = themeStorage()?.getItem(THEME_STORAGE_KEY) || null;
  } catch {
    saved = null;
  }
  return applyTheme(saved === THEME_HIGH_CONTRAST);
}

export function isSunGlareTheme() {
  try {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    return root?.getAttribute('data-theme') === THEME_HIGH_CONTRAST;
  } catch {
    return false;
  }
}

/**
 * Toggle the high-contrast attribute on <html>.
 * @param {boolean} [force] explicit value; omit to flip.
 */
export function toggleSunGlareTheme(force) {
  const next = typeof force === 'boolean' ? force : !isSunGlareTheme();
  return applyTheme(next);
}

// ---------------------------------------------------------------------
// MOUNTING
// ---------------------------------------------------------------------

let teardown = null;
let unsubscribe = null;
let boundButtons = [];
let boundHost = null;
let currentMode = null;

function resolveContainer(container) {
  if (container) return container;
  if (typeof document === 'undefined') return null;
  return document.getElementById(VIEW_CONTAINER_ID);
}

/**
 * Build one placeholder workspace.
 *
 * createElement + textContent only: this project never renders untrusted text
 * through innerHTML, and the same rule applies to chrome as to CRM data.
 */
function buildModeShell(mode, host) {
  const section = document.createElement('section');
  section.className = 'agency-view';
  section.id = `agency-view-${mode.toLowerCase()}`;
  section.setAttribute('data-agency-view', mode);
  section.setAttribute('role', 'tabpanel');
  section.setAttribute('aria-label', MODE_HEADINGS[mode]);

  const heading = document.createElement('h1');
  heading.className = 'agency-view-title';
  heading.textContent = MODE_HEADINGS[mode];

  // The view owns this element and may replace its children freely; the shell
  // keeps ownership of the section so the mode attribute and heading stay put.
  const body = document.createElement('div');
  body.className = 'agency-view-body';

  section.append(heading, body);
  host.replaceChildren(section);

  const factory = VIEW_FACTORIES[mode];
  if (typeof factory === 'function') {
    try {
      const result = factory(body);
      if (typeof result === 'function') teardown = result;
    } catch (err) {
      // A view that cannot mount must not take the shell down with it.
      console.error(`Agency OS ${mode} view failed to mount:`, err);
      body.textContent = 'This workspace could not be mounted. Reload to try again.';
    }
  } else {
    const note = document.createElement('p');
    note.className = 'agency-view-note';
    note.textContent = `${MODE_ICONS[mode]} This workspace is not built yet.`;
    body.append(note);
  }

  return section;
}

function runTeardown() {
  if (typeof teardown !== 'function') return;
  try {
    teardown();
  } catch (err) {
    // A view that throws while cleaning up must not strand the next mount.
    console.error('Agency OS view teardown failed:', err);
  }
  teardown = null;
}

/**
 * Mount a workspace for `mode`.
 *
 * @param {'PHONE'|'FIELD'|'TRIAGE'} mode
 * @param {Element} [container] defaults to #view-container
 * @returns {Element|null} the mounted section, or null when there is no host
 */
export function mountMode(mode, container) {
  if (!MODES.includes(mode)) {
    throw new RangeError(`Unknown Agency OS mode: ${mode}`);
  }

  const host = resolveContainer(container);
  if (!host) return null;

  // Deterministic teardown BEFORE mounting. A Sprint 4 map view has to release
  // its listeners, tiles and animation frames here or every mode switch leaks.
  runTeardown();

  const section = buildModeShell(mode, host);
  currentMode = mode;
  applyShellVisibility(true);
  syncChrome(mode);
  return section;
}

export function mountPhoneMode(container) {
  return mountMode('PHONE', container);
}

export function mountFieldMode(container) {
  return mountMode('FIELD', container);
}

export function mountTriageMode(container) {
  return mountMode('TRIAGE', container);
}

export function getMountedMode() {
  return currentMode;
}

/** Tear down the active view and empty the host. */
export function unmountCurrentMode(container) {
  runTeardown();
  currentMode = null;

  const host = resolveContainer(container);
  try {
    host?.replaceChildren();
  } catch (err) {
    console.error('Agency OS unmount failed:', err);
  }
}

/**
 * Wire the controller: render the current mode, follow the store, and bind any
 * mode buttons present in the shell.
 *
 * @param {{container?: Element}} [options]
 * @returns {Function|null} cleanup, or null when there is no host to mount into
 */
export function initNavigation(options = {}) {
  const host = resolveContainer(options.container);
  if (!host || typeof document === 'undefined') return null;

  // Idempotent for the same host: a second call must not double-subscribe.
  if (unsubscribe && boundHost === host) return destroyNavigation;
  if (unsubscribe) destroyNavigation();

  boundHost = host;
  mountMode(getState().mode, host);

  unsubscribe = subscribe(({ state, changedKeys }) => {
    if (changedKeys.includes('mode')) mountMode(state.mode, host);
  });

  for (const button of document.querySelectorAll('[data-agency-mode]')) {
    const handler = () => {
      const requested = String(button.getAttribute('data-agency-mode') || '').toUpperCase();
      if (!MODES.includes(requested)) return;
      // Tapping a mode always returns to the Agency shell, even when the mode
      // itself did not change (so the button doubles as "come back here").
      applyShellVisibility(true);
      setState({ mode: requested });
    };
    button.addEventListener('click', handler);
    boundButtons.push({ button, handler });
  }

  // Sun-glare toggle: the top bar owns the control, this module owns the state.
  for (const button of document.querySelectorAll('[data-agency-theme-toggle]')) {
    const handler = () => {
      const highContrast = toggleSunGlareTheme();
      button.setAttribute('aria-pressed', String(highContrast));
    };
    button.addEventListener('click', handler);
    boundButtons.push({ button, handler });
  }

  // Escape hatch back to the legacy console.
  for (const button of document.querySelectorAll('[data-agency-legacy]')) {
    const handler = () => applyShellVisibility(false);
    button.addEventListener('click', handler);
    boundButtons.push({ button, handler });
  }

  syncChrome(getState().mode);
  return destroyNavigation;
}

export function destroyNavigation() {
  if (typeof unsubscribe === 'function') {
    unsubscribe();
    unsubscribe = null;
  }

  for (const { button, handler } of boundButtons) {
    try {
      button.removeEventListener('click', handler);
    } catch {
      /* the node is already detached */
    }
  }
  boundButtons = [];

  runTeardown();
  boundHost = null;
  currentMode = null;
  // With no Agency view left there is nothing to look at, so hand the screen
  // back to the legacy console rather than leaving an empty shell.
  applyShellVisibility(false);
}
