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
  suggestions: [],
  binary: { is_in_person: 1, is_initial: 1, is_dm_contact: 0 },
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

    const popupHtml = `
      <div class="map-popup-card">
        <div class="map-popup-title">${company.company_name}</div>
        <div class="map-popup-meta">${[company.street_1, company.city].filter(Boolean).join(', ')}</div>
        <div class="map-popup-meta">Status: <strong${company.is_renewal_active ? ' style="color:#c084fc;"' : ''}>${statusLabel}</strong></div>
        ${company.is_renewal_active && company.renewal_date ? `<div class="map-popup-meta" style="color:#c084fc;font-weight:600;">📅 Renewal Date: ${company.renewal_date}</div>` : ''}
        ${company.latest_next_action ? `<div class="map-popup-meta" style="color:var(--accent-gold);">⚡ ${company.latest_next_action}</div>` : ''}
        <button class="map-popup-btn" type="button" data-id="${company.company_id}">Select Account</button>
      </div>
    `;

    marker.bindPopup(popupHtml);
    marker.on('popupopen', (e) => {
      const btn = e.popup.getElement()?.querySelector('.map-popup-btn');
      if (btn) {
        btn.addEventListener('click', () => {
          applyCompany(company);
          fieldMap.closePopup();
        });
      }
    });

    companyMarkersLayer.addLayer(marker);
  });
}

async function loadMapCompanies(filter = 'all_active') {
  if (!fieldMap) return;
  try {
    const data = await apiFetch(`/api/companies?filter=${encodeURIComponent(filter)}&limit=500`);
    renderMapPins(data.companies || []);
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
    long: state.coords.long,
    lead_source: 'Cold Call'
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

function applyCompany(company) {
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
}

function clearCompanySelection() {
  state.selectedCompanyId = null;
  state.selectedCompany = null;
  $('companyMatchHint').textContent = 'New account — will be created on save.';
  $('companyMatchHint').className = 'field-hint';
  showNextActionCallout(null);
  renderProductInterests(null);
}

function initCompanySearch() {
  const input = $('companyInput');
  const list = $('companySuggestions');
  let debounce;

  input.addEventListener('input', () => {
    const query = input.value.trim();

    // Selecting from the datalist fires an `input` event with the full name.
    const exact = state.suggestions.find((s) => s.company_name.toLowerCase() === query.toLowerCase());
    if (exact) {
      applyCompany(exact);
      return;
    }
    if (state.selectedCompanyId) clearCompanySelection();

    clearTimeout(debounce);
    if (query.length < 2) {
      list.replaceChildren();
      return;
    }

    debounce = setTimeout(async () => {
      try {
        const data = await apiFetch(`/api/companies?q=${encodeURIComponent(query)}&limit=8`);
        state.suggestions = data.companies || [];
        list.replaceChildren(...state.suggestions.map((company) => el('option', {
          attrs: { value: company.company_name },
          text: [company.street_1, company.city].filter(Boolean).join(', ')
        })));
      } catch (err) {
        // Offline is the normal case here, not an error worth interrupting for.
        console.info('Company lookup unavailable:', err.message);
      }
    }, 250);
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

function renderDossier({ bullets = [], sources = [], next_action, product_interests, error }) {
  const panel = $('dossierPanel');
  const list = $('dossierList');
  panel.hidden = false;

  if (next_action) {
    showNextActionCallout(next_action);
  }

  if (product_interests) {
    renderProductInterests(product_interests);
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
// 3-TAP BINARY
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
      $('derivedDisposition').textContent = derivedDisposition(state.binary);
    });
  });

  $('derivedDisposition').textContent = derivedDisposition(state.binary);
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
  $('zipInput').value = '';
  clearCompanySelection();
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

function initSave() {
  const button = $('saveLogBtn');

  button.addEventListener('click', async () => {
    const company = currentCompanyPayload();
    if (!company) {
      showToast('Enter a company name first.', 'error');
      $('companyInput').focus();
      return;
    }

    const typedNote = $('voiceTranscript').value.trim();
    const logId = crypto.randomUUID();

    const entry = {
      log_id: logId,
      company_id: state.selectedCompanyId || undefined,
      // A known account still ships its payload so an edited address is saved;
      // upsertCompany COALESCEs, so blanks never wipe existing data.
      company,
      ...state.binary,
      timestamp: new Date().toISOString(),
      raw_audio_transcription: state.audioBlob ? undefined : (typedNote || undefined),
      audioBlob: state.audioBlob || undefined,
      audioType: state.audioType || undefined
    };

    setButtonBusy(button, true, 'Saving…');
    try {
      await enqueue(entry);
      state.lastSubmittedLogId = logId;
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
  initCompanySearch();
  initInspect();
  initBinaryToggles();
  initMic();
  initSave();
  initVoiceResultListener();
  updateScoreboard();

  window.addEventListener('viewactivated', (event) => {
    if (event.detail.view === 'field') updateScoreboard();
  });
}
