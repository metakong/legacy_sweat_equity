/**
 * Dynamics 365 projection layer — the single place that knows what a D365 row
 * looks like. Tier 1 (clipboard), Tier 2 (.xlsx) and Tier 3 (.csv) all build
 * from D365_OPEN_LEADS_COLUMNS, so the column order can never drift between
 * them.
 *
 * The order below is the real Aflac "Open Leads" export sequence, supplied by
 * the agent on 2026-08-29. It is authoritative — do not "tidy" it. The three
 * leading (Do Not Modify) columns are part of the view itself, which is why
 * they are in this list rather than prepended only for the .xlsx path.
 */

/**
 * Constants that belong to the agent, not to any one prospect. D365 wants them
 * on every row, and nothing in the app's data model can supply them.
 *
 * These are written into every Tier 1 clipboard row, every Tier 2 .xlsx update
 * and every Tier 3 .csv import, so ownership and routing metadata is assigned
 * the moment a record lands in Dynamics.
 *
 * IR_NUMBER is intentionally blank — supply the Aflac writing number and it
 * populates everywhere with no other change.
 */
export const AGENT_PROFILE = {
  LEAD_OWNER: 'SEAN DEARDORFF (CO-AD1LF-0-L1)',
  DSC_USER: 'GINA GRISSOM',
  RSC_USER: 'ZACK SMITH',
  MARKET: 'MO-W',
  IR_NUMBER: ''
};

export function parseNotes(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : { summary: String(value) };
  } catch {
    return { summary: String(value) };
  }
}

/**
 * The voice journal folded into one readable block: AI summary, objections
 * heard, agreed next action, key facts, and the touch metadata.
 *
 * NOTE: the Open Leads view below has no Description or Notes column, so this
 * does NOT currently reach D365 — the notes live only in the app. If you add a
 * notes column to the view, splice one line into the array below at the
 * matching position:
 *
 *     { header: 'Description', get: buildDescription },
 */
export function buildDescription(row) {
  const notes = parseNotes(row.ai_structured_notes);
  const parts = [];

  if (notes.summary) parts.push(notes.summary);
  if (notes.objections?.length) parts.push(`Objections: ${notes.objections.join('; ')}`);
  if (notes.next_action) {
    parts.push(`Next: ${notes.next_action}${notes.next_action_date ? ` (${notes.next_action_date})` : ''}`);
  }
  if (notes.key_facts?.length) parts.push(`Facts: ${notes.key_facts.join('; ')}`);
  if (parts.length === 0 && row.raw_audio_transcription) parts.push(row.raw_audio_transcription);

  parts.push(`[${row.is_in_person ? 'In person' : 'Phone'} · ${row.is_initial ? 'Initial' : 'Follow-up'} · ${row.is_dm_contact ? 'DM reached' : 'Gatekeeper'}]`);
  return parts.join(' ');
}

/**
 * Columns the CRM view carries but this app has no source for. They export
 * blank rather than guessed. `row.<name>` is read first so that adding the
 * column to D1 later makes it populate with no change here.
 */
const passthrough = (field) => (row) => row?.[field] ?? '';

/** The Aflac "Open Leads" view, left to right. Authoritative ordering. */
export const D365_OPEN_LEADS_COLUMNS = [
  { header: '(Do Not Modify) Lead', get: (r) => r.d365_lead_id },
  { header: '(Do Not Modify) Row Checksum', get: (r) => r.d365_checksum },
  { header: '(Do Not Modify) Modified On', get: (r) => r.d365_modified_on },
  // The lead record's own creation date, not the touch — those are different
  // columns in this view ('Last Activity' is the touch).
  { header: 'Created On', get: (r) => localStamp(r.company_created_at || r.created_at || r.timestamp || r.last_touched) },
  { header: 'Last Activity', get: (r) => localStamp(r.timestamp || r.last_touched) },
  { header: 'Business Name', get: (r) => r.company_name },
  { header: 'Lead Source', get: (r) => r.lead_source },
  { header: 'First Name', get: (r) => r.first_name },
  { header: 'Last Name', get: (r) => r.last_name },
  { header: 'Lead Owner', get: () => AGENT_PROFILE.LEAD_OWNER },
  { header: 'DSC User (Owning Team) (Team)', get: () => AGENT_PROFILE.DSC_USER },
  { header: 'Rating', get: (r) => r.rating },
  { header: 'Phone Number', get: (r) => r.phone_number },
  { header: 'Email Address', get: (r) => r.email_address },
  { header: 'Job Title', get: (r) => r.job_title },
  { header: 'Updated DM Presentation Date', get: (r) => r.presentation_date || '' },
  { header: 'Employees', get: (r) => r.employees },
  { header: 'Industry', get: (r) => r.industry },
  { header: 'IR Number', get: () => AGENT_PROFILE.IR_NUMBER },
  { header: 'SIC Code', get: passthrough('sic_code') },
  { header: 'Updated Enrollment Date', get: (r) => r.enrollment_date || '' },
  { header: 'Account Number', get: passthrough('account_number') },
  { header: 'Agent Projected AP', get: (r) => (r.projected_ap ?? '') },
  { header: 'Post Enrollment Date', get: passthrough('post_enrollment_date') },
  { header: 'Street 1', get: (r) => r.street_1 },
  { header: 'Street 2', get: (r) => r.street_2 },
  { header: 'City', get: (r) => r.city },
  { header: 'State', get: (r) => r.state },
  { header: 'Zip Code', get: (r) => r.zip_code },
  { header: 'Market (Owning Team) (Team)', get: () => AGENT_PROFILE.MARKET },
  { header: 'RSC User (Owning Team) (Team)', get: () => AGENT_PROFILE.RSC_USER }
];

/**
 * The three columns Dynamics emits on "Export to Excel" and demands back on
 * re-import. Round-tripping them verbatim is what lets a Tier 2 upload update
 * an existing lead instead of failing validation or creating a duplicate — the
 * checksum is how D365 proves the row is the one it handed out.
 *
 * Derived from the canonical list rather than duplicated, so the two can never
 * disagree about what those headers are.
 */
export const D365_TIER2_KEY_COLUMNS = D365_OPEN_LEADS_COLUMNS.slice(0, 3);

// ---------------------------------------------------------------------
// FORMATTING
// ---------------------------------------------------------------------

const BUSINESS_TZ = 'America/Chicago';

/** 'YYYY-MM-DD HH:MM' local. A UTC stamp would misdate every evening call. */
export function localStamp(timestamp) {
  if (!timestamp) return '';
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(timestamp)
    ? timestamp
    : `${String(timestamp).replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date(parsed));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hour = String(Number(p.hour) % 24).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}`;
}

const cellValue = (column, row) => {
  const value = column.get(row);
  return value === null || value === undefined ? '' : String(value);
};

/**
 * A tab or newline inside a cell terminates the cell (or the row) when pasted
 * into a grid, silently shifting every column after it. Collapse them.
 */
const flattenForTsv = (value) => String(value).replace(/[\t\r\n]+/g, ' ').trim();

/** One tab-delimited row, ready for navigator.clipboard.writeText(). */
export function toTabDelimitedRow(row, columns = D365_OPEN_LEADS_COLUMNS) {
  return columns.map((column) => flattenForTsv(cellValue(column, row))).join('\t');
}

/** Many rows, newline separated. Headers are optional — D365 grids want none. */
export function toTabDelimited(rows, { includeHeaders = false, columns = D365_OPEN_LEADS_COLUMNS } = {}) {
  const lines = rows.map((row) => toTabDelimitedRow(row, columns));
  if (includeHeaders) lines.unshift(columns.map((c) => c.header).join('\t'));
  return lines.join('\n');
}

/** RFC 4180 CSV. Quotes anything containing a comma, quote, or newline. */
export function toCsv(rows, columns = D365_OPEN_LEADS_COLUMNS) {
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((c) => escape(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(cellValue(column, row))).join(','));
  }
  // CRLF: Excel and the D365 import wizard both expect it.
  return lines.join('\r\n');
}

/** Rows as arrays-of-arrays, which is what SheetJS's aoa_to_sheet wants. */
export function toMatrix(rows, columns) {
  return [columns.map((c) => c.header), ...rows.map((row) => columns.map((column) => {
    const value = column.get(row);
    return value === null || value === undefined ? '' : value;
  }))];
}

// ---------------------------------------------------------------------
// SHEETJS (lazy)
// ---------------------------------------------------------------------

const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
// Pinned by hash: a CDN compromise cannot swap the library out from under an
// export that carries real prospect data.
const SHEETJS_SRI = 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT';

let sheetJsPromise = null;

/** Load SheetJS on first use. Mobile never pays for it. */
export function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (sheetJsPromise) return sheetJsPromise;

  sheetJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SHEETJS_URL;
    script.integrity = SHEETJS_SRI;
    script.crossOrigin = 'anonymous';
    script.onload = () => (window.XLSX
      ? resolve(window.XLSX)
      : reject(new Error('SheetJS loaded but exposed no XLSX global')));
    script.onerror = () => {
      sheetJsPromise = null; // allow a retry once connectivity is back
      reject(new Error('Could not load SheetJS (offline, or CDN blocked)'));
    };
    document.head.appendChild(script);
  });

  return sheetJsPromise;
}

/**
 * Tier 2 workbook — a direct projection of the Open Leads view, so the three
 * (Do Not Modify) columns land in columns A-C exactly where Dynamics expects
 * them on re-import.
 */
export async function buildTier2Workbook(rows) {
  const XLSX = await loadSheetJs();
  // The (Do Not Modify) columns already lead the canonical view, so the
  // workbook is a straight projection of it.
  const columns = D365_OPEN_LEADS_COLUMNS;
  const sheet = XLSX.utils.aoa_to_sheet(toMatrix(rows, columns));

  // Widths only — no styling. The D365 importer reads values, and a styled
  // workbook is just a bigger file.
  sheet['!cols'] = columns.map((column) => ({
    wch: Math.min(46, Math.max(12, column.header.length + 4))
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Leads');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

// ---------------------------------------------------------------------
// DOWNLOAD
// ---------------------------------------------------------------------

/** Hand the browser a generated file. Revokes the object URL after the click. */
export function downloadFile(data, filename, mimeType) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Clipboard write with a fallback. navigator.clipboard requires a secure
 * context, which localhost satisfies but a plain-HTTP LAN address does not.
 */
export async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('Clipboard is unavailable in this context');
}
