/**
 * Company identity resolution.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On 2026-09-01 a 63-target follow-up list was pushed twice through
 * /api/companies/import. The second push carried notes only — no street —
 * and the import path's dedupe guard read:
 *
 *     else if (raw.company_name && raw.street_1) { ...look for a match... }
 *
 * With no street the guard short-circuited, no lookup ran, normalizeCompany()
 * minted a fresh crypto.randomUUID(), and ON CONFLICT(company_id, agent_email)
 * could not fire because that id had never existed. Every one of the 50 rows
 * that survived the batch cap was inserted as a brand-new company. Production
 * reached 307 rows for 249 real accounts.
 *
 * The lesson is that a match key built from raw strings is not an identity.
 * "2850 E Battlefield Rd" and "2850 E. Battlefield" are one address;
 * "The Date Lady" and "Date Lady" are one business; "Springfield Area" is not
 * an address at all. This module turns those into stable keys, and refuses to
 * guess when the evidence is genuinely ambiguous.
 *
 * DESIGN RULE: a false merge is worse than a duplicate. A duplicate is visible
 * in the target list and can be merged later; a false merge silently welds two
 * real prospects together and loses one of them. Every tier below either
 * matches on strong evidence or reports ambiguity — it never breaks a tie by
 * picking a winner.
 */

/** Legal-entity suffixes that carry no identity. Stripped from the tail only. */
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'lc', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'plc', 'lp', 'llp', 'pc', 'pllc', 'group', 'holdings'
]);

/** Street-type words, folded to one canonical spelling. */
const STREET_TYPES = new Map(Object.entries({
  street: 'st', str: 'st', st: 'st',
  road: 'rd', rd: 'rd',
  avenue: 'ave', avenu: 'ave', aven: 'ave', av: 'ave', ave: 'ave',
  boulevard: 'blvd', boul: 'blvd', blvd: 'blvd',
  drive: 'dr', drv: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct',
  circle: 'cir', cir: 'cir',
  place: 'pl', pl: 'pl',
  parkway: 'pkwy', pkwy: 'pkwy', pky: 'pkwy',
  highway: 'hwy', hwy: 'hwy',
  expressway: 'expy', expy: 'expy', expwy: 'expy',
  terrace: 'ter', ter: 'ter',
  trail: 'trl', trl: 'trl',
  square: 'sq', sq: 'sq',
  plaza: 'plz', plz: 'plz',
  crossing: 'xing', xing: 'xing'
}));

/** Directional words, folded to their initials. */
const DIRECTIONALS = new Map(Object.entries({
  north: 'n', n: 'n',
  south: 's', s: 's',
  east: 'e', e: 'e',
  west: 'w', w: 'w',
  northeast: 'ne', ne: 'ne',
  northwest: 'nw', nw: 'nw',
  southeast: 'se', se: 'se',
  southwest: 'sw', sw: 'sw'
}));

/** Secondary-unit designators. Everything from one of these rightward is dropped. */
const UNIT_MARKERS = new Set([
  'ste', 'suite', 'unit', 'apt', 'apartment', 'rm', 'room',
  'bldg', 'building', 'fl', 'floor'
]);

/**
 * Lowercase, strip diacritics, fold '&' to 'and', reduce every run of
 * non-alphanumerics to a single space, and trim.
 *
 * Diacritic folding matters here: the agent's list contains "Vīb Springfield",
 * and a byte comparison against "Vib Springfield" is a miss.
 */
function baseFold(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Canonical form of a business name.
 *
 * Drops a leading "the" and any trailing legal suffixes, so
 * "The Date Lady" === "Date Lady" and
 * "Packers Distributing Company, Inc." === "Packers Distributing".
 *
 * Never reduces a name to nothing: if a name is only suffixes ("The Co."),
 * the folded form is kept so it can still match itself.
 */
export function normalizeName(value) {
  const folded = baseFold(value);
  if (!folded) return '';

  let tokens = folded.split(' ');
  if (tokens.length > 1 && tokens[0] === 'the') tokens = tokens.slice(1);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }

  return tokens.join(' ') || folded;
}

/**
 * Canonical form of a street address, or '' when the value is not an address.
 *
 * The agent's list uses placeholders where he has no street yet —
 * "Springfield Area", "Ozark Corporate HQ", "Hollister Location". Those are
 * notes, not addresses. Treating them as match keys both fails to find the
 * real row and collides unrelated businesses with each other. The digit test
 * below is what separates the two: a US street address always carries a
 * number, a placeholder never does.
 */
export function normalizeStreet(value) {
  const folded = baseFold(value);
  if (!folded || !/\d/.test(folded)) return '';

  const out = [];
  for (const token of folded.split(' ')) {
    if (UNIT_MARKERS.has(token)) break;  // "4127 S Kansas Expy Ste 120" -> drop "Ste 120"
    out.push(STREET_TYPES.get(token) || DIRECTIONALS.get(token) || token);
  }

  // A trailing street type is optional in practice: the agent's list has
  // "2850 E. Battlefield" where D365 has "2850 E Battlefield Rd". Dropping it
  // makes those one address. The collision this admits — same number, same
  // street name, different type ("123 Main St" vs "123 Main Rd") — also
  // requires an identical business name to matter, which does not occur.
  const CANONICAL_TYPES = new Set(STREET_TYPES.values());
  while (out.length > 2 && CANONICAL_TYPES.has(out[out.length - 1])) out.pop();

  return out.join(' ');
}

/** First five digits of a US ZIP. "65802" and "65802-1234" both fold to "65802". */
export function normalizeZip(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : '';
}

/** Last ten digits of a phone number: "(417) 831-0048" -> "4178310048". */
export function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Resolves incoming payloads to company rows that already exist.
 *
 * Built once per import from a single SELECT, then kept current with add() as
 * rows are written — so two payload entries naming the same business inside
 * one batch collapse onto one row instead of racing each other into two.
 */
export class CompanyMatcher {
  constructor(rows = []) {
    this.byAccount = new Map();
    this.byD365 = new Map();
    this.byId = new Set();
    this.byNameStreet = new Map();
    this.byNameZip = new Map();
    this.byName = new Map();   // name -> Set of ids, so ties stay detectable
    this.rows = new Map();     // id -> folded address parts, for disconfirmation
    for (const row of rows) this.add(row);
  }

  add(row) {
    const id = row?.company_id;
    if (!id) return;
    this.byId.add(id);

    const account = row.account_number ? String(row.account_number).trim() : '';
    if (account) this.byAccount.set(account, id);

    const d365 = row.d365_lead_id ? String(row.d365_lead_id).trim() : '';
    if (d365) this.byD365.set(d365, id);

    const name = normalizeName(row.company_name);
    if (!name) return;

    const street = normalizeStreet(row.street_1);
    if (street) this.byNameStreet.set(`${name} ${street}`, id);

    const zip = normalizeZip(row.zip_code);
    if (zip) this.byNameZip.set(`${name} ${zip}`, id);

    this.rows.set(id, { name, street, zip });
    if (!this.byName.has(name)) this.byName.set(name, new Set());
    this.byName.get(name).add(id);
  }

  /**
   * Resolve one incoming payload.
   *
   * Returns { company_id, tier } on a confident match,
   * { ambiguous: true, tier: 'name', candidates } when several distinct
   * accounts share the name and nothing narrows it, or null when the record is
   * genuinely net-new.
   *
   * Tiers run strongest evidence first. Tier 'name' fires only when exactly one
   * account carries that name — "Gateway Furniture" exists at both S Campbell
   * and S Glenstone, and a note-only payload naming it cannot be assigned to
   * either without inventing information.
   */
  resolve(raw) {
    const explicitId = raw?.company_id ? String(raw.company_id).trim() : '';
    if (explicitId && this.byId.has(explicitId)) {
      return { company_id: explicitId, tier: 'company_id' };
    }

    const account = raw?.account_number ? String(raw.account_number).trim() : '';
    if (account && this.byAccount.has(account)) {
      return { company_id: this.byAccount.get(account), tier: 'account_number' };
    }

    const d365 = raw?.d365_lead_id ? String(raw.d365_lead_id).trim() : '';
    if (d365 && this.byD365.has(d365)) {
      return { company_id: this.byD365.get(d365), tier: 'd365_lead_id' };
    }

    const name = normalizeName(raw?.company_name);
    if (!name) return null;

    const street = normalizeStreet(raw?.street_1);
    if (street) {
      const hit = this.byNameStreet.get(`${name} ${street}`);
      if (hit) return { company_id: hit, tier: 'name_street' };
    }

    const zip = normalizeZip(raw?.zip_code);
    if (zip) {
      const hit = this.byNameZip.get(`${name} ${zip}`);
      if (hit) return { company_id: hit, tier: 'name_zip' };
    }

    const candidates = [...(this.byName.get(name) || [])];
    if (candidates.length === 0) return null;

    // Falling back to the name alone is only safe against candidates the
    // payload does not actively contradict. A chain's second location —
    // "Gateway Furniture" on S Glenstone when the known one is on S Campbell —
    // shares the name but is a different prospect, and merging the two would
    // silently delete one of the agent's accounts.
    const viable = candidates.filter((id) => {
      const row = this.rows.get(id) || {};
      if (street && row.street && row.street !== street) return false;
      if (zip && row.zip && row.zip !== zip) return false;
      return true;
    });

    if (viable.length === 0) return null;                                  // new location
    if (viable.length === 1) return { company_id: viable[0], tier: 'name' };

    // Several real accounts share this name and the payload gave us nothing to
    // tell them apart. Say so rather than minting a third row or picking one.
    return { ambiguous: true, tier: 'name', candidates: viable };
  }
}

/**
 * Canonical door key combining normalized name and normalized street address.
 * Returns null if either component is missing, empty, or lacks numeric street digits.
 */
export function getDoorKey(companyName, street1) {
  const name = normalizeName(companyName);
  const street = normalizeStreet(street1);
  if (!name || !street) return null;
  return `${name} ${street}`;
}

