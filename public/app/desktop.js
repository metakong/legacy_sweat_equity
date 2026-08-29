/**
 * Desktop console (>=1024px) — the in-vehicle command centre on the Book Go.
 *
 * Three tabs, one job each:
 *   Route Planner   turn untouched accounts into a driving sequence
 *   Tier 1 Handoff  today's activity as a tab-delimited clipboard paste
 *   Tier 2/3 Sync   .xlsx for existing D365 leads, .csv for net-new
 */

import {
  $, el, td, showToast, setButtonBusy, apiFetch, apiPost,
  businessDate, localTime, onViewOpen
} from './ui.js';
import {
  D365_OPEN_LEADS_COLUMNS,
  D365_TIER2_KEY_COLUMNS,
  toTabDelimited,
  toTabDelimitedRow,
  toCsv,
  buildTier2Workbook,
  downloadFile,
  copyToClipboard,
  parseNotes
} from './d365.js';
import { renderMarkdown } from './markdown.js';
import { cacheDossier } from './store.js';

const MAX_ROUTE_STOPS = 12;

const desktopState = {
  targets: [],
  selectedTargets: new Set(),
  tier1Rows: [],
  exportRows: { tier2: [], tier3: [] },
  eodMarkdown: '',
  routeMap: null,
  routeLayer: null,
  routeStart: null
};

/** Haversine straight-line distance in miles. */
function haversineMiles(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.long - a.long);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

// =====================================================================
// TAB 1 — ROUTE PLANNER
// =====================================================================

async function loadTargets() {
  const body = $('targetsBody');
  body.replaceChildren(el('tr', { children: [td('Loading targets…', 'empty-cell')] }));

  const filterSelect = $('routeFilterSelect');
  const filter = filterSelect?.value || 'all_active';

  try {
    const data = await apiFetch(`/api/companies?filter=${encodeURIComponent(filter)}&limit=300`);
    desktopState.targets = (data.companies || []).filter((t) => t.lat !== null && t.long !== null);
    const missingCoords = (data.companies || []).length - desktopState.targets.length;
    renderTargets();
    if (missingCoords > 0) {
      showToast(`${missingCoords} account(s) have no coordinates and cannot be routed.`, 'info');
    }
  } catch (err) {
    body.replaceChildren(el('tr', { children: [td(`Could not load targets: ${err.message}`, 'empty-cell')] }));
  }
}

function renderTargets() {
  const body = $('targetsBody');

  if (desktopState.targets.length === 0) {
    body.replaceChildren(el('tr', {
      children: [td('No untouched accounts. Scout some in the field log.', 'empty-cell')]
    }));
    return;
  }

  body.replaceChildren(...desktopState.targets.map((target) => {
    const checkbox = el('input', {
      attrs: {
        type: 'checkbox',
        'aria-label': `Include ${target.company_name} in the route`,
        checked: desktopState.selectedTargets.has(target.company_id)
      }
    });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (desktopState.selectedTargets.size >= MAX_ROUTE_STOPS) {
          checkbox.checked = false;
          showToast(`Mapbox optimizes at most ${MAX_ROUTE_STOPS} stops per route.`, 'error');
          return;
        }
        desktopState.selectedTargets.add(target.company_id);
      } else {
        desktopState.selectedTargets.delete(target.company_id);
      }
    });

    return el('tr', {
      children: [
        el('td', { className: 'col-check', children: [checkbox] }),
        td(target.company_name),
        td([target.street_1, target.city].filter(Boolean).join(', ')),
        td(target.employees ?? '—')
      ]
    });
  }));
}

function initRouteMap() {
  if (desktopState.routeMap || typeof L === 'undefined') return;
  const container = $('routeMap');
  if (!container) return;

  desktopState.routeMap = L.map('routeMap').setView([37.2089, -93.2923], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(desktopState.routeMap);

  // Leaflet measures its container at construction. This one is built the
  // instant its tab is revealed, before the browser has flushed layout, so
  // without a re-measure it decides it is 0x0 and never requests a tile.
  resizeRouteMap();
}

function resizeRouteMap() {
  if (!desktopState.routeMap) return;
  requestAnimationFrame(() => desktopState.routeMap.invalidateSize());
  setTimeout(() => desktopState.routeMap.invalidateSize(), 250);
}

function renderRoute(result) {
  const summary = $('routeSummary');
  const steps = $('routeSteps');

  const providerLabel = {
    mapbox: 'Mapbox road network',
    heuristic: 'local estimate (no Mapbox token)',
    'heuristic-fallback': 'local estimate (Mapbox unavailable)',
    'single-stop': 'single stop'
  }[result.provider] || result.provider;

  summary.replaceChildren(
    el('p', {
      className: 'route-headline',
      text: `${result.sequence.length} stops · ${result.distance_miles} mi · ~${result.duration_minutes} min`
    }),
    el('p', { className: 'muted-note', text: `Optimized via ${providerLabel}.` })
  );

  steps.replaceChildren(...result.sequence.map((stop) => el('li', {
    children: [
      el('strong', { text: stop.company_name || 'Stop' }),
      el('span', {
        className: 'route-step-addr',
        text: [stop.street_1, stop.city].filter(Boolean).join(', ')
      })
    ]
  })));

  // Map overlay
  initRouteMap();
  if (desktopState.routeMap) {
    if (desktopState.routeLayer) desktopState.routeLayer.remove();
    const points = result.sequence.map((stop) => [stop.lat, stop.long]);
    const group = L.layerGroup();
    L.polyline(points, { color: '#4d8af0', weight: 4, opacity: 0.8 }).addTo(group);
    result.sequence.forEach((stop, index) => {
      L.marker([stop.lat, stop.long])
        .bindTooltip(`${index + 1}. ${stop.company_name || 'Stop'}`, { permanent: false })
        .addTo(group);
    });
    group.addTo(desktopState.routeMap);
    desktopState.routeLayer = group;
    desktopState.routeMap.invalidateSize();
    desktopState.routeMap.fitBounds(L.latLngBounds(points).pad(0.15));
  }

  // Hand the sequence to the phone's navigation app.
  const link = $('openInMapsLink');
  const stops = result.sequence;
  if (stops.length >= 2) {
    const origin = `${stops[0].lat},${stops[0].long}`;
    const destination = `${stops[stops.length - 1].lat},${stops[stops.length - 1].long}`;
    const waypoints = stops.slice(1, -1).map((s) => `${s.lat},${s.long}`).join('|');
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    url.searchParams.set('origin', origin);
    url.searchParams.set('destination', destination);
    if (waypoints) url.searchParams.set('waypoints', waypoints);
    url.searchParams.set('travelmode', 'driving');
    link.href = url.toString();
    link.hidden = false;
  } else {
    link.hidden = true;
  }

  // Background Intelligence Pre-Caching (Offline readiness for commercial parks)
  if (navigator.onLine && Array.isArray(stops)) {
    const stopsToCache = stops.filter((s) => s.company_name && s.company_name !== 'Current position');
    (async () => {
      for (const stop of stopsToCache) {
        try {
          const data = await apiPost('/api/enrich', {
            company_id: stop.company_id || undefined,
            company_name: stop.company_name,
            street_1: stop.street_1,
            city: stop.city,
            state: stop.state,
            zip_code: stop.zip_code
          });
          await cacheDossier(stop.company_id || stop.company_name, data);
          // Small pause between background fetches
          await new Promise((r) => setTimeout(r, 300));
        } catch {
          /* background pre-cache is non-blocking */
        }
      }
    })();
  }
}

async function clusterRoute() {
  if (desktopState.targets.length === 0) {
    showToast('No active targets to cluster.', 'error');
    return;
  }

  const start = (await currentPosition()) || { lat: 37.2089, long: -93.2923 };

  // Calculate straight-line distance to each target
  const scored = desktopState.targets.map((target) => ({
    target,
    dist: haversineMiles(start, target)
  }));

  scored.sort((a, b) => a.dist - b.dist);

  desktopState.selectedTargets.clear();
  const closest = scored.slice(0, 11);
  closest.forEach(({ target }) => desktopState.selectedTargets.add(target.company_id));

  renderTargets();
  showToast(`Queued ${closest.length} closest targets to your location.`, 'success');
}

function initRouteTab() {
  $('refreshTargetsBtn').addEventListener('click', loadTargets);

  const filterSelect = $('routeFilterSelect');
  if (filterSelect) {
    filterSelect.addEventListener('change', loadTargets);
  }

  const clusterBtn = $('clusterRouteBtn');
  if (clusterBtn) {
    clusterBtn.addEventListener('click', clusterRoute);
  }

  $('selectAllTargets').addEventListener('change', (event) => {
    desktopState.selectedTargets.clear();
    if (event.target.checked) {
      desktopState.targets.slice(0, MAX_ROUTE_STOPS).forEach((t) => desktopState.selectedTargets.add(t.company_id));
      if (desktopState.targets.length > MAX_ROUTE_STOPS) {
        showToast(`Selected the first ${MAX_ROUTE_STOPS} — that is the optimizer's ceiling.`, 'info');
      }
    }
    renderTargets();
  });

  $('optimizeRouteBtn').addEventListener('click', async () => {
    const ids = [...desktopState.selectedTargets];
    if (ids.length === 0) {
      showToast('Select at least one target.', 'error');
      return;
    }

    const button = $('optimizeRouteBtn');
    setButtonBusy(button, true, 'Optimizing…');
    try {
      const start = await currentPosition();
      const result = await apiPost('/api/route/optimize', { company_ids: ids, start });
      renderRoute(result);
      if (result.unroutable?.length) {
        showToast(`${result.unroutable.length} stop(s) skipped — no coordinates.`, 'info');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setButtonBusy(button, false);
    }
  });

  window.addEventListener('viewactivated', (event) => {
    if (event.detail.view === 'route') resizeRouteMap();
  });
}

/** Current position, or null. Never blocks the route on a denied prompt. */
function currentPosition() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, long: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 120000 }
    );
  });
}

// =====================================================================
// TAB 2 — TIER 1 CLIPBOARD HANDOFF
// =====================================================================

async function loadTier1() {
  const body = $('tier1Body');
  const date = $('tier1Date').value || businessDate();
  body.replaceChildren(el('tr', { children: [td('Loading activity…', 'empty-cell')] }));

  try {
    const data = await apiFetch(`/api/activity?date=${encodeURIComponent(date)}&limit=500`);
    desktopState.tier1Rows = data.activities || [];
    renderTier1();
  } catch (err) {
    body.replaceChildren(el('tr', { children: [td(`Could not load activity: ${err.message}`, 'empty-cell')] }));
  }
}

function renderTier1() {
  const body = $('tier1Body');
  const rows = desktopState.tier1Rows;

  if (rows.length === 0) {
    body.replaceChildren(el('tr', { children: [td('No activity logged for this day.', 'empty-cell')] }));
    $('copyAllBtn').disabled = true;
    return;
  }
  $('copyAllBtn').disabled = false;

  body.replaceChildren(...rows.map((row) => {
    const copyButton = el('button', {
      className: 'btn-tiny',
      text: 'Copy',
      attrs: { type: 'button', 'aria-label': `Copy ${row.company_name} row for Dynamics 365` }
    });
    copyButton.addEventListener('click', async () => {
      try {
        await copyToClipboard(toTabDelimitedRow(row));
        copyButton.textContent = 'Copied';
        setTimeout(() => { copyButton.textContent = 'Copy'; }, 1800);
        await markSynced([row.log_id], 'TIER1_COPIED');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    const contact = [row.first_name, row.last_name].filter(Boolean).join(' ')
      || row.job_title || '—';

    return el('tr', {
      children: [
        td(localTime(row.timestamp)),
        el('td', {
          children: [
            el('strong', { text: row.company_name }),
            el('span', { className: 'cell-sub', text: [row.street_1, row.city].filter(Boolean).join(', ') })
          ]
        }),
        td(contact),
        td(row.is_in_person ? 'In person' : 'Phone'),
        td(row.disposition),
        el('td', { children: [el('span', { className: `pill pill-${String(row.rating || 'cold').toLowerCase()}`, text: row.rating || 'Cold' })] }),
        td(row.projected_ap ? `$${Number(row.projected_ap).toLocaleString('en-US')}` : '—'),
        el('td', { children: [el('span', { className: 'pill pill-tier', text: row.sync_tier_status })] }),
        el('td', { children: [copyButton] })
      ]
    });
  }));
}

async function markSynced(logIds, status) {
  try {
    await apiPost('/api/activity/mark-synced', { log_ids: logIds, sync_tier_status: status });
    // Reflect the new tier locally rather than refetching the whole table.
    desktopState.tier1Rows.forEach((row) => {
      if (logIds.includes(row.log_id)) row.sync_tier_status = status;
    });
    renderTier1();
  } catch (err) {
    console.error('Could not update sync tier:', err);
    showToast(`Copied, but the tier status did not update: ${err.message}`, 'info');
  }
}

function initTier1Tab() {
  $('tier1Date').value = businessDate();
  $('tier1RefreshBtn').addEventListener('click', loadTier1);
  $('tier1Date').addEventListener('change', loadTier1);

  $('copyAllBtn').addEventListener('click', async () => {
    const rows = desktopState.tier1Rows;
    if (rows.length === 0) return;
    const button = $('copyAllBtn');
    try {
      await copyToClipboard(toTabDelimited(rows));
      showToast(`${rows.length} row(s) copied — paste into the D365 Open Leads grid.`, 'success');
      button.textContent = 'Copied!';
      setTimeout(() => { button.textContent = 'Copy All for D365'; }, 2000);
      await markSynced(rows.map((r) => r.log_id), 'TIER1_COPIED');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// =====================================================================
// TAB 3 — TIER 2/3 FILE SYNC
// =====================================================================

async function loadExports() {
  const scope = $('exportScope').value;
  const query = scope === 'all' ? 'all=1' : `date=${encodeURIComponent(businessDate())}`;

  try {
    const data = await apiFetch(`/api/export/d365?${query}`);
    desktopState.exportRows = { tier2: data.tier2 || [], tier3: data.tier3 || [] };
    renderExports();
  } catch (err) {
    showToast(`Could not load export data: ${err.message}`, 'error');
  }
}

function renderExports() {
  const { tier2, tier3 } = desktopState.exportRows;

  const describe = (rows) => rows.slice(0, 8).map((row) => el('li', {
    children: [
      el('strong', { text: row.company_name }),
      el('span', {
        className: 'cell-sub',
        text: `${row.disposition}${row.d365_lead_id ? ` · ${row.d365_lead_id}` : ''}`
      })
    ]
  }));

  $('tier2Count').textContent = `${tier2.length} ${tier2.length === 1 ? 'account' : 'accounts'}`;
  $('tier3Count').textContent = `${tier3.length} ${tier3.length === 1 ? 'account' : 'accounts'}`;
  $('tier2Preview').replaceChildren(...describe(tier2));
  $('tier3Preview').replaceChildren(...describe(tier3));
  $('exportXlsxBtn').disabled = tier2.length === 0;
  $('exportCsvBtn').disabled = tier3.length === 0;
}

function initTier23Tab() {
  $('exportRefreshBtn').addEventListener('click', loadExports);
  $('exportScope').addEventListener('change', loadExports);

  $('exportXlsxBtn').addEventListener('click', async () => {
    const rows = desktopState.exportRows.tier2;
    if (rows.length === 0) return;

    const button = $('exportXlsxBtn');
    setButtonBusy(button, true, 'Building…');
    try {
      const data = await buildTier2Workbook(rows);
      downloadFile(
        new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `d365-tier2-updates-${businessDate()}.xlsx`
      );
      showToast(`${rows.length} existing lead(s) exported with checksums intact.`, 'success');
      await markExported(rows, 'TIER2_EXPORTED');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setButtonBusy(button, false);
    }
  });

  $('exportCsvBtn').addEventListener('click', async () => {
    const rows = desktopState.exportRows.tier3;
    if (rows.length === 0) return;

    try {
      // A BOM makes Excel read the file as UTF-8 instead of the system
      // codepage, which is what mangles an accented company name.
      downloadFile(
        `﻿${toCsv(rows)}`,
        `d365-tier3-net-new-${businessDate()}.csv`,
        'text/csv;charset=utf-8'
      );
      showToast(`${rows.length} net-new lead(s) exported for the Import Data wizard.`, 'success');
      await markExported(rows, 'TIER3_EXPORTED');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function markExported(rows, status) {
  const logIds = rows.map((row) => row.log_id).filter(Boolean);
  if (logIds.length === 0) return;
  try {
    await apiPost('/api/activity/mark-synced', { log_ids: logIds, sync_tier_status: status });
    await loadExports();
  } catch (err) {
    console.error('Could not update sync tier:', err);
    showToast(`File downloaded, but tier status did not update: ${err.message}`, 'info');
  }
}

// =====================================================================
// TAB 4 — EOD AI DEBRIEF
// =====================================================================

const METRIC_TILES = [
  ['Total Doors', 'total_doors'],
  ['DMs Met', 'dms_met'],
  ['Appointments', 'appointments'],
  ['Accounts', 'accounts'],
  ['DM Rate', 'dm_contact_rate'],
  ['Projected AP', 'projected_ap']
];

function renderEodMetrics(metrics) {
  const panel = $('eodMetrics');
  if (!metrics) { panel.hidden = true; return; }
  panel.hidden = false;

  panel.replaceChildren(...METRIC_TILES.map(([label, key]) => {
    let value = metrics[key];
    if (key === 'projected_ap') value = `$${Number(value || 0).toLocaleString('en-US')}`;
    return el('div', {
      className: 'metric-tile',
      children: [
        el('span', { className: 'metric-value', text: value ?? '—' }),
        el('span', { className: 'metric-label', text: label })
      ]
    });
  }));
}

async function loadEodDebrief() {
  const button = $('eodRunBtn');
  const report = $('eodReport');
  const date = $('eodDate').value || businessDate();

  setButtonBusy(button, true, 'Thinking…');
  report.replaceChildren(el('p', { className: 'muted-note', text: 'Reading the day\'s voice notes…' }));

  try {
    const data = await apiFetch(`/api/eod-debrief?date=${encodeURIComponent(date)}`);
    desktopState.eodMarkdown = data.report || '';
    renderEodMetrics(data.metrics);

    // renderMarkdown builds DOM nodes only — this text is model output derived
    // from voice transcripts and never goes near innerHTML.
    report.replaceChildren(renderMarkdown(data.report));
    $('eodCopyBtn').disabled = !desktopState.eodMarkdown;

    if (data.degraded) {
      showToast('Metrics are exact; the AI narrative was unavailable.', 'info');
    } else if (data.activity_count === 0) {
      showToast('No activity logged for that day.', 'info');
    }
  } catch (err) {
    report.replaceChildren(el('p', { className: 'dossier-error', text: err.message }));
    $('eodCopyBtn').disabled = true;
  } finally {
    setButtonBusy(button, false);
  }
}

function initEodTab() {
  $('eodDate').value = businessDate();
  $('eodRunBtn').addEventListener('click', loadEodDebrief);
  $('eodDate').addEventListener('change', loadEodDebrief);

  $('eodCopyBtn').addEventListener('click', async () => {
    if (!desktopState.eodMarkdown) return;
    try {
      await copyToClipboard(desktopState.eodMarkdown);
      showToast('Debrief copied as Markdown.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// =====================================================================
// INIT
// =====================================================================

export function initDesktopViews() {
  initRouteTab();
  initTier1Tab();
  initTier23Tab();
  initEodTab();

  // Each tab fetches on first open, not on page load — the field log must be
  // interactive immediately, even on a slow tethered connection.
  onViewOpen('route', () => { initRouteMap(); loadTargets(); });
  onViewOpen('tier1', loadTier1);
  onViewOpen('tier23', loadExports);
  // The debrief is a paid model call, so it runs on request rather than on
  // first open like the others.
}

/** Re-fetch whatever the agent is currently looking at after a queue drain. */
export function refreshActiveDesktopView() {
  const active = document.querySelector('.view.active');
  if (!active) return;
  if (active.id === 'view-tier1') loadTier1();
  if (active.id === 'view-tier23') loadExports();
  if (active.id === 'view-route') loadTargets();
}

// Referenced by the Tier 2 column definition; re-exported so a future tab can
// render the same key columns without importing d365.js directly.
export { D365_OPEN_LEADS_COLUMNS, D365_TIER2_KEY_COLUMNS, parseNotes };
