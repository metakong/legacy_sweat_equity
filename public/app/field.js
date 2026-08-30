/**
 * The field log view — the entire app on the S21+, the first tab on desktop.
 *
 * Flow the UI is built around: pick the target, optionally ⚡ inspect it,
 * three taps, talk, log. Everything after "log" is asynchronous and offline
 * tolerant.
 */

import { $, el, showToast, setButtonBusy, apiFetch, apiPost } from './ui.js';
import { enqueue, syncQueue, updatePendingBadge, cacheDossier, getCachedDossier } from './store.js';

// Springfield, MO — the fallback when geolocation is unavailable or denied.
const DEFAULT_COORDS = { lat: 37.2089, long: -93.2923 };

const state = {
  coords: { ...DEFAULT_COORDS },
  selectedCompanyId: null,
  selectedCompany: null,
  companies: [],
  suggestions: [],
  binary: { is_in_person: 1, is_initial: 1, is_dm_contact: 0 },
  funnelOverride: null,
  audioBlob: null,
  audioType: '',
  audioSeconds: 0,
  lastSubmittedLogId: null
};

let userMarker = null;
let fieldMap = null;
let companyMarkersLayer = null;
let currentMapFilter = 'all_active';

// ---------------------------------------------------------------------
// MAP & DYNAMIC TERRITORY PINS
// ---------------------------------------------------------------------

/**
 * Determine pin color class based on company's activity / disposition state.
 * - Purple: Active Annual Renewal / Open Enrollment window
 * - Gray: Untouched
 * - Blue: Follow-up needed (Gatekeeper, Left Material, No Answer)
 * - Orange: Callback scheduled
 * - Green: Decision Maker Met
 */
function getPinColorClass(company) {
  if (company.is_renewal_active) return 'pin-purple';

  const touches = Number(company.touch_count || 0);
  const disp = (company.latest_disposition || '').toLowerCase();

  if (touches === 0 || !disp) return 'pin-gray';

  if (disp.includes('callback') || disp.includes('follow-up scheduled')) {
    return 'pin-orange';
  }
  if (disp.includes('dm met') || disp.includes('decision maker') || disp.includes('enrolled') || disp.includes('presentation')) {
    return 'pin-green';
  }
  // Default follow-up (gatekeeper, no contact, info left)
  return 'pin-blue';
}

function renderMapPins(companies) {
  if (!fieldMap || typeof L === 'undefined') return;

  if (companyMarkersLayer) {
    companyMarkersLayer.clearLayers();
  } else {
    companyMarkersLayer = L.layerGroup().addTo(fieldMap);
  }

  companies.forEach((company) => {
    if (company.lat === null || company.long === null) return;

    const colorClass = getPinColorClass(company);
    const icon = L.divIcon({
      className: 'custom-map-pin',
      html: `<div class="pin-dot ${colorClass}" title="${company.company_name}"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });

    const marker = L.marker([company.lat, company.long], { icon });

    const statusLabel = company.is_renewal_active
      ? '📅 Upcoming Renewal'
      : (company.touch_count > 0 ? (company.latest_disposition || 'Follow-Up') : 'Untouched');

    const popupCard = document.createElement('div');
    popupCard.className = 'map-popup-card';

    const titleEl = document.createElement('div');
    titleEl.className = 'map-popup-title';
    titleEl.textContent = company.company_name || '';
    popupCard.appendChild(titleEl);

    const addrText = [company.street_1, company.city].filter(Boolean).join(', ');
    if (addrText) {
      const addrEl = document.createElement('div');
      addrEl.className = 'map-popup-meta';
      addrEl.textContent = addrText;
      popupCard.appendChild(addrEl);
    }

    const statusEl = document.createElement('div');
    statusEl.className = 'map-popup-meta';
    statusEl.textContent = 'Status: ';
    const statusStrong = document.createElement('strong');
    statusStrong.textContent = statusLabel;
    if (company.is_renewal_active) {
      statusStrong.style.color = '#c084fc';
    }
    statusEl.appendChild(statusStrong);
    popupCard.appendChild(statusEl);

    if (company.is_renewal_active && company.renewal_date) {
      const renewalEl = document.createElement('div');
      renewalEl.className = 'map-popup-meta';
      renewalEl.style.color = '#c084fc';
      renewalEl.style.fontWeight = '600';
      renewalEl.textContent = `📅 Renewal Date: ${company.renewal_date}`;
      popupCard.appendChild(renewalEl);
    }

    if (company.latest_next_action) {
      const nextEl = document.createElement('div');
      nextEl.className = 'map-popup-meta';
      nextEl.style.color = 'var(--accent-gold)';
      nextEl.textContent = `⚡ ${company.latest_next_action}`;
      popupCard.appendChild(nextEl);
    }

    const btn = document.createElement('button');
    btn.className = 'map-popup-btn';
    btn.type = 'button';
    btn.dataset.id = company.company_id || '';
    btn.textContent = 'Select Account';
    btn.addEventListener('click', () => {
      applyCompany(company);
      fieldMap.closePopup();
    });
    popupCard.appendChild(btn);

    marker.bindPopup(popupCard);
    companyMarkersLayer.addLayer(marker);
  });
}

async function loadMapCompanies(filter = 'all_active') {
  if (!fieldMap) return;
  try {
    const data = await apiFetch(`/api/companies?filter=${encodeURIComponent(filter)}&limit=500`);
    state.companies = data.companies || [];
    renderMapPins(state.companies);
  } catch (err) {
    console.info('Map companies load skipped:', err.message);
  }
}

function initMapFilterChips() {
  const bar = $('mapFilterBar');
  if (!bar) return;

  bar.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      bar.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      currentMapFilter = chip.dataset.filter || 'all_active';
      loadMapCompanies(currentMapFilter);
    });
  });
}

/**
 * Leaflet comes from a CDN, so a cold offline start may not have it. The rest
 * of the app — the part that actually logs activity — must still work rather
 * than dying on a ReferenceError at module scope.
 */
function initMap() {
  const mapEl = $('map');
  if (!mapEl) return;

  if (typeof L === 'undefined') {
    mapEl.classList.add('map-unavailable');
    mapEl.textContent = 'Map unavailable offline — activity logging still works.';
    locate();
    return;
  }

  fieldMap = L.map('map').setView([state.coords.lat, state.coords.long], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(fieldMap);

  userMarker = L.marker([state.coords.lat, state.coords.long], { draggable: true }).addTo(fieldMap);
  userMarker.on('dragend', () => {
    const { lat, lng } = userMarker.getLatLng();
    state.coords = { lat, long: lng };
  });

  locate((coords) => {
    fieldMap.setView([coords.lat, coords.long], 15);
    userMarker.setLatLng([coords.lat, coords.long]);
  });

  initMapFilterChips();
  loadMapCompanies(currentMapFilter);

  // The map is inside a tab panel; revealing it after layout leaves Leaflet
  // with stale dimensions until it is told to re-measure.
  window.addEventListener('viewactivated', (event) => {
    if (event.detail.view === 'field') {
      setTimeout(() => {
        fieldMap.invalidateSize();
        loadMapCompanies(currentMapFilter);
      }, 60);
    }
  });
}

function locate(onFix) {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.coords = { lat: position.coords.latitude, long: position.coords.longitude };
      if (onFix) onFix(state.coords);
    },
    () => console.info('Geolocation unavailable — using Springfield defaults.'),
    // Without a timeout this hangs indefinitely on a weak field signal.
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function initNearestAccount() {
  const btn = $('btnNearestAccount');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (state.coords.lat === null || state.coords.long === null) {
      showToast('GPS coordinates unavailable. Ensure location permissions are enabled.', 'error');
      return;
    }

    let candidateCompanies = state.companies;
    if (!candidateCompanies || candidateCompanies.length === 0) {
      setButtonBusy(btn, true, 'Finding…');
      try {
        const data = await apiFetch('/api/companies?filter=all_active&limit=500');
        candidateCompanies = data.companies || [];
        state.companies = candidateCompanies;
      } catch (err) {
        showToast('Failed to fetch accounts for proximity search.', 'error');
        setButtonBusy(btn, false);
        return;
      } finally {
        setButtonBusy(btn, false);
      }
    }

    const geoCompanies = candidateCompanies.filter(
      (c) => c.lat !== null && c.long !== null && typeof c.lat === 'number' && typeof c.long === 'number'
    );

    if (geoCompanies.length === 0) {
      showToast('No geocoded accounts available to search.', 'info');
      return;
    }

    let nearest = null;
    let minDistance = Infinity;

    for (const comp of geoCompanies) {
      const dist = haversineMiles(state.coords.lat, state.coords.long, comp.lat, comp.long);
      if (dist < minDistance) {
        minDistance = dist;
        nearest = comp;
      }
    }

    if (nearest && minDistance <= 1.0) {
      applyCompany(nearest);
      showToast(`Auto-filled nearest: ${nearest.company_name} (${minDistance < 0.1 ? '<0.1' : minDistance.toFixed(2)} mi)`, 'success');
    } else if (nearest) {
      showToast(`Nearest known account (${nearest.company_name}) is ${minDistance.toFixed(1)} mi away (limit 1.0 mi).`, 'info');
    } else {
      showToast('No accounts found within 1.0 mile of your GPS location.', 'info');
    }
  });
}

// ---------------------------------------------------------------------
// COMPANY TYPE-AHEAD & NEXT ACTION SURFACING
// ---------------------------------------------------------------------

function currentCompanyPayload() {
  const name = $('companyInput').value.trim();
  if (!name) return null;
  return {
    company_id: state.selectedCompanyId || undefined,
    company_name: name,
    street_1: $('streetInput').value.trim() || null,
    city: $('cityInput').value.trim() || null,
    state: $('stateInput').value.trim() || null,
    zip_code: $('zipInput').value.trim() || null,
    lat: state.coords.lat,
    long: state.coords.long
  };
}

function showNextActionCallout(nextActionText) {
  const callout = $('nextActionCallout');
  const textEl = $('nextActionText');
  if (!callout || !textEl) return;

  if (nextActionText && String(nextActionText).trim()) {
    textEl.textContent = String(nextActionText).trim();
    callout.hidden = false;
    $('dossierPanel').hidden = false;
  } else {
    callout.hidden = true;
  }
}

function renderProductInterests(rawInterests) {
  const container = $('productTagContainer');
  if (!container) return;

  let interests = [];
  if (Array.isArray(rawInterests)) {
    interests = rawInterests;
  } else if (typeof rawInterests === 'string' && rawInterests.trim()) {
    try {
      const parsed = JSON.parse(rawInterests);
      if (Array.isArray(parsed)) interests = parsed;
    } catch {
      /* ignore invalid JSON */
    }
  }

  if (interests.length > 0) {
    container.replaceChildren(...interests.map((prod) => el('span', {
      className: 'product-tag',
      text: prod
    })));
    container.hidden = false;
    $('dossierPanel').hidden = false;
  } else {
    container.replaceChildren();
    container.hidden = true;
  }
}

export const OBJECTION_BATTLECARDS = [
  {
    pattern: /major med|health ins|already offer|already have health|full benefits|good health/i,
    title: 'Major Medical Gap Rebuttal',
    script: '"Major medical protects the hospital and doctors, but Aflac pays cash directly to the employee to cover high deductibles, copays, and household bills while off work. Plus, Section 125 payroll pre-taxing saves the company $76.50 in FICA for every $1,000 enrolled."',
    hook: '⚡ Section 125 FICA Tax Reduction + Out-of-Pocket Gap Buffer'
  },
  {
    pattern: /already have aflac|already offer aflac|colonial|allstate|voluntary/i,
    title: 'Existing Voluntary Provider Rebuttal',
    script: '"That\'s excellent — it shows your leadership values supplemental protection. When was your last account review or re-enrollment? We frequently service neglected accounts, update newer riders, and streamline electronic payroll deductions at zero cost."',
    hook: '⚡ Account Service Review + Updated Accident/Disability Riders'
  },
  {
    pattern: /no payroll|payroll slot|admin|too busy|burden|paperwork/i,
    title: 'Administrative Ease Rebuttal',
    script: '"We handle 100% of the employee enrollment, claims, and policy servicing ourselves. Our direct payroll deduction integrates seamlessly with any payroll software with zero setup fees or administrative hassle."',
    hook: '⚡ 100% Agent Serviced + Zero Administrative Cost'
  },
  {
    pattern: /won't buy|not interested|employees don't want|too expensive|can't afford/i,
    title: 'Zero Employer Cost Rebuttal',
    script: '"Because this is 100% voluntary and employee-funded, there is zero financial liability to the business. If even two employees want it, they receive group discounted rates and the company locks in payroll tax savings."',
    hook: '⚡ Zero Employer Cost + Pre-Tax Group Discount'
  },
  {
    pattern: /broker|agent handles|exclusive broker|consultant/i,
    title: 'Broker Complement Rebuttal',
    script: '"We don\'t replace your major medical broker or health plan. Aflac works alongside any broker as a voluntary gap layer that offsets high deductibles without interfering with existing broker relationships."',
    hook: '⚡ Non-Disruptive Voluntary Bridge Layer'
  }
];

export function getObjectionBattlecard(objectionText) {
  if (!objectionText || typeof objectionText !== 'string') return null;
  const match = OBJECTION_BATTLECARDS.find((b) => b.pattern.test(objectionText));
  if (match) return match;
  return {
    title: 'Tactical Value Rebuttal',
    script: '"Aflac provides voluntary employee-paid benefits with zero net cost to the employer, funded through Section 125 pre-tax payroll deductions that reduce employer FICA liability by 7.65%."',
    hook: '⚡ Section 125 Pre-Tax Payroll Savings'
  };
}

function renderObjections(rawObjections) {
  const container = $('objectionTagContainer');
  if (!container) return;

  let objections = [];
  if (Array.isArray(rawObjections)) {
    objections = rawObjections;
  } else if (typeof rawObjections === 'string' && rawObjections.trim()) {
    try {
      const parsed = JSON.parse(rawObjections);
      if (Array.isArray(parsed)) objections = parsed;
    } catch {
      /* ignore invalid JSON */
    }
  }

  if (objections.length > 0) {
    let activeCardIndex = null;

    const render = () => {
      container.replaceChildren();

      const tagsWrapper = el('div', {
        className: 'objection-tags-row',
        style: 'display: flex; flex-wrap: wrap; gap: 0.5rem; width: 100%;'
      });

      objections.forEach((obj, idx) => {
        const isExpanded = activeCardIndex === idx;
        const tag = el('span', {
          className: `objection-tag${isExpanded ? ' is-active' : ''}`,
          text: `🚫 ${obj} ${isExpanded ? '▲' : '💡'}`,
          attrs: { title: 'Click to view tactical 15-second rebuttal battlecard' }
        });

        tag.addEventListener('click', (e) => {
          e.stopPropagation();
          activeCardIndex = (activeCardIndex === idx) ? null : idx;
          render();
        });

        tagsWrapper.appendChild(tag);
      });

      container.appendChild(tagsWrapper);

      if (activeCardIndex !== null && objections[activeCardIndex]) {
        const battlecard = getObjectionBattlecard(objections[activeCardIndex]);
        if (battlecard) {
          const cardEl = el('div', {
            className: 'objection-battlecard',
            children: [
              el('div', { className: 'battlecard-title', text: `🎯 ${battlecard.title} (Re: "${objections[activeCardIndex]}")` }),
              el('div', { className: 'battlecard-script', text: battlecard.script }),
              el('div', { className: 'battlecard-hook', text: battlecard.hook })
            ]
          });
          container.appendChild(cardEl);
        }
      }
    };

    render();
    container.hidden = false;
    $('dossierPanel').hidden = false;
  } else {
    container.replaceChildren();
    container.hidden = true;
  }
}

export function applyCompany(company) {
  state.selectedCompanyId = company.company_id;
  state.selectedCompany = company;
  $('companyInput').value = company.company_name || '';
  $('streetInput').value = company.street_1 || '';
  $('cityInput').value = company.city || '';
  $('stateInput').value = company.state || '';
  $('zipInput').value = company.zip_code || '';

  const touches = Number(company.touch_count || 0);
  if (company.is_renewal_active) {
    $('companyMatchHint').textContent = `Known account · 📅 Upcoming Renewal (Window Active) · renewal date ${company.renewal_date || 'Open Enrollment'}`;
  } else {
    $('companyMatchHint').textContent = touches > 0
      ? `Known account · ${touches} previous ${touches === 1 ? 'touch' : 'touches'} · status ${company.latest_disposition || company.rating || 'Cold'}`
      : `Known account · not yet contacted · rating ${company.rating || 'Cold'}`;
  }
  $('companyMatchHint').className = 'field-hint is-match';

  if (company.lat && company.long && fieldMap) {
    fieldMap.setView([company.lat, company.long], 16);
  }

  // Surface AI Next Action if recorded
  if (company.latest_next_action) {
    showNextActionCallout(company.latest_next_action);
  } else {
    showNextActionCallout(null);
  }

  // Surface Product Interests if recorded
  if (company.latest_product_interests) {
    renderProductInterests(company.latest_product_interests);
  } else {
    renderProductInterests(null);
  }

  // Surface Objections if recorded
  if (company.latest_objections) {
    renderObjections(company.latest_objections);
  } else {
    renderObjections(null);
  }
}

function clearCompanySelection() {
  state.selectedCompanyId = null;
  state.selectedCompany = null;
  $('companyMatchHint').textContent = 'New account — will be created on save.';
  $('companyMatchHint').className = 'field-hint';
  showNextActionCallout(null);
  renderProductInterests(null);
  renderObjections(null);
}

function initCompanySearch() {
  const input = $('companyInput');
  const dropdown = $('customCompanyDropdown');
  if (!input || !dropdown) return;

  let debounceTimer;
  let activeIndex = -1;

  const hideDropdown = () => {
    dropdown.style.display = 'none';
    dropdown.replaceChildren();
    activeIndex = -1;
  };

  const showDropdown = () => {
    if (dropdown.children.length > 0) {
      const rect = input.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < 250) {
        dropdown.style.bottom = '100%';
        dropdown.style.top = 'auto';
        dropdown.style.marginBottom = '4px';
        dropdown.style.marginTop = '0';
      } else {
        dropdown.style.bottom = 'auto';
        dropdown.style.top = '100%';
        dropdown.style.marginTop = '4px';
        dropdown.style.marginBottom = '0';
      }
      dropdown.style.display = 'block';
    }
  };

  const updateActiveSelection = (items) => {
    items.forEach((item, idx) => {
      const isSel = idx === activeIndex;
      item.classList.toggle('is-selected', isSel);
      item.setAttribute('aria-selected', isSel ? 'true' : 'false');
      if (isSel) {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  input.addEventListener('input', () => {
    const query = input.value.trim();

    if (state.selectedCompanyId) {
      clearCompanySelection();
    }

    clearTimeout(debounceTimer);

    if (query.length < 2) {
      hideDropdown();
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const data = await apiFetch(`/api/companies?q=${encodeURIComponent(query)}&limit=8`);
        state.suggestions = data.companies || [];

        if (state.suggestions.length === 0) {
          hideDropdown();
          return;
        }

        dropdown.replaceChildren(...state.suggestions.map((company, idx) => {
          const subtitleParts = [company.street_1, company.city, company.industry].filter(Boolean);
          const li = el('li', {
            className: 'autocomplete-item',
            attrs: {
              role: 'option',
              'data-index': String(idx),
              'aria-selected': 'false'
            },
            children: [
              el('strong', { className: 'autocomplete-name', text: company.company_name }),
              ...(subtitleParts.length > 0 ? [el('span', { className: 'autocomplete-sub', text: subtitleParts.join(' · ') })] : [])
            ]
          });

          // Prevent blur from firing before click
          li.addEventListener('mousedown', (e) => e.preventDefault());
          li.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

          li.addEventListener('click', (e) => {
            e.stopPropagation();
            applyCompany(company);
            hideDropdown();
          });

          return li;
        }));

        activeIndex = -1;
        showDropdown();
      } catch (err) {
        console.info('Company lookup unavailable:', err.message);
        hideDropdown();
      }
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (dropdown.style.display === 'none') return;
    const items = Array.from(dropdown.querySelectorAll('.autocomplete-item'));
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      updateActiveSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      updateActiveSelection(items);
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < state.suggestions.length) {
        e.preventDefault();
        applyCompany(state.suggestions[activeIndex]);
        hideDropdown();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideDropdown();
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(hideDropdown, 180);
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      hideDropdown();
    }
  });
}

// ---------------------------------------------------------------------
// ⚡ INSPECT TARGET (Offline-First Intelligence Caching)
// ---------------------------------------------------------------------

function initInspect() {
  const button = $('inspectBtn');

  button.addEventListener('click', async () => {
    const company = currentCompanyPayload();
    if (!company) {
      showToast('Enter a company name first.', 'error');
      $('companyInput').focus();
      return;
    }

    const cacheKey = state.selectedCompanyId || company.company_name;

    // Check offline cache first
    const cached = await getCachedDossier(cacheKey);

    if (!navigator.onLine) {
      if (cached) {
        renderDossier(cached);
        showToast('Loaded pre-call dossier from offline cache.', 'info');
      } else {
        showToast('Offline — no cached dossier available for this target.', 'warning');
      }
      return;
    }

    setButtonBusy(button, true, 'Scanning…');
    try {
      const data = await apiPost('/api/enrich', {
        company_id: state.selectedCompanyId || undefined,
        company_name: company.company_name,
        street_1: company.street_1,
        city: company.city,
        state: company.state,
        zip_code: company.zip_code
      });
      renderDossier(data);
      // Persist to IndexedDB for offline access in commercial parks
      await cacheDossier(cacheKey, data);
    } catch (err) {
      if (cached) {
        renderDossier(cached);
        showToast(`Online scan failed — displaying cached dossier.`, 'info');
      } else {
        showToast(err.message, 'error');
        renderDossier({ bullets: [], error: err.message });
      }
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function renderDossier({ bullets = [], sources = [], next_action, product_interests, recommended_products, objections, error }) {
  const panel = $('dossierPanel');
  const list = $('dossierList');
  panel.hidden = false;

  if (next_action) {
    showNextActionCallout(next_action);
  }

  if (product_interests) {
    renderProductInterests(product_interests);
  } else if (recommended_products) {
    renderProductInterests(recommended_products);
  }

  if (objections) {
    renderObjections(objections);
  }

  if (error) {
    list.replaceChildren(el('li', { className: 'dossier-error', text: error }));
    $('dossierSources').hidden = true;
    return;
  }

  const items = [...bullets];
  if (state.selectedCompany?.is_renewal_active) {
    items.unshift({
      label: '📅 Upcoming Renewal',
      text: `Open Enrollment Prep Window Active (Scheduled: ${state.selectedCompany.renewal_date || 'Within 35 Days'})`
    });
  }

  list.replaceChildren(...items.map((bullet) => el('li', {
    children: [
      el('strong', { text: `${bullet.label}: ` }),
      document.createTextNode(bullet.text || '')
    ]
  })));

  const sourcePanel = $('dossierSources');
  if (sources.length > 0) {
    sourcePanel.hidden = false;
    $('dossierSourceList').replaceChildren(...sources.map((source) => el('li', {
      children: [el('a', {
        text: source.title || source.url,
        // rel is non-negotiable: these URLs come from a web search, not from us.
        attrs: { href: source.url, target: '_blank', rel: 'noopener noreferrer nofollow' }
      })]
    })));
  } else {
    sourcePanel.hidden = true;
  }
}

// ---------------------------------------------------------------------
// 3-TAP BINARY & QUICK-LOG MACROS
// ---------------------------------------------------------------------

/**
 * Mirrors deriveDisposition() in src/lib/validate.js. The server is the
 * authority — this exists so the agent can see what will be recorded before
 * committing, not to decide it.
 */
function derivedDisposition({ is_in_person, is_initial, is_dm_contact }) {
  if (!is_dm_contact) return is_in_person ? 'Gatekeeper Blocked' : 'No Contact';
  return is_initial ? 'Information Left' : 'Follow-Up Scheduled';
}

function updateDerivedDisposition() {
  const dispoEl = $('derivedDisposition');
  if (!dispoEl) return;
  if (state.funnelOverride) {
    dispoEl.textContent = state.funnelOverride;
  } else {
    dispoEl.textContent = derivedDisposition(state.binary);
  }
}

export function setBinaryToggles(inPerson, initial, dmContact) {
  state.binary = {
    is_in_person: Number(inPerson),
    is_initial: Number(initial),
    is_dm_contact: Number(dmContact)
  };

  const updateGroup = (key, val) => {
    document.querySelectorAll(`.binary-btn[data-toggle="${key}"]`).forEach((btn) => {
      const isActive = Number(btn.dataset.value) === val;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-checked', String(isActive));
    });
  };

  updateGroup('is_in_person', state.binary.is_in_person);
  updateGroup('is_initial', state.binary.is_initial);
  updateGroup('is_dm_contact', state.binary.is_dm_contact);

  updateDerivedDisposition();
  return derivedDisposition(state.binary);
}

function initQuickLogMacros() {
  document.querySelectorAll('.quick-log-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.quick-log-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      setTimeout(() => btn.classList.remove('active'), 1500);

      const preset = btn.dataset.preset;
      if (preset === 'flyer_dropped') {
        setBinaryToggles(1, 1, 0);
        showToast('Macro: In-Person · Initial · Gatekeeper (Information Left)', 'info');
      } else if (preset === 'gatekeeper_block') {
        setBinaryToggles(1, 0, 0);
        showToast('Macro: In-Person · Gatekeeper Blocked', 'info');
      } else if (preset === 'dm_followup') {
        setBinaryToggles(1, 0, 1);
        showToast('Macro: In-Person · DM Met (Follow-Up Scheduled)', 'info');
      }
    });
  });
}

function initBinaryToggles() {
  document.querySelectorAll('.binary-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.toggle;
      const value = Number(button.dataset.value);

      document.querySelectorAll(`.binary-btn[data-toggle="${key}"]`).forEach((sibling) => {
        const isActive = sibling === button;
        sibling.classList.toggle('active', isActive);
        sibling.setAttribute('aria-checked', String(isActive));
      });

      state.binary[key] = value;
      updateDerivedDisposition();
    });
  });

  updateDerivedDisposition();
}

function initFunnelChips() {
  const chips = document.querySelectorAll('.funnel-chips .filter-chip');
  if (!chips.length) return;

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const funnelVal = chip.dataset.funnel;
      if (chip.classList.contains('active')) {
        chip.classList.remove('active');
        state.funnelOverride = null;
        updateDerivedDisposition();
      } else {
        chips.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.funnelOverride = funnelVal;
        $('derivedDisposition').textContent = funnelVal;
      }
    });
  });
}

// ---------------------------------------------------------------------
// VOICE JOURNAL (MediaRecorder — mono Opus)
// ---------------------------------------------------------------------

// Ordered by preference. Chrome/Android give webm/opus; Firefox gives ogg/opus.
const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4'
];

let recorder = null;
let recordedChunks = [];
let recordingTimer = null;
let recordingStartedAt = 0;

const pickMimeType = () => AUDIO_MIME_CANDIDATES.find(
  (type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)
) || '';

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setRecordingUi(recording) {
  const button = $('micBtn');
  button.classList.toggle('recording', recording);
  button.setAttribute('aria-pressed', String(recording));
  button.setAttribute('aria-label', recording ? 'Stop voice journal recording' : 'Start voice journal recording');
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('This browser cannot record audio. Type your note instead.', 'error');
    return;
  }

  let stream;
  try {
    // Mono 16 kHz is what Whisper wants; asking the browser for it up front
    // avoids shipping a stereo 48 kHz stream over a field LTE connection.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (err) {
    console.error('Microphone access failed:', err);
    showToast('Microphone access denied. Type your note instead.', 'error');
    return;
  }

  const mimeType = pickMimeType();
  recordedChunks = [];

  try {
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 24000 // plenty for speech; keeps a 3-minute note ~500KB
    });
  } catch (err) {
    console.error('MediaRecorder init failed:', err);
    stream.getTracks().forEach((track) => track.stop());
    showToast('Could not start the recorder on this device.', 'error');
    return;
  }

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };

  recorder.onstop = () => {
    // Release the mic immediately. On the Book Go the Samson Q2U's ring stays
    // lit until every track is stopped.
    stream.getTracks().forEach((track) => track.stop());
    clearInterval(recordingTimer);
    setRecordingUi(false);

    const type = recorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(recordedChunks, { type });
    state.audioSeconds = Math.round((Date.now() - recordingStartedAt) / 1000);

    if (blob.size === 0) {
      $('recTimer').textContent = 'Ready';
      $('recHint').textContent = 'Nothing captured — try again.';
      return;
    }

    state.audioBlob = blob;
    state.audioType = type;
    $('recTimer').textContent = `Note ready · ${formatDuration(state.audioSeconds)}`;
    $('recHint').textContent = `${Math.round(blob.size / 1024)} KB · transcribes when you log`;
  };

  recorder.onerror = (event) => {
    console.error('Recorder error:', event.error);
    showToast('Recording stopped unexpectedly.', 'error');
    stream.getTracks().forEach((track) => track.stop());
    clearInterval(recordingTimer);
    setRecordingUi(false);
  };

  recordingStartedAt = Date.now();
  // A timeslice keeps chunks flowing, so a crash mid-note still leaves
  // something recoverable rather than one buffer that never flushed.
  recorder.start(1000);
  setRecordingUi(true);
  $('recHint').textContent = 'Recording — tap again to stop';

  recordingTimer = setInterval(() => {
    $('recTimer').textContent = formatDuration((Date.now() - recordingStartedAt) / 1000);
  }, 500);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function clearAudio() {
  state.audioBlob = null;
  state.audioType = '';
  state.audioSeconds = 0;
  recordedChunks = [];
  $('recTimer').textContent = 'Ready';
  $('recHint').textContent = 'Mono Opus · transcribed on stop';
}

function initMic() {
  const button = $('micBtn');
  if (typeof MediaRecorder === 'undefined') {
    button.disabled = true;
    button.title = 'Audio recording is not supported on this browser';
    $('recHint').textContent = 'Recording unsupported — type your note below.';
    return;
  }

  button.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') stopRecording();
    else startRecording();
  });
}

// ---------------------------------------------------------------------
// SAVE
// ---------------------------------------------------------------------

function resetForm() {
  clearAudio();
  $('voiceTranscript').value = '';
  $('dossierPanel').hidden = true;
  $('companyInput').value = '';
  $('streetInput').value = '';
  $('cityInput').value = '';
  $('stateInput').value = '';
  $('zipInput').value = '';
  clearCompanySelection();
  state.funnelOverride = null;
  document.querySelectorAll('.funnel-chips .filter-chip').forEach((c) => c.classList.remove('active'));
  // Reset 3-tap binary toggles to defaults: In-Person · Initial · Gatekeeper.
  // Without this, door #N inherits door #(N-1)'s "DM Met" state and the
  // derived disposition silently reads "Follow-Up Scheduled" instead of the
  // correct "Gatekeeper Blocked" for a fresh cold approach.
  setBinaryToggles(1, 1, 0);
}

// ---------------------------------------------------------------------
// REAL-TIME GAMIFICATION SCOREBOARD
// ---------------------------------------------------------------------

export async function updateScoreboard() {
  const doorsEl = $('hudDoors');
  const dmsEl = $('hudDMs');
  const apptsEl = $('hudAppts');
  if (!doorsEl || !dmsEl || !apptsEl) return;

  try {
    const data = await apiFetch('/api/metrics/today');
    doorsEl.textContent = String(data.doors ?? 0);
    dmsEl.textContent = String(data.dms ?? 0);
    apptsEl.textContent = String(data.next_steps ?? 0);
  } catch (err) {
    console.info('Scoreboard metrics fetch skipped:', err.message);
  }
}

function currentActivityPayload() {
  const company = currentCompanyPayload();
  if (!company) return null;

  const typedNote = $('voiceTranscript').value.trim();
  const logId = crypto.randomUUID();

  return {
    log_id: logId,
    company_id: state.selectedCompanyId || undefined,
    // A known account still ships its payload so an edited address is saved;
    // upsertCompany COALESCEs, so blanks never wipe existing data.
    company,
    ...state.binary,
    manual_disposition: state.funnelOverride || undefined,
    timestamp: new Date().toISOString(),
    raw_audio_transcription: state.audioBlob ? undefined : (typedNote || undefined),
    audioBlob: state.audioBlob || undefined,
    audioType: state.audioType || undefined
  };
}

function initSave() {
  const button = $('saveLogBtn');

  button.addEventListener('click', async () => {
    const entry = currentActivityPayload();
    if (!entry) {
      showToast('Enter a company name first.', 'error');
      $('companyInput').focus();
      return;
    }

    setButtonBusy(button, true, 'Saving…');
    try {
      await enqueue(entry);
      state.lastSubmittedLogId = entry.log_id;
      await updatePendingBadge();
      resetForm();
      showToast(
        state.audioBlob ? 'Queued — transcribing in background.' : 'Activity logged.',
        'success'
      );
      await syncQueue();
      updateScoreboard();
    } catch (err) {
      console.error('Local save failed:', err);
      showToast('Could not save locally. Please retry.', 'error');
    } finally {
      setButtonBusy(button, false);
    }
  });
}

/**
 * The sync engine reports back once a voice log has been transcribed. Show the
 * result if the agent has not already started a different entry — silently
 * overwriting a note they are mid-way through typing would be worse than not
 * showing it at all.
 */
function initVoiceResultListener() {
  window.addEventListener('voicelogged', (event) => {
    const { log_id: logId, transcript, disposition, degraded } = event.detail;
    updateScoreboard();
    if (logId !== state.lastSubmittedLogId) return;
    if (!transcript) return;
    if ($('voiceTranscript').value.trim()) return;

    $('voiceTranscript').value = transcript;
    showToast(
      degraded ? `Logged as "${disposition}" (AI pass degraded).` : `Transcribed · recorded as "${disposition}".`,
      degraded ? 'info' : 'success'
    );
  });
}

export function initFieldView() {
  initMap();
  initNearestAccount();
  initCompanySearch();
  initInspect();
  initQuickLogMacros();
  initBinaryToggles();
  initFunnelChips();
  initMic();
  initSave();
  initVoiceResultListener();
  updateScoreboard();

  window.addEventListener('viewactivated', (event) => {
    if (event.detail.view === 'field') updateScoreboard();
  });
}
