/**
 * Agency OS — Triage Mode.
 *
 * Friday's job: get the top of the funnel clean. Three things happen here, in
 * the order the agent does them.
 *
 *   1. IMPORT. An Apify Google-Maps scrape is a CSV of everything the actor
 *      found in a metro area. It is parsed in the browser (no upload of the raw
 *      file, no server-side CSV dependency) and posted as JSON in one batch.
 *
 *   2. DISQUALIFY. The low-confidence grid is a decision queue, not a report:
 *      one button per row that suppresses the record for good.
 *
 *   3. EXPORT. The D365 compliance block is generated here because closing out
 *      the day is the last thing that happens before leaving the truck.
 *
 * WHY THE PARSER IS HAND-WRITTEN
 * RFC 4180 is ~30 lines of state machine. A CSV dependency would be the only
 * third-party code on the critical path of a PWA that has to work offline, and
 * it would have to be precached to be useful.
 */

import { el } from '../ui.js';
import { mountD365Exporter } from './d365-export.js';

export const LEADS_ENDPOINT = '/api/leads';
export const IMPORT_ENDPOINT = '/api/leads/import';
export const DISQUALIFY_ENDPOINT = '/api/leads/disqualify';

export const CSV_ACCEPT = '.csv,text/csv';

/**
 * Apify header → our column.
 *
 * The coordinate spellings vary by actor version and by whether the export went
 * through a spreadsheet, so every shape seen in the wild is accepted rather
 * than making the agent edit headers in Excel first.
 */
export const APIFY_HEADER_MAP = {
  title: 'company_name',
  phone: 'company_phone',
  street: 'street_1',
  city: 'city',
  state: 'state',
  postalCode: 'zip_code',
  'location/lat': 'lat',
  'location/lng': 'long',
  'location.lat': 'lat',
  'location.lng': 'long',
  'location/long': 'long',
  latitude: 'lat',
  longitude: 'long',
  lat: 'lat',
  lng: 'long',
  long: 'long'
};

/**
 * `companies` has no website column, so the scraped URL is appended to notes
 * instead of being dropped. That is safe to repeat: upsertCompany's notes merge
 * is guarded by instr(), so re-importing the same file cannot duplicate the line.
 */
export const WEBSITE_NOTE_PREFIX = 'Website:';

const TEXT_FIELDS = ['company_phone', 'street_1', 'city', 'state', 'zip_code'];

/**
 * Parse CSV text into rows of cells.
 *
 * Handles the parts of RFC 4180 that actually appear in a scrape: quoted cells
 * containing commas, quoted cells containing newlines, doubled quotes ("") as a
 * literal quote, CRLF or LF line endings, and a UTF-8 BOM. An unterminated
 * final quote is tolerated rather than thrown, because the alternative is
 * refusing a whole file over one truncated directory listing.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  const source = String(text ?? '').replace(/^\uFEFF/, '');

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(cell); cell = ''; continue; }

    if (char === '\r') {
      // A lone CR is a row break; CRLF is left to the \n that follows it.
      if (source[i + 1] !== '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      continue;
    }

    if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }

    cell += char;
  }

  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }

  // Blank lines are common in spreadsheet exports and carry no lead.
  return rows.filter((cells) => cells.some((value) => String(value).trim() !== ''));
}

/** A coordinate that is absent stays absent — never 0, never NaN. */
export function parseCoordinate(value, { limit } = {}) {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (!text) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  if (typeof limit === 'number' && Math.abs(parsed) > limit) return null;

  return parsed;
}

export const parseLatitude = (value) => parseCoordinate(value, { limit: 90 });
export const parseLongitude = (value) => parseCoordinate(value, { limit: 180 });

/** One CSV record → one lead, or null when the row carries no business name. */
export function mapApifyRow(source = {}) {
  const companyName = String(source.title ?? source.company_name ?? source.name ?? '').trim();
  // A scrape always contains a few directory pages and closed shells. Without a
  // name there is nothing to call, so the row is counted and skipped.
  if (!companyName) return null;

  const lead = { company_name: companyName };

  for (const [header, column] of Object.entries(APIFY_HEADER_MAP)) {
    const raw = source[header];
    if (raw === undefined || raw === null) continue;

    const value = String(raw).trim();
    if (!value) continue;

    // First mapped spelling wins: an export that carries both `lat` and
    // `location/lat` must not let the second one overwrite the first.
    if (lead[column] === undefined) lead[column] = value;
  }

  const website = String(source.website ?? '').trim();
  if (website) lead.website = website;

  return lead;
}

/**
 * Parse a whole Apify CSV export.
 *
 * @returns {{leads: object[], skipped: number, headers: string[]}}
 */
export function parseApifyLeads(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return { leads: [], skipped: 0, headers: [] };

  const headers = rows[0].map((header) => String(header).trim());
  const leads = [];
  let skipped = 0;

  for (const cells of rows.slice(1)) {
    const source = {};
    headers.forEach((header, index) => { source[header] = cells[index] ?? ''; });

    const lead = mapApifyRow(source);
    if (lead) leads.push(lead);
    else skipped += 1;
  }

  return { leads, skipped, headers };
}

/**
 * Shape one mapped lead into the payload /api/leads/import expects.
 *
 * Coordinates are only sent as a PAIR. A half-supplied location is not a place,
 * and upsertCompany clears the geohash for exactly that case — sending one half
 * would move the account to latitude 0 without a longitude to match.
 */
export function normalizeImportedLead(lead) {
  const companyName = typeof lead?.company_name === 'string' ? lead.company_name.trim() : '';
  if (!companyName) return null;

  const payload = { company_name: companyName };

  for (const field of TEXT_FIELDS) {
    const value = typeof lead?.[field] === 'string' ? lead[field].trim() : '';
    if (value) payload[field] = value;
  }

  const lat = parseLatitude(lead?.lat);
  const long = parseLongitude(lead?.long);
  if (lat !== null && long !== null) {
    payload.lat = lat;
    payload.long = long;
  }

  const website = typeof lead?.website === 'string' ? lead.website.trim() : '';
  if (website) payload.notes = `${WEBSITE_NOTE_PREFIX} ${website}`;

  return payload;
}

export function buildImportPayload(leads) {
  return (Array.isArray(leads) ? leads : [])
    .map((lead) => normalizeImportedLead(lead))
    .filter(Boolean);
}

async function requestJson(url, { fetchImpl, init } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('network unavailable');

  let res;
  try {
    res = await doFetch(url, init);
  } catch (cause) {
    const error = new Error('network unreachable');
    error.status = 0;
    error.cause = cause;
    throw error;
  }

  if (!res || !res.ok) {
    const error = new Error(`request failed (${res?.status ?? 'no response'})`);
    error.status = res?.status ?? 0;
    throw error;
  }

  return res.json();
}

function readFileText(file) {
  if (typeof file?.text === 'function') return file.text();

  // Older WebViews have no Blob.text(); FileReader is the fallback rather than
  // telling the agent to update their phone.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsText(file);
  });
}

/**
 * @param {Element} container
 * @param {{fetchImpl?: Function, date?: string}} [options]
 * @returns {Function} teardown
 */
export function mountTriageView(container, options = {}) {
  const { fetchImpl, date } = options;

  let leads = [];
  let destroyed = false;
  let busy = false;

  const root = el('div', { className: 'triage-view' });

  // ---- 1. Import ----------------------------------------------------
  const importPanel = el('section', { className: 'triage-panel', attrs: { 'data-triage-import-panel': '' } });
  const fileInput = el('input', {
    className: 'triage-file',
    attrs: { type: 'file', accept: CSV_ACCEPT, 'data-triage-file': '', 'aria-label': 'Apify CSV export' }
  });
  const importButton = el('button', {
    className: 'triage-action-btn',
    text: '📥 Import Apify Leads',
    attrs: { type: 'button', 'data-triage-import': '' }
  });
  const importStatus = el('p', {
    className: 'triage-status',
    attrs: { role: 'status', 'aria-live': 'polite' }
  });
  importPanel.append(
    el('h2', { className: 'triage-panel-title', text: '1 · Import' }),
    fileInput,
    importButton,
    importStatus
  );

  // ---- 2. D365 export ----------------------------------------------
  const exportPanel = el('section', { className: 'triage-panel' });
  exportPanel.append(el('h2', { className: 'triage-panel-title', text: '2 · D365 report' }));
  const exporter = mountD365Exporter(exportPanel, { fetchImpl, date });

  // ---- 3. Low-confidence grid --------------------------------------
  const gridPanel = el('section', { className: 'triage-panel' });
  const gridStatus = el('p', {
    className: 'triage-status',
    attrs: { role: 'status', 'aria-live': 'polite' }
  });
  const gridHost = el('div', { className: 'triage-grid-host' });
  gridPanel.append(
    el('h2', { className: 'triage-panel-title', text: '3 · Low-confidence grid' }),
    gridStatus,
    gridHost
  );

  root.append(importPanel, exportPanel, gridPanel);
  container.replaceChildren(root);

  const setImportStatus = (message) => { importStatus.textContent = message || ''; };
  const setGridStatus = (message) => { gridStatus.textContent = message || ''; };

  function renderGrid() {
    if (leads.length === 0) {
      gridHost.replaceChildren(el('div', {
        className: 'agency-empty',
        children: [
          el('h3', { text: '🎉 Triage is clear' }),
          el('p', { text: 'No accounts left below 40% confidence. Import a fresh scrape or work the Phone queue.' })
        ]
      }));
      return;
    }

    const list = el('div', { className: 'triage-grid' });

    for (const lead of leads) {
      const address = [lead.street_1, lead.city, lead.state].filter(Boolean).join(', ');

      const disqualify = el('button', {
        className: 'triage-dq-btn',
        text: '🚫 Disqualify',
        attrs: {
          type: 'button',
          'data-disqualify': lead.company_id,
          'aria-label': `Disqualify ${lead.company_name || 'this account'}`
        }
      });
      disqualify.addEventListener('click', () => disqualifyLead(lead, disqualify));

      list.append(el('div', {
        className: 'triage-row',
        attrs: { 'data-triage-row': lead.company_id },
        children: [
          el('span', { className: 'triage-row-name', text: lead.company_name || 'Unknown account' }),
          el('span', { className: 'triage-row-address', text: address }),
          el('span', {
            className: 'triage-row-meta',
            text: `${lead.confidence_score ?? 0}% · ${lead.company_phone || 'no phone'}`
          }),
          disqualify
        ]
      }));
    }

    gridHost.replaceChildren(
      el('p', {
        className: 'triage-count',
        text: `${leads.length} low-confidence lead${leads.length === 1 ? '' : 's'}`
      }),
      list
    );
  }

  async function disqualifyLead(lead, button) {
    if (destroyed) return;
    button.disabled = true;
    setGridStatus('Disqualifying…');

    try {
      await requestJson(DISQUALIFY_ENDPOINT, {
        fetchImpl,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company_id: lead.company_id, reason: 'Disqualified in Triage' })
        }
      });

      // Drop the row locally so the queue visibly shrinks on tap, then re-read
      // the server: something else may have moved the confidence band meanwhile.
      leads = leads.filter((entry) => entry.company_id !== lead.company_id);
      setGridStatus('Disqualified.');
      renderGrid();
      load();
    } catch (err) {
      console.error('Agency OS disqualify failed:', err);
      button.disabled = false;
      setGridStatus(`Could not disqualify (${err.message}).`);
    }
  }

  async function load() {
    try {
      const payload = await requestJson(`${LEADS_ENDPOINT}?mode=TRIAGE`, { fetchImpl });
      leads = Array.isArray(payload?.data) ? payload.data : [];
      setGridStatus('');
      renderGrid();
    } catch (err) {
      console.error('Agency OS triage load failed:', err);
      leads = [];
      gridHost.replaceChildren(el('div', {
        className: 'agency-empty',
        children: [
          el('h3', { text: 'Triage grid unavailable' }),
          el('p', { text: 'Could not load low-confidence leads. Check the connection and reload.' })
        ]
      }));
    }
  }

  async function runImport() {
    if (destroyed || busy) return null;

    const file = fileInput.files?.[0];
    if (!file) {
      setImportStatus('Choose a CSV export first.');
      return null;
    }

    busy = true;
    importButton.disabled = true;

    try {
      let text;
      try {
        text = await readFileText(file);
      } catch {
        setImportStatus('Could not read that file.');
        return null;
      }

      const { leads: parsed, skipped } = parseApifyLeads(text);
      const rows = buildImportPayload(parsed);

      if (rows.length === 0) {
        setImportStatus('Nothing usable in that file — every row was missing a business name.');
        return null;
      }

      setImportStatus(`Uploading ${rows.length} leads…`);

      const result = await requestJson(IMPORT_ENDPOINT, {
        fetchImpl,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: rows })
        }
      });

      const rejected = Number(result?.rejected) || 0;
      const summary = [
        `Imported ${Number(result?.imported) || 0} leads`,
        rejected ? `${rejected} rejected` : null,
        skipped ? `${skipped} unusable rows skipped` : null
      ].filter(Boolean).join(' · ');

      setImportStatus(`${summary}.`);
      fileInput.value = '';
      await load();
      return result;
    } catch (err) {
      console.error('Agency OS lead import failed:', err);
      setImportStatus(`Import failed (${err.message}).`);
      return null;
    } finally {
      busy = false;
      importButton.disabled = false;
    }
  }

  importButton.addEventListener('click', runImport);

  // Populate the grid on mount; the import and disqualify paths re-run it.
  load();

  return function destroy() {
    if (destroyed) return;
    destroyed = true;
    importButton.removeEventListener('click', runImport);
    exporter.destroy();
    root.replaceChildren();
    container.replaceChildren();
  };
}
