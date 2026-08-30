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
import { cacheDossier, getCachedDossier, getQueueCount } from './store.js';

const MAX_ROUTE_STOPS = 24;
const MAX_LEG_STOPS = 12;

/**
 * Expected Premium Value (EPV) industry risk multipliers for B2B prospecting.
 * Higher multipliers (1.5x - 2.0x) weight blue-collar, high-injury and high-benefit-yield sectors.
 */
export const INDUSTRY_MULTIPLIERS = {
  'Construction & Trades': 2.0,
  'Manufacturing': 1.8,
  'Transportation & Logistics': 1.7,
  'Healthcare & Medical': 1.6,
  'Automotive & Dealerships': 1.5,
  'Agriculture & Forestry': 1.5,
  'Mining & Extraction': 1.5,
  'Hospitality & Food Service': 1.3,
  'Wholesale & Distribution': 1.3,
  'Utilities & Communications': 1.3,
  'Real Estate': 1.1,
  'Retail Trade': 1.1,
  'Personal & Consumer Services': 1.1,
  'Entertainment & Recreation': 1.1,
  'Education & Schools': 1.0,
  'Professional & Tech Services': 1.0,
  'Finance & Insurance': 1.0,
  'Civic & Public Admin': 1.0,
  'Other Commercial': 1.0
};

export function getIndustryMultiplier(industry) {
  if (!industry || typeof industry !== 'string') return 1.0;
  return INDUSTRY_MULTIPLIERS[industry.trim()] || 1.0;
}

export function calculateEpv(target, distanceMiles) {
  const employees = (target?.employees !== null && target?.employees !== undefined && Number(target.employees) > 0)
    ? Number(target.employees)
    : 5;
  const mult = getIndustryMultiplier(target?.industry);
  const dist = (distanceMiles !== null && distanceMiles !== undefined && Number.isFinite(distanceMiles))
    ? distanceMiles
    : 1.0;
  const score = (employees * mult) / (dist + 0.5);
  return Math.round(score * 10) / 10;
}

let masterRouteTargets = [];
let userCoords = null;
let currentlyRenderedTargets = [];
let skippedTargets = new Set();
let sortColumn = 'distance'; // 'distance' | 'epv' | 'employees'
let sortOrder = 'asc';       // 'asc' | 'desc'

const desktopState = {
  targets: [],
  selectedTargets: new Set(),
  tier1Rows: [],
  exportRows: { tier2: [], tier3: [] },
  telemetry: null,
  eodMarkdown: '',
  routeMap: null,
  routeLayer: null,
  routeStart: null,
  routeLegs: null,
  activeLeg: 1
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

/** Calculate compass quadrant ('NW', 'NE', 'SW', 'SE') relative to user location. */
function getQuadrant(userLat, userLon, targetLat, targetLon) {
  if (userLat === null || userLat === undefined || userLon === null || userLon === undefined ||
      targetLat === null || targetLat === undefined || targetLon === null || targetLon === undefined) {
    return null;
  }
  const dLat = Number(targetLat) - Number(userLat);
  const dLon = Number(targetLon) - Number(userLon);
  if (dLat === 0 && dLon === 0) return null;
  const isNorth = dLat >= 0;
  const isEast = dLon >= 0;
  if (isNorth && isEast) return 'NE';
  if (isNorth && !isEast) return 'NW';
  if (!isNorth && isEast) return 'SE';
  return 'SW';
}

// =====================================================================
// TAB 1 — ROUTE PLANNER
// =====================================================================

async function loadTargets() {
  const body = $('targetsBody');
  body.replaceChildren(el('tr', {
    children: [el('td', { className: 'empty-cell', text: 'Loading targets…', attrs: { colspan: '7' } })]
  }));

  try {
    // Acquire user GPS position if available
    userCoords = await currentPosition();

    // Load active companies
    const data = await apiFetch('/api/companies?filter=all_active&limit=1000');
    const valid = (data.companies || []).filter((t) => t.lat !== null && t.long !== null);
    const missingCoords = (data.companies || []).length - valid.length;

    // Calculate distance, EPV score, and compass quadrant for each target
    masterRouteTargets = valid.map((target) => {
      const distance = (userCoords && target.lat !== null && target.long !== null)
        ? haversineMiles(userCoords, target)
        : null;
      return {
        ...target,
        distance,
        epv: calculateEpv(target, distance),
        quadrant: (userCoords && target.lat !== null && target.long !== null)
          ? getQuadrant(userCoords.lat, userCoords.long, target.lat, target.long)
          : null
      };
    });

    desktopState.targets = masterRouteTargets;

    // Render table with filtering, quadrant matching, and sorting
    renderRouteTable();

    if (missingCoords > 0) {
      showToast(`${missingCoords} account(s) have no coordinates and cannot be routed.`, 'info');
    }
  } catch (err) {
    body.replaceChildren(el('tr', {
      children: [el('td', { className: 'empty-cell', text: `Could not load targets: ${err.message}`, attrs: { colspan: '7' } })]
    }));
  }
}

async function refreshGpsLocation() {
  const btn = $('refreshLocationBtn');
  setButtonBusy(btn, true, 'Updating…');
  try {
    userCoords = await currentPosition();
    if (!userCoords) {
      showToast('Could not acquire current GPS location.', 'error');
      return;
    }

    masterRouteTargets.forEach((target) => {
      if (target.lat !== null && target.long !== null) {
        target.distance = haversineMiles(userCoords, target);
        target.epv = calculateEpv(target, target.distance);
        target.quadrant = getQuadrant(userCoords.lat, userCoords.long, target.lat, target.long);
      }
    });

    renderRouteTable();
    showToast('GPS location & EPV scores updated.', 'success');
  } catch (err) {
    showToast(`Location error: ${err.message}`, 'error');
  } finally {
    setButtonBusy(btn, false);
  }
}

function renderRouteTable() {
  const body = $('targetsBody');
  if (!body) return;

  const filterSelect = $('routeFilterSelect');
  const industrySelect = $('routeIndustrySelect');
  const directionSelect = $('routeDirectionSelect');
  const searchInput = $('routeSearchInput');

  const filter = filterSelect?.value || 'all_active';
  const selectedIndustry = industrySelect?.value || 'all';
  const selectedDirection = directionSelect?.value || 'all';
  const searchQuery = (searchInput?.value || '').trim().toLowerCase();

  // Update header indicators
  const distTh = $('sortDistance');
  const epvTh = $('sortEpv');
  const empTh = $('sortEmployees');
  if (distTh) {
    distTh.textContent = sortColumn === 'distance'
      ? `Dist. 📍 ${sortOrder === 'asc' ? '▲' : '▼'}`
      : 'Dist. 📍';
  }
  if (epvTh) {
    epvTh.textContent = sortColumn === 'epv'
      ? `EPV 💎 ${sortOrder === 'desc' ? '▼' : '▲'}`
      : 'EPV 💎';
  }
  if (empTh) {
    empTh.textContent = sortColumn === 'employees'
      ? `Emp. 👥 ${sortOrder === 'asc' ? '▲' : '▼'}`
      : 'Emp. 👥';
  }

  // 1. Filter
  let filtered = masterRouteTargets.filter((t) => {
    // Exclude skipped accounts
    if (skippedTargets.has(t.company_id)) return false;

    // Untouched vs Follow-ups
    if (filter === 'untouched' && Number(t.touch_count || 0) > 0) return false;
    if (filter === 'follow_ups' && Number(t.touch_count || 0) === 0) return false;

    // Industry filter
    if (selectedIndustry !== 'all' && (t.industry || '').trim() !== selectedIndustry) return false;

    // Direction / Quadrant filter
    if (selectedDirection !== 'all' && t.quadrant !== selectedDirection) return false;

    // Fuzzy search (name, street, city, ZIP, industry)
    if (searchQuery.length > 0) {
      const matchName = t.company_name && t.company_name.toLowerCase().includes(searchQuery);
      const matchStreet1 = t.street_1 && t.street_1.toLowerCase().includes(searchQuery);
      const matchStreet2 = t.street_2 && t.street_2.toLowerCase().includes(searchQuery);
      const matchCity = t.city && t.city.toLowerCase().includes(searchQuery);
      const matchZip = t.zip_code && t.zip_code.toLowerCase().includes(searchQuery);
      const matchInd = t.industry && t.industry.toLowerCase().includes(searchQuery);
      if (!matchName && !matchStreet1 && !matchStreet2 && !matchCity && !matchZip && !matchInd) {
        return false;
      }
    }

    return true;
  });

  // 2. Sort
  filtered.sort((a, b) => {
    if (sortColumn === 'epv') {
      const epvA = a.epv !== null && a.epv !== undefined ? a.epv : (sortOrder === 'desc' ? -Infinity : Infinity);
      const epvB = b.epv !== null && b.epv !== undefined ? b.epv : (sortOrder === 'desc' ? -Infinity : Infinity);
      if (epvA !== epvB) {
        return sortOrder === 'desc' ? (epvB - epvA) : (epvA - epvB);
      }
      return a.company_name.localeCompare(b.company_name);
    }

    if (sortColumn === 'employees') {
      const rawA = a.employees !== null && a.employees !== undefined ? parseInt(a.employees, 10) : NaN;
      const rawB = b.employees !== null && b.employees !== undefined ? parseInt(b.employees, 10) : NaN;
      const empA = !Number.isNaN(rawA) ? rawA : (sortOrder === 'asc' ? Infinity : -Infinity);
      const empB = !Number.isNaN(rawB) ? rawB : (sortOrder === 'asc' ? Infinity : -Infinity);
      if (empA !== empB) {
        return sortOrder === 'asc' ? empA - empB : empB - empA;
      }
      return a.company_name.localeCompare(b.company_name);
    }

    // Default: distance
    if (a.distance === null && b.distance === null) {
      return a.company_name.localeCompare(b.company_name);
    }
    if (a.distance === null) return 1;
    if (b.distance === null) return -1;
    return sortOrder === 'asc' ? (a.distance - b.distance) : (b.distance - a.distance);
  });

  currentlyRenderedTargets = filtered;
  desktopState.targets = filtered;

  // Update Reset Skips button visibility
  const resetSkipsBtn = $('resetSkipsBtn');
  if (resetSkipsBtn) {
    resetSkipsBtn.style.display = skippedTargets.size > 0 ? 'inline-block' : 'none';
  }

  if (filtered.length === 0) {
    body.replaceChildren(el('tr', {
      children: [el('td', {
        className: 'empty-cell',
        text: 'No targets match your current filters.',
        attrs: { colspan: '7', style: 'text-align:center; padding: 2rem; color: #6b7280;' }
      })]
    }));
    updateSelectAllCheckboxState();
    return;
  }

  body.replaceChildren(...filtered.map((target) => {
    const isSelected = desktopState.selectedTargets.has(target.company_id);
    const checkbox = el('input', {
      attrs: {
        type: 'checkbox',
        'aria-label': `Include ${target.company_name} in the route`,
        ...(isSelected ? { checked: 'checked' } : {})
      }
    });
    checkbox.checked = isSelected;

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (desktopState.selectedTargets.size >= MAX_ROUTE_STOPS) {
          checkbox.checked = false;
          showToast(`Staging accepts at most ${MAX_ROUTE_STOPS} stops across 2 legs.`, 'error');
          return;
        }
        desktopState.selectedTargets.add(target.company_id);
        if (desktopState.selectedTargets.size > MAX_LEG_STOPS) {
          showToast(`Selected ${desktopState.selectedTargets.size} targets (will stage into Morning & Afternoon 12-stop legs).`, 'info');
        }
      } else {
        desktopState.selectedTargets.delete(target.company_id);
      }
      updateSelectAllCheckboxState();
    });

    const distText = target.distance !== null
      ? `${target.distance.toFixed(1)} mi${target.quadrant ? ` (${target.quadrant})` : ''}`
      : '—';

    const epvText = target.epv !== null && target.epv !== undefined
      ? `${target.epv.toFixed(1)}`
      : '—';

    const skipBtn = el('button', {
      className: 'btn-skip',
      text: '✕',
      attrs: {
        type: 'button',
        'data-id': target.company_id,
        title: `Skip ${target.company_name} for this session`,
        'aria-label': `Skip ${target.company_name}`
      }
    });
    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      skippedTargets.add(target.company_id);
      desktopState.selectedTargets.delete(target.company_id);
      const resetBtn = $('resetSkipsBtn');
      if (resetBtn) resetBtn.style.display = 'inline-block';
      renderRouteTable();
      showToast(`Skipped ${target.company_name} for this session.`, 'info');
    });

    return el('tr', {
      children: [
        el('td', { className: 'col-check', children: [checkbox] }),
        td(target.company_name),
        td([target.street_1, target.city].filter(Boolean).join(', ')),
        td(distText),
        el('td', { children: [el('span', { className: 'pill pill-epv', text: epvText, attrs: { title: `EPV Score: ${epvText} (Industry risk multiplier: ${getIndustryMultiplier(target.industry)}x)` } })] }),
        td(target.employees ?? '—'),
        el('td', { className: 'col-skip', children: [skipBtn] })
      ]
    });
  }));

  updateSelectAllCheckboxState();
}

function updateSelectAllCheckboxState() {
  const selectAll = $('selectAllTargets');
  if (!selectAll) return;
  if (currentlyRenderedTargets.length === 0) {
    selectAll.checked = false;
    return;
  }
  selectAll.checked = currentlyRenderedTargets.every((t) => desktopState.selectedTargets.has(t.company_id));
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

function renderRoute(result, legTitle = null) {
  const summary = $('routeSummary');
  const steps = $('routeSteps');

  const providerLabel = {
    mapbox: 'Mapbox road network',
    heuristic: 'local estimate (no Mapbox token)',
    'heuristic-fallback': 'local estimate (Mapbox unavailable)',
    'single-stop': 'single stop'
  }[result.provider] || result.provider;

  const titlePrefix = legTitle ? `[${legTitle}] ` : '';

  summary.replaceChildren(
    el('p', {
      className: 'route-headline',
      text: `${titlePrefix}${result.sequence.length} stops · ${result.distance_miles} mi · ~${result.duration_minutes} min`
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
      const tooltip = document.createElement('span');
      tooltip.textContent = `${index + 1}. ${stop.company_name || 'Stop'}`;
      L.marker([stop.lat, stop.long])
        .bindTooltip(tooltip, { permanent: false })
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
    link.textContent = legTitle ? `Open ${legTitle} in Google Maps` : 'Open in Google Maps';
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
          const cached = await getCachedDossier(stop.company_id || stop.company_name);
          if (!cached) {
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
          }
        } catch {
          /* background pre-cache is non-blocking */
        }
      }
    })();
  }
}

function updateLegButtonsUi() {
  const morningBtn = $('legMorningBtn');
  const afternoonBtn = $('legAfternoonBtn');
  if (!morningBtn || !afternoonBtn) return;

  morningBtn.classList.toggle('active', desktopState.activeLeg === 1);
  afternoonBtn.classList.toggle('active', desktopState.activeLeg === 2);
}

function initLegSwitcher() {
  const morningBtn = $('legMorningBtn');
  const afternoonBtn = $('legAfternoonBtn');

  if (morningBtn) {
    morningBtn.addEventListener('click', () => {
      if (!desktopState.routeLegs?.leg1) return;
      desktopState.activeLeg = 1;
      updateLegButtonsUi();
      renderRoute(desktopState.routeLegs.leg1, 'Morning Leg (1–12)');
    });
  }

  if (afternoonBtn) {
    afternoonBtn.addEventListener('click', () => {
      if (!desktopState.routeLegs?.leg2) return;
      desktopState.activeLeg = 2;
      updateLegButtonsUi();
      renderRoute(desktopState.routeLegs.leg2, 'Afternoon Leg (13–24)');
    });
  }
}

async function clusterRoute() {
  if (currentlyRenderedTargets.length === 0) {
    showToast('No active targets in current filter to cluster.', 'error');
    return;
  }

  desktopState.selectedTargets.clear();
  const sorted = [...currentlyRenderedTargets].sort((a, b) => parseFloat(a.distance) - parseFloat(b.distance));
  const closest = sorted.slice(0, 12);
  closest.forEach((target) => desktopState.selectedTargets.add(target.company_id));

  renderRouteTable();
  showToast(`Queued ${closest.length} closest targets from current view.`, 'success');
}

async function clusterEpv() {
  if (currentlyRenderedTargets.length === 0) {
    showToast('No active targets in current filter to cluster.', 'error');
    return;
  }

  desktopState.selectedTargets.clear();
  const sortedByEpv = [...currentlyRenderedTargets].sort((a, b) => (b.epv || 0) - (a.epv || 0));
  const topEpv = sortedByEpv.slice(0, 12);
  topEpv.forEach((target) => desktopState.selectedTargets.add(target.company_id));

  renderRouteTable();
  showToast(`Queued ${topEpv.length} top-EPV targets from current view.`, 'success');
}

function initRouteTab() {
  $('refreshTargetsBtn').addEventListener('click', loadTargets);

  const searchInput = $('routeSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', renderRouteTable);
  }

  const filterSelect = $('routeFilterSelect');
  if (filterSelect) {
    filterSelect.addEventListener('change', renderRouteTable);
  }

  const industrySelect = $('routeIndustrySelect');
  if (industrySelect) {
    industrySelect.addEventListener('change', renderRouteTable);
  }

  const directionSelect = $('routeDirectionSelect');
  if (directionSelect) {
    directionSelect.addEventListener('change', renderRouteTable);
  }

  const refreshLocationBtn = $('refreshLocationBtn');
  if (refreshLocationBtn) {
    refreshLocationBtn.addEventListener('click', refreshGpsLocation);
  }

  const resetSkipsBtn = $('resetSkipsBtn');
  if (resetSkipsBtn) {
    resetSkipsBtn.addEventListener('click', () => {
      skippedTargets.clear();
      resetSkipsBtn.style.display = 'none';
      renderRouteTable();
      showToast('All skipped accounts restored.', 'success');
    });
  }

  const sortDistTh = $('sortDistance');
  if (sortDistTh) {
    sortDistTh.addEventListener('click', () => {
      if (sortColumn === 'distance') {
        sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = 'distance';
        sortOrder = 'asc';
      }
      renderRouteTable();
    });
  }

  const sortEpvTh = $('sortEpv');
  if (sortEpvTh) {
    sortEpvTh.addEventListener('click', () => {
      if (sortColumn === 'epv') {
        sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
      } else {
        sortColumn = 'epv';
        sortOrder = 'desc';
      }
      renderRouteTable();
    });
  }

  const sortEmpTh = $('sortEmployees');
  if (sortEmpTh) {
    sortEmpTh.addEventListener('click', () => {
      if (sortColumn === 'employees') {
        sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = 'employees';
        sortOrder = 'desc';
      }
      renderRouteTable();
    });
  }

  const clusterBtn = $('clusterRouteBtn');
  if (clusterBtn) {
    clusterBtn.addEventListener('click', clusterRoute);
  }

  const clusterEpvBtn = $('clusterEpvBtn');
  if (clusterEpvBtn) {
    clusterEpvBtn.addEventListener('click', clusterEpv);
  }

  initLegSwitcher();

  $('selectAllTargets').addEventListener('change', (event) => {
    if (event.target.checked) {
      currentlyRenderedTargets.slice(0, MAX_ROUTE_STOPS).forEach((t) => desktopState.selectedTargets.add(t.company_id));
      if (currentlyRenderedTargets.length > MAX_ROUTE_STOPS) {
        showToast(`Selected the first ${MAX_ROUTE_STOPS} stops across 2 legs.`, 'info');
      }
    } else {
      currentlyRenderedTargets.forEach((t) => desktopState.selectedTargets.delete(t.company_id));
    }
    renderRouteTable();
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

      if (ids.length <= MAX_LEG_STOPS) {
        // Single leg route (1-12 stops)
        const result = await apiPost('/api/route/optimize', { company_ids: ids, start });
        desktopState.routeLegs = { leg1: result, leg2: null };
        desktopState.activeLeg = 1;
        const legBar = $('routeLegBar');
        if (legBar) legBar.style.display = 'none';
        renderRoute(result);
        if (result.unroutable?.length) {
          showToast(`${result.unroutable.length} stop(s) skipped — no coordinates.`, 'info');
        }
      } else {
        // Multi-leg route (13-24 stops split into Morning & Afternoon legs)
        const leg1Ids = ids.slice(0, MAX_LEG_STOPS);
        const leg2Ids = ids.slice(MAX_LEG_STOPS, MAX_ROUTE_STOPS);

        const result1 = await apiPost('/api/route/optimize', { company_ids: leg1Ids, start });
        const lastStop1 = result1.sequence?.[result1.sequence.length - 1];
        const leg2Start = lastStop1 && lastStop1.lat !== undefined && lastStop1.long !== undefined
          ? { lat: lastStop1.lat, long: lastStop1.long }
          : start;

        const result2 = await apiPost('/api/route/optimize', { company_ids: leg2Ids, start: leg2Start });

        desktopState.routeLegs = { leg1: result1, leg2: result2 };
        desktopState.activeLeg = 1;

        const legBar = $('routeLegBar');
        if (legBar) legBar.style.display = 'flex';
        updateLegButtonsUi();

        renderRoute(result1, 'Morning Leg (1–12)');
        showToast(`Staged 2-leg route: ${result1.sequence.length + result2.sequence.length} stops total.`, 'success');
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
    loadTelemetry().catch(() => {});
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

  // ----- D365 Lead Importer -----
  const fileInput = $('importFileInput');
  const uploadBtn = $('uploadLeadsBtn');

  if (fileInput && uploadBtn) {
    fileInput.addEventListener('change', () => {
      uploadBtn.disabled = !fileInput.files?.length;
    });

    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      setButtonBusy(uploadBtn, true, 'Reading…');
      try {
        const deduplicated = await parseAndDeduplicate(file);
        if (deduplicated.length === 0) {
          showToast('No valid companies found in the file.', 'error');
          return;
        }
        showToast(`Parsed ${deduplicated.length} unique companies. Uploading…`, 'info');
        await uploadInChunks(deduplicated, 25);
        // Refresh the route planner and export views with the new data
        await loadTargets();
        await loadExports();
      } catch (err) {
        showToast(`Import failed: ${err.message}`, 'error');
      } finally {
        setButtonBusy(uploadBtn, false);
        fileInput.value = '';
        uploadBtn.disabled = true;
      }
    });
  }
}

async function markExported(rows, status) {
  const logIds = rows.map((row) => row.log_id).filter(Boolean);
  if (logIds.length === 0) return;
  try {
    await apiPost('/api/activity/mark-synced', { log_ids: logIds, sync_tier_status: status });
    await loadExports();
    loadTelemetry().catch(() => {});
  } catch (err) {
    console.error('Could not update sync tier:', err);
    showToast(`File downloaded, but tier status did not update: ${err.message}`, 'info');
  }
}

// =====================================================================
// UNIFIED DATA MANAGEMENT & TELEMETRY
// =====================================================================

export async function loadTelemetry() {
  try {
    const queueCount = await getQueueCount();
    const queueEl = $('telemetryQueue');
    if (queueEl) queueEl.textContent = String(queueCount);

    const data = await apiFetch('/api/telemetry');
    desktopState.telemetry = data;
    renderTelemetry(data, queueCount);
  } catch (err) {
    console.warn('Could not load telemetry:', err.message);
    const badge = $('telemetryHealthBadge');
    const badgeText = $('telemetryHealthText');
    if (badge && badgeText) {
      badge.className = 'sync-health-badge badge-error';
      badgeText.textContent = '🔴 Telemetry Degraded';
    }
  }
}

export function renderTelemetry(data, queueCount = 0) {
  if (!data) return;
  const metrics = data.metrics || {};

  const companiesEl = $('telemetryCompanies');
  if (companiesEl) companiesEl.textContent = Number(metrics.total_companies || 0).toLocaleString();

  const todayTouchesEl = $('telemetryTodayTouches');
  if (todayTouchesEl) todayTouchesEl.textContent = Number(metrics.today_activities || 0).toLocaleString();

  const pendingSyncEl = $('telemetryPendingSync');
  if (pendingSyncEl) pendingSyncEl.textContent = Number(metrics.pending_d365_sync || 0).toLocaleString();

  const queueEl = $('telemetryQueue');
  if (queueEl) queueEl.textContent = String(queueCount);

  const badge = $('telemetryHealthBadge');
  const badgeText = $('telemetryHealthText');
  if (badge && badgeText) {
    const pending = Number(metrics.pending_d365_sync || 0) + Number(queueCount);
    if (!navigator.onLine) {
      badge.className = 'sync-health-badge badge-pending';
      badgeText.textContent = '🟡 Offline Queue Active';
    } else if (pending > 20) {
      badge.className = 'sync-health-badge badge-pending';
      badgeText.textContent = `🟡 ${pending} Pending`;
    } else {
      badge.className = 'sync-health-badge badge-live';
      badgeText.textContent = '🟢 Live';
    }
  }
}

export async function loadDataManagement() {
  await Promise.allSettled([
    loadTier1(),
    loadExports(),
    loadTelemetry()
  ]);
}

export function initDataManagementView() {
  initTier1Tab();
  initTier23Tab();
}

// =====================================================================
// D365 IMPORT — PARSE, DEDUPLICATE, UPLOAD
// =====================================================================

/**
 * D365 column header → internal field mapping.
 * Only the columns we actually use for company + contact ingestion.
 */
const D365_IMPORT_MAP = {
  '(Do Not Modify) Lead':   'd365_lead_id',
  '(Do Not Modify) Row Checksum': 'd365_checksum',
  '(Do Not Modify) Modified On':  'd365_modified_on',
  'Business Name':          'company_name',
  'Street 1':               'street_1',
  'Street 2':               'street_2',
  'City':                   'city',
  'State':                  'state',
  'Zip Code':               'zip_code',
  'Lead Source':             'lead_source',
  'Rating':                 'rating',
  'Employees':              'employees',
  'Industry':               'industry',
  'First Name':             'first_name',
  'Last Name':              'last_name',
  'Phone Number':           'phone_number',
  'Email Address':          'email_address',
  'Job Title':              'job_title',
  'SIC Code':               'sic_code'
};

/** Contact-level fields — extracted from each row and nested under the company. */
const CONTACT_FIELDS = new Set(['first_name', 'last_name', 'phone_number', 'email_address', 'job_title']);

/**
 * Map raw D365 industry string into one of the 18 consolidated industry buckets.
 */
export function mapIndustryCategory(rawIndustry) {
  if (!rawIndustry || typeof rawIndustry !== 'string') return 'Other Commercial';
  const str = rawIndustry.toLowerCase().trim();
  if (!str) return 'Other Commercial';

  // 1. Agriculture & Forestry (agri, crop, farm, forest, fish, hunt, trap)
  if (/agri|crop|farm|forest|fish|hunt|trap/.test(str)) {
    return 'Agriculture & Forestry';
  }

  // 2. Mining & Extraction (mine, mining, coal, oil, gas, mineral)
  if (/mine|mining|coal|\boil\b|gas|mineral/.test(str)) {
    return 'Mining & Extraction';
  }

  // 3. Construction & Trades (contractor, construct, build, plumb, hvac, electric, roof)
  if (/contractor|construct|build|plumb|hvac|electric|roof/.test(str)) {
    return 'Construction & Trades';
  }

  // 4. Manufacturing (manufactur, lumber, wood, furnitur, paper, chemical, plastic, metal, machin)
  if (/manufactur|lumber|wood|furnitur|paper|chemical|plastic|metal|machin/.test(str)) {
    return 'Manufacturing';
  }

  // 5. Transportation & Logistics (transit, railroad, freight, truck, transport, warehous, logistic)
  if (/transit|railroad|freight|truck|transport|warehous|logistic/.test(str)) {
    return 'Transportation & Logistics';
  }

  // 6. Utilities & Communications (utilit, telephon, telegraph, radio, broadcast, communicat)
  if (/utilit|telephon|telegraph|radio|broadcast|communicat/.test(str)) {
    return 'Utilities & Communications';
  }

  // 7. Wholesale & Distribution (wholesale, distribut)
  if (/wholesale|distribut/.test(str)) {
    return 'Wholesale & Distribution';
  }

  // 8. Automotive & Dealerships (auto, motor, gas station, car, vehicle, tire)
  if (/auto|motor|gas station|\bcar\b|vehicle|tire/.test(str)) {
    return 'Automotive & Dealerships';
  }

  // 9. Hospitality & Food Service (eat, drink, restaurant, hotel, motel, camp, lodg)
  if (/\beat|eating|eatery|drink|restaurant|hotel|motel|camp|lodg/.test(str)) {
    return 'Hospitality & Food Service';
  }

  // 10. Finance & Insurance (financ, bank, credit, securit, broker, insur)
  if (/financ|bank|credit|securit|broker|insur/.test(str)) {
    return 'Finance & Insurance';
  }

  // 11. Real Estate (real estate, lessor, propert, title)
  if (/real estate|lessor|propert|title/.test(str)) {
    return 'Real Estate';
  }

  // 12. Healthcare & Medical (health, medic, physician, dentist, hospit, nurs, clinic, lab)
  if (/health|medic|physician|dentist|hospit|nurs|clinic|\blab\b/.test(str)) {
    return 'Healthcare & Medical';
  }

  // 13. Professional & Tech Services (legal, attorney, law, engin, account, cpa, research, manag, comput, tech, data, consult)
  if (/legal|attorney|\blaw\b|engin|account|\bcpa\b|research|manag|comput|tech|data|consult/.test(str)) {
    return 'Professional & Tech Services';
  }

  // 14. Personal & Consumer Services (laundry, clean, beauty, salon, barber, photo, repair)
  if (/laundry|clean|beauty|salon|barber|photo|repair/.test(str)) {
    return 'Personal & Consumer Services';
  }

  // 15. Education & Schools (educat, school, colleg, univers, librar, academ, teach)
  if (/educat|school|colleg|univers|librar|academ|teach/.test(str)) {
    return 'Education & Schools';
  }

  // 16. Entertainment & Recreation (entertain, recreat, amus, museum, sport, gym, theater, golf)
  if (/entertain|recreat|amus|museum|sport|gym|theater|theatre|golf/.test(str)) {
    return 'Entertainment & Recreation';
  }

  // 17. Civic & Public Admin (civic, public, admin, execut, legislat, polic, fire, social, church, relig, non-profit)
  if (/civic|public|admin|execut|legislat|polic|\bfire\b|social|church|relig|non-profit|nonprofit/.test(str)) {
    return 'Civic & Public Admin';
  }

  // 18. Retail Trade (retail, store, merchandis, shop, grocer)
  if (/retail|store|merchandis|shop|grocer/.test(str)) {
    return 'Retail Trade';
  }

  return 'Other Commercial';
}

/**
 * Read a .xlsx or .csv file with SheetJS, map D365 column headers to internal
 * field names, then deduplicate rows by Business Name (uppercased/trimmed).
 * Returns an array of { company fields, contacts: [{ contact fields }] }.
 */
async function parseAndDeduplicate(file) {
  const { loadSheetJs } = await import('./d365.js');
  const XLSX = await loadSheetJs();

  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rows.length === 0) return [];

  // Build a header map from the actual file headers to our internal fields.
  // This handles the case where a D365 export might have slightly different
  // header casing or extra whitespace.
  const sampleHeaders = Object.keys(rows[0]);
  const headerMap = {};
  for (const header of sampleHeaders) {
    const trimmed = header.trim();
    if (D365_IMPORT_MAP[trimmed]) {
      headerMap[header] = D365_IMPORT_MAP[trimmed];
    }
  }

  // Deduplicate by Business Name — multiple D365 rows for the same company
  // (different contacts) are merged into one company with nested contacts.
  const companyMap = new Map();

  for (const row of rows) {
    const mapped = {};
    for (const [originalHeader, internalField] of Object.entries(headerMap)) {
      const val = row[originalHeader];
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        mapped[internalField] = String(val).trim();
      }
    }

    const companyName = mapped.company_name;
    if (!companyName) continue;

    const key = companyName.toUpperCase().trim();

    if (!companyMap.has(key)) {
      // First occurrence — extract company-level fields
      const company = {};
      for (const [field, value] of Object.entries(mapped)) {
        if (!CONTACT_FIELDS.has(field)) {
          company[field] = value;
        }
      }
      if (company.industry) {
        company.industry = mapIndustryCategory(company.industry);
      }
      company.contacts = [];
      companyMap.set(key, company);
    }

    // Extract contact-level fields from every row (even duplicates)
    const contact = {};
    let hasContactInfo = false;
    for (const field of CONTACT_FIELDS) {
      if (mapped[field]) {
        contact[field] = mapped[field];
        hasContactInfo = true;
      }
    }
    if (hasContactInfo) {
      companyMap.get(key).contacts.push(contact);
    }
  }

  return [...companyMap.values()];
}

/**
 * Upload deduplicated companies in batches of `chunkSize` to POST /api/import.
 * Updates the progress bar and status text after each chunk.
 */
async function uploadInChunks(companies, chunkSize) {
  const progress = $('importProgress');
  const fill = $('importProgressFill');
  const status = $('importStatus');
  const stats = $('importStats');

  progress.hidden = false;
  stats.hidden = true;
  fill.style.width = '0%';

  let totalImported = 0;
  let totalContacts = 0;
  let totalGeocoded = 0;
  const allSkipped = [];
  const totalChunks = Math.ceil(companies.length / chunkSize);

  for (let i = 0; i < companies.length; i += chunkSize) {
    const chunk = companies.slice(i, i + chunkSize);
    const chunkIndex = Math.floor(i / chunkSize) + 1;

    status.textContent = `Uploading batch ${chunkIndex} of ${totalChunks}…`;
    fill.style.width = `${Math.round((chunkIndex / totalChunks) * 100)}%`;

    try {
      const result = await apiPost('/api/companies/import', { companies: chunk });
      totalImported += result.imported || 0;
      totalContacts += result.contacts || 0;
      totalGeocoded += result.geocoded || 0;
      if (result.skipped?.length) allSkipped.push(...result.skipped);
    } catch (err) {
      showToast(`Batch ${chunkIndex} failed: ${err.message}`, 'error');
    }
  }

  fill.style.width = '100%';
  status.textContent = 'Import complete.';

  // Show summary stats
  const lines = [
    `✅ <strong>${totalImported}</strong> companies imported`,
    `👤 <strong>${totalContacts}</strong> contacts attached`,
    `📍 <strong>${totalGeocoded}</strong> addresses geocoded`
  ];
  if (allSkipped.length > 0) {
    lines.push(`⚠️ <strong>${allSkipped.length}</strong> skipped: ${allSkipped.map((s) => s.company_name).join(', ')}`);
  }

  // Build DOM safely — no innerHTML
  stats.replaceChildren();
  for (const line of lines) {
    const p = document.createElement('p');
    // Parse the simple <strong> tags safely
    const parts = line.split(/<\/?strong>/);
    for (let j = 0; j < parts.length; j++) {
      if (j % 2 === 1) {
        const strong = document.createElement('strong');
        strong.textContent = parts[j];
        p.appendChild(strong);
      } else {
        p.appendChild(document.createTextNode(parts[j]));
      }
    }
    stats.appendChild(p);
  }
  stats.hidden = false;

  showToast(
    `Import complete: ${totalImported} companies, ${totalContacts} contacts, ${totalGeocoded} geocoded.`,
    'success'
  );
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
  initDataManagementView();
  initEodTab();

  // Each tab fetches on first open, not on page load — the field log must be
  // interactive immediately, even on a slow tethered connection.
  onViewOpen('route', () => { initRouteMap(); loadTargets(); });
  onViewOpen('data-management', loadDataManagement);
  onViewOpen('tier1', loadTier1);
  onViewOpen('tier23', loadExports);
  // The debrief is a paid model call, so it runs on request rather than on
  // first open like the others.
}

/** Re-fetch whatever the agent is currently looking at after a queue drain. */
export function refreshActiveDesktopView() {
  const active = document.querySelector('.view.active');
  if (!active) return;
  if (active.id === 'view-data-management') loadDataManagement();
  if (active.id === 'view-tier1') loadTier1();
  if (active.id === 'view-tier23') loadExports();
  if (active.id === 'view-route') loadTargets();
}

// Referenced by the Tier 2 column definition; re-exported so a future tab can
// render the same key columns without importing d365.js directly.
export {
  D365_OPEN_LEADS_COLUMNS,
  D365_TIER2_KEY_COLUMNS,
  parseNotes,
  loadTier1,
  loadExports
};
