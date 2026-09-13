/**
 * Sprint 4 — view logic.
 *
 * The routing math and the URL builder are pure functions, so they are tested
 * directly. The views themselves need a DOM, and this project has no jsdom
 * dependency, so the doubles below are hand-written — same approach as
 * test/frontend.test.js and test/markdown.test.js.
 *
 * The double implements enough of Element to be meaningful: attribute queries
 * walk the tree (`[data-quick-drop]`), and dispatchEvent really does call the
 * listeners the views attached, so a click test exercises the same code path a
 * finger would.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_WAYPOINTS,
  ROUTE_BLOCK_SIZE,
  DEFAULT_ORIGIN,
  orderStopsNearestNeighbor,
  orderStopsTwoOpt,
  improveWithTwoOpt,
  pathLengthMeters,
  splitRouteBlocks,
  buildGoogleMapsUrl,
  ficaRecaptureEstimates,
  hasCoordinates,
  mountCanvassView
} from '../public/app/modules/canvass-view.js';

import { mountDialerView, DIALER_QUICK_DROPS } from '../public/app/modules/dialer-view.js';

// Sprint 5 view modules. imported here rather than in frontend.test.js because
// these assertions are about DOM output, not about the storage layer.
import {
  D365_FIELD_ORDER,
  formatD365Report,
  mountD365Exporter,
  toCount,
  todayInSpringfield
} from '../public/app/modules/d365-export.js';
import { mountTriageView } from '../public/app/modules/triage-view.js';

const ROOT = process.cwd();

// ---------------------------------------------------------------------
// MINIMAL DOM
// ---------------------------------------------------------------------

class FakeEventTarget {
  constructor() { this._listeners = new Map(); }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) { this._listeners.get(type)?.delete(handler); }

  dispatchEvent(event) {
    for (const handler of [...(this._listeners.get(event.type) || [])]) handler(event);
    return true;
  }
}

class FakeClassList {
  constructor(node) { this._node = node; }
  _set() {
    const raw = this._node.attributes.class || '';
    return new Set(raw.split(/\s+/).filter(Boolean));
  }
  _write(set) { this._node.attributes.class = [...set].join(' '); }
  add(...names) { const set = this._set(); names.forEach((n) => set.add(n)); this._write(set); }
  remove(...names) { const set = this._set(); names.forEach((n) => set.delete(n)); this._write(set); }
  contains(name) { return this._set().has(name); }
  toggle(name, force) {
    const on = typeof force === 'boolean' ? force : !this.contains(name);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.type = '';
    this.disabled = false;
    this.children = [];
    this.attributes = {};
    this._text = '';
    this.classList = new FakeClassList(this);
  }

  set className(value) { this.attributes.class = String(value); }
  get className() { return this.attributes.class || ''; }

  set id(value) { this.attributes.id = String(value); }
  get id() { return this.attributes.id || ''; }

  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join(' ')
      : this._text;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  removeAttribute(name) { delete this.attributes[name]; }

  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ''; }

  /** Supports the two selector shapes the views actually use. */
  querySelectorAll(selector) {
    const attr = selector.match(/^\[([\w-]+)\]$/);
    const tag = selector.match(/^([a-zA-Z]+)$/);

    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (attr && Object.prototype.hasOwnProperty.call(child.attributes, attr[1])) out.push(child);
        else if (tag && child.tagName === tag[1].toUpperCase()) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

function installDom() {
  const document = Object.assign(new FakeEventTarget(), {
    visibilityState: 'visible',
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    // ui.js resolves chrome nodes by id; returning null is the "not in this
    // document" case, which every caller already handles.
    getElementById: () => null,
    createElement: (tag) => new FakeElement(tag)
  });

  globalThis.document = document;
  globalThis.window = new FakeEventTarget();
  globalThis.HTMLElement = FakeElement;
  return document;
}

/** Let queued promises and macrotasks settle. */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(node) {
  return node.children.length
    ? node.children.map((child) => textOf(child)).join(' ')
    : node.textContent;
}

// Five stops on one street, listed out of sequence. On the map this is three
// needless back-and-forths; ordering it is a single pass down the block.
const SCATTERED = [
  { id: 'p0', lat: 37.200, long: -93.300 },
  { id: 'p4', lat: 37.200, long: -93.260 },
  { id: 'p1', lat: 37.200, long: -93.290 },
  { id: 'p3', lat: 37.200, long: -93.270 },
  { id: 'p2', lat: 37.200, long: -93.280 }
];

// ---------------------------------------------------------------------
// TSP
// ---------------------------------------------------------------------

test('nearest neighbour starts at the stop closest to the agent', () => {
  const stops = [
    { id: 'far', lat: 37.300, long: -93.300 },
    { id: 'near', lat: 37.209, long: -93.293 },
    { id: 'mid', lat: 37.250, long: -93.300 }
  ];

  const ordered = orderStopsNearestNeighbor(stops, DEFAULT_ORIGIN);
  assert.equal(ordered[0].id, 'near');
  assert.equal(ordered.length, 3, 'nothing is dropped');
});

test('the 2-opt route is meaningfully shorter than the list order', () => {
  const before = pathLengthMeters(SCATTERED);
  const after = pathLengthMeters(orderStopsTwoOpt(SCATTERED));

  assert.ok(after < before, `expected ${after} < ${before}`);
  assert.ok(
    after < before * 0.7,
    `walking one street once instead of three times should cut the drive sharply (${after} vs ${before})`
  );

  // The ordered run should visit the block in sequence, not scramble it again.
  assert.deepEqual(
    orderStopsTwoOpt(SCATTERED).map((stop) => stop.id),
    ['p0', 'p1', 'p2', 'p3', 'p4']
  );
});

test('2-opt never makes a route worse than nearest neighbour alone', () => {
  const greedy = pathLengthMeters(orderStopsNearestNeighbor(SCATTERED));
  const refined = pathLengthMeters(improveWithTwoOpt(orderStopsNearestNeighbor(SCATTERED)));

  assert.ok(refined <= greedy + 1e-6, `${refined} must not exceed ${greedy}`);
});

test('stops without coordinates are kept, at the end', () => {
  const mixed = [
    { id: 'geo-1', lat: 37.20, long: -93.30 },
    { id: 'no-geo', lat: null, long: null },
    { id: 'geo-2', lat: 37.21, long: -93.29 }
  ];

  const ordered = orderStopsTwoOpt(mixed);

  assert.equal(ordered.length, 3, 'an ungeocoded account is still an account');
  assert.equal(ordered[ordered.length - 1].id, 'no-geo');
  assert.equal(hasCoordinates(ordered[ordered.length - 1]), false);
});

test('30 stops split into three blocks of ten, labelled by part of day', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    lat: 37.2 + i * 0.001,
    long: -93.3
  }));

  const blocks = splitRouteBlocks(thirty);

  assert.equal(ROUTE_BLOCK_SIZE, 10);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((block) => block.stops.length), [10, 10, 10]);
  assert.match(blocks[0].label, /Morning/);
  assert.match(blocks[1].label, /Midday/);
  assert.match(blocks[2].label, /Afternoon/);
  assert.equal(blocks[0].stops[0].id, 's0');
  assert.equal(blocks[2].stops[9].id, 's29');
});

// ---------------------------------------------------------------------
// GOOGLE MAPS DEEP LINK
// ---------------------------------------------------------------------

test('the deep link puts the last stop in destination and pipes the rest', () => {
  const block = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`,
    lat: 37.2 + i * 0.001,
    long: -93.3 - i * 0.001
  }));

  const url = buildGoogleMapsUrl(block, { origin: 'Current Location' });

  assert.ok(url.startsWith('https://www.google.com/maps/dir/?'), url);
  assert.ok(url.includes('api=1'));
  assert.ok(url.includes('origin=Current%20Location'));

  const last = block[block.length - 1];
  assert.ok(url.includes(`destination=${last.lat.toFixed(6)},${last.long.toFixed(6)}`));

  const waypoints = url.split('waypoints=')[1].split('|');
  assert.equal(waypoints.length, 9, '10 stops = 9 waypoints + 1 destination');
  assert.equal(waypoints[0], `${block[0].lat.toFixed(6)},${block[0].long.toFixed(6)}`);
});

test('the waypoint list never exceeds the limit of ten', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => ({
    id: `s${i}`,
    lat: 37.2 + i * 0.001,
    long: -93.3
  }));

  const url = buildGoogleMapsUrl(eleven);
  const waypoints = url.split('waypoints=')[1].split('|');

  assert.equal(MAX_WAYPOINTS, 10);
  assert.equal(
    waypoints.length,
    MAX_WAYPOINTS,
    'the eleventh stop becomes the destination rather than an eleventh waypoint'
  );
});

test('a single stop routes without a waypoint parameter', () => {
  const url = buildGoogleMapsUrl([{ id: 'only', lat: 37.2, long: -93.3 }]);

  assert.ok(url.includes('destination=37.200000,-93.300000'));
  assert.ok(!url.includes('waypoints='));
});

test('an unroutable block produces no link at all', () => {
  assert.equal(buildGoogleMapsUrl([]), null);
  assert.equal(buildGoogleMapsUrl([{ id: 'x', lat: null, long: null }]), null);
  assert.equal(buildGoogleMapsUrl(undefined), null);

  // A mixed block still links, using only the stops that have coordinates.
  const mixed = buildGoogleMapsUrl([
    { id: 'geo', lat: 37.2, long: -93.3 },
    { id: 'no-geo', lat: null, long: null }
  ]);
  assert.ok(mixed.includes('destination=37.200000,-93.300000'));
  assert.ok(!mixed.includes('waypoints='));
});

// ---------------------------------------------------------------------
// FICA RECAPTURE
// ---------------------------------------------------------------------

test('the FICA recapture figures match the Section 125 formulas', () => {
  const fica = ficaRecaptureEstimates(25);

  assert.equal(fica.lives, 25);
  assert.equal(fica.conservative, Math.round(25 * 0.40 * 1500 * 0.0765));
  assert.equal(fica.baseline, Math.round(25 * 0.60 * 2400 * 0.0765));
  assert.ok(fica.baseline > fica.conservative);

  // An unknown headcount must not invent a number.
  assert.deepEqual(ficaRecaptureEstimates(null), { lives: 0, conservative: 0, baseline: 0 });
  assert.deepEqual(ficaRecaptureEstimates('many'), { lives: 0, conservative: 0, baseline: 0 });
});

// ---------------------------------------------------------------------
// SHELL CONTRACT
// ---------------------------------------------------------------------

test('index.html ships the Agency OS shell the navigation module binds to', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');

  assert.match(html, /<div id="view-container"/, 'the mount point the views render into');
  for (const mode of ['PHONE', 'FIELD', 'TRIAGE']) {
    assert.match(html, new RegExp(`data-agency-mode="${mode}"`), `${mode} mode button`);
  }
  assert.match(html, /data-agency-theme-toggle/, 'the sun-glare toggle');
  assert.match(html, /data-agency-legacy/, 'the way back to the console');
  assert.match(html, /<div class="app-shell" id="legacy-shell">/, 'the console is retained, not removed');
});

test('app.css carries the shell and high-contrast rules', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/app/app.css'), 'utf8');

  assert.match(css, /body\[data-agency-shell="active"\] #legacy-shell\s*\{\s*display:\s*none/);
  assert.match(css, /html\[data-theme="high-contrast"\]\s*\{/);
  assert.match(css, /html\[data-theme="high-contrast"\] body\s*\{[\s\S]*?background:\s*#ffffff/);
  assert.match(css, /\.dialer-call\s*\{/);
  assert.match(css, /\.voice-hold-btn\s*\{/);
  assert.match(css, /\.canvass-launch\s*\{/);
});

// ---------------------------------------------------------------------
// VIEW MOUNTING
// ---------------------------------------------------------------------

function leadFixture(overrides = {}) {
  return {
    company_id: 'acct-1',
    company_name: 'Ozark Dental Group',
    decision_maker_name: 'Dana Whitfield',
    company_phone: '417-831-0048',
    confidence_score: 60,
    current_voluntary_carrier: 'Colonial',
    estimated_w2_count: 12,
    pipeline_stage: 'PROSPECT',
    lat: 37.2,
    long: -93.29,
    ...overrides
  };
}

/** fetch stub: serves the lead queue, and records every call. */
function leadsFetcher(data, record = [], { activityOk = true, activityStatus = 503 } = {}) {
  return async (url, init) => {
    record.push({ url: String(url), init });

    if (String(url).includes('/api/leads')) {
      return { ok: true, status: 200, json: async () => ({ success: true, count: data.length, data }) };
    }
    if (!activityOk) {
      return { ok: false, status: activityStatus, json: async () => ({ error: 'unavailable' }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, activity_id: 1 }) };
  };
}

/** Silence the console.error the intentional failure paths emit. */
async function withQuietConsole(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('the dialer renders one card at a time with a tel: target', async () => {
  installDom();
  const container = new FakeElement('div');
  const leads = [
    leadFixture(),
    leadFixture({ company_id: 'acct-2', company_name: 'Bravo Logistics', company_phone: '417-555-1212' })
  ];

  const destroy = mountDialerView(container, { fetchImpl: leadsFetcher(leads) });
  await tick(5);

  const text = textOf(container);
  assert.match(text, /Ozark Dental Group/);
  assert.match(text, /Dana Whitfield/);
  assert.match(text, /Lead 1 of 2/);
  assert.ok(!text.includes('Bravo Logistics'), 'the stack shows only the card being dialed');

  const call = container.querySelectorAll('a').find((node) => node.getAttribute('href'));
  assert.equal(call.getAttribute('href'), 'tel:4178310048', 'the number is a one-tap dial target');

  const drops = container.querySelectorAll('[data-quick-drop]');
  assert.equal(drops.length, 3);
  assert.deepEqual(
    drops.map((button) => button.getAttribute('data-quick-drop')),
    ['VM_NO_ANSWER', 'GATEKEEPER_BLOCK', 'WRONG_NUMBER']
  );
  assert.deepEqual(
    DIALER_QUICK_DROPS.map((drop) => drop.key),
    ['VM_NO_ANSWER', 'GATEKEEPER_BLOCK', 'WRONG_NUMBER']
  );

  destroy();
});

test('a quick drop logs the disposition and advances the stack', async () => {
  installDom();
  const container = new FakeElement('div');
  const posted = [];
  const leads = [leadFixture(), leadFixture({ company_id: 'acct-2', company_name: 'Bravo Logistics' })];

  const destroy = mountDialerView(container, { fetchImpl: leadsFetcher(leads, posted) });
  await tick(5);

  container.querySelectorAll('[data-quick-drop]')[0].dispatchEvent({ type: 'click' });
  await tick(5);

  const post = posted.find((entry) => entry.init?.method === 'POST');
  assert.ok(post, 'the disposition is POSTed');
  assert.deepEqual(JSON.parse(post.init.body), {
    company_id: 'acct-1',
    disposition: 'VM_NO_ANSWER',
    mode: 'PHONE'
  });
  assert.match(textOf(container), /Bravo Logistics/);
  assert.match(textOf(container), /Lead 2 of 2/);

  destroy();
});

test('an offline quick drop hands the tap to the outbox and still advances', async () => {
  installDom();
  const container = new FakeElement('div');
  const leads = [leadFixture(), leadFixture({ company_id: 'acct-2', company_name: 'Bravo Logistics' })];

  const destroy = await withQuietConsole(async () => {
    const teardown = mountDialerView(container, {
      fetchImpl: leadsFetcher(leads, [], { activityOk: false, activityStatus: 503 })
    });
    await tick(5);

    container.querySelectorAll('[data-quick-drop]')[0].dispatchEvent({ type: 'click' });
    await tick(5);

    return teardown;
  });

  const text = textOf(container);
  // Sprint 5 changed this deliberately: the agent has already hung up, so a
  // dropped connection must not stop the next dial. The disposition becomes the
  // outbox's problem, and the card advances either way.
  assert.match(text, /Bravo Logistics/);
  assert.match(text, /Lead 2 of 2/);
  assert.match(text, /Offline/);

  destroy();
});

test('a 4xx is reported rather than queued, and the dialer still advances', async () => {
  installDom();
  const container = new FakeElement('div');
  const leads = [leadFixture(), leadFixture({ company_id: 'acct-2', company_name: 'Bravo Logistics' })];

  const destroy = await withQuietConsole(async () => {
    const teardown = mountDialerView(container, {
      fetchImpl: leadsFetcher(leads, [], { activityOk: false, activityStatus: 404 })
    });
    await tick(5);

    container.querySelectorAll('[data-quick-drop]')[0].dispatchEvent({ type: 'click' });
    await tick(5);

    return teardown;
  });

  const text = textOf(container);
  assert.match(text, /Bravo Logistics/, 'the agent is never blocked');
  assert.match(text, /Server rejected this \(404\)/, 'but is told it was not recorded');

  destroy();
});

test('an unreachable lead queue renders guidance instead of an empty shell', async () => {
  installDom();
  const container = new FakeElement('div');

  const destroy = await withQuietConsole(async () => {
    const teardown = mountDialerView(container, {
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); }
    });
    await tick(5);
    return teardown;
  });

  assert.match(textOf(container), /Call list unavailable/);
  destroy();
});

test('the canvass view renders ordered blocks, FICA figures and launch links', async () => {
  installDom();
  const container = new FakeElement('div');
  const leads = [
    leadFixture({
      company_id: 'c1', company_name: 'Alpha Co', lat: 37.200, long: -93.300,
      current_voluntary_carrier: 'Colonial', estimated_w2_count: 25, street_1: '1 A St'
    }),
    leadFixture({
      company_id: 'c2', company_name: 'Bravo Co', lat: 37.210, long: -93.290,
      current_voluntary_carrier: null, estimated_w2_count: 0, street_1: '2 B St'
    })
  ];

  const destroy = mountCanvassView(container, { fetchImpl: leadsFetcher(leads), origin: DEFAULT_ORIGIN });
  await tick(5);

  const text = textOf(container);
  assert.match(text, /2 stops/);
  assert.match(text, /1 block/);
  assert.match(text, /Alpha Co/);
  assert.match(text, /Carrier: Colonial/);
  assert.match(text, /25 W-2/);
  assert.match(text, /FICA\/yr conservative/);
  assert.match(text, /Carrier: unknown/, 'a missing carrier is reported, not guessed');

  const launch = container.querySelectorAll('[data-launch-route]');
  assert.equal(launch.length, 1);
  const href = launch[0].getAttribute('href');
  assert.ok(href.startsWith('https://www.google.com/maps/dir/?'), href);
  assert.equal(href.split('waypoints=')[1].split('|').length, 1, 'two stops = one waypoint + destination');

  destroy();
});

test('an empty field queue renders guidance, not a broken route', async () => {
  installDom();
  const container = new FakeElement('div');

  const destroy = mountCanvassView(container, { fetchImpl: leadsFetcher([]) });
  await tick(5);

  assert.match(textOf(container), /No canvass targets/);
  destroy();
});

test('unmounting a view removes its DOM', async () => {
  installDom();
  const container = new FakeElement('div');

  const destroy = mountCanvassView(container, { fetchImpl: leadsFetcher([leadFixture()]) });
  await tick(5);
  assert.ok(container.children.length > 0);

  destroy();
  assert.equal(container.children.length, 0, 'a mode switch must not leave a view behind');
});

// ---------------------------------------------------------------------
// D365 COMPLIANCE EXPORT
// ---------------------------------------------------------------------

test('the D365 block is byte-for-byte the shape the CRM paste expects', () => {
  const text = formatD365Report({
    date: '2026-09-12',
    walk_ins: 3,
    dm_contacts: 5,
    phone_dials: 42,
    appointments_set: 2
  });

  assert.equal(text, [
    'DATE: 2026-09-12',
    'WALK-INS: 3',
    'DM CONTACTS: 5',
    'PHONE DIALS: 42',
    'APPOINTMENTS: 2'
  ].join('\n'));

  assert.deepEqual(D365_FIELD_ORDER, ['walk_ins', 'dm_contacts', 'phone_dials', 'appointments_set']);
});

test('missing counters print as 0, never as NaN', () => {
  const text = formatD365Report({ date: '2026-09-12' });

  assert.match(text, /WALK-INS: 0/);
  assert.match(text, /PHONE DIALS: 0/);
  assert.match(text, /APPOINTMENTS: 0/);
  assert.ok(!text.includes('NaN'), 'a NaN on the clipboard is worse than a zero');

  assert.equal(toCount(undefined), 0);
  assert.equal(toCount(null), 0);
  assert.equal(toCount('nonsense'), 0);
  assert.equal(toCount('7'), 7);
  assert.equal(toCount(-4), 0);
});

test('the report date is Springfield local, so an evening block is not tomorrow', () => {
  // 02:00 UTC on the 13th is 9pm CDT on the 12th — the last hour of a phone block.
  assert.equal(todayInSpringfield(new Date('2026-09-13T02:00:00Z')), '2026-09-12');
  assert.equal(todayInSpringfield(new Date('2026-09-13T06:00:00Z')), '2026-09-13');
});

test('the export button copies the block and confirms it', async () => {
  installDom();
  const host = new FakeElement('div');
  const copied = [];
  const toasts = [];

  const exporter = mountD365Exporter(host, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        date: '2026-09-12',
        walk_ins: 3,
        dm_contacts: 5,
        phone_dials: 42,
        appointments_set: 2
      })
    }),
    copyImpl: async (text) => { copied.push(text); return true; },
    showToastImpl: (message) => toasts.push(message)
  });

  const text = await exporter.generate();

  assert.match(text, /PHONE DIALS: 42/);
  assert.equal(copied.length, 1, 'exactly one write to the clipboard');
  assert.equal(copied[0], text);
  assert.match(textOf(host), /Copied/);
  assert.deepEqual(toasts, ['D365 report copied']);

  exporter.destroy();
});

test('a failed counters read reports the failure instead of copying zeros', async () => {
  installDom();
  const host = new FakeElement('div');
  let copyAttempted = false;

  const exporter = await withQuietConsole(async () => mountD365Exporter(host, {
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    copyImpl: async () => { copyAttempted = true; return true; },
    showToastImpl: () => {}
  }));

  const result = await exporter.generate();

  assert.equal(result, null, 'no block is produced from a failed read');
  assert.equal(copyAttempted, false, 'and nothing is put on the clipboard');
  assert.match(textOf(host), /Could not build the report/);

  exporter.destroy();
});

test('when the clipboard is unavailable the block is shown rather than lost', async () => {
  installDom();
  const host = new FakeElement('div');

  const exporter = mountD365Exporter(host, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ date: '2026-09-12', walk_ins: 0, dm_contacts: 0, phone_dials: 3, appointments_set: 0 })
    }),
    copyImpl: async () => false,
    showToastImpl: () => {}
  });

  const text = await exporter.generate();

  assert.match(text, /PHONE DIALS: 3/);
  assert.match(textOf(host), /PHONE DIALS: 3/, 'the block stays selectable on screen');
  assert.match(textOf(host), /Clipboard unavailable/);

  exporter.destroy();
});

// ---------------------------------------------------------------------
// TRIAGE VIEW
// ---------------------------------------------------------------------

test('the triage view lists the low-confidence band and disqualifies on tap', async () => {
  installDom();
  const container = new FakeElement('div');
  const calls = [];

  let current = [
    { company_id: 'low-1', company_name: 'Shady LLC', confidence_score: 12, street_1: '9 Elm St', city: 'Nixa', state: 'MO', company_phone: null },
    { company_id: 'low-2', company_name: 'Barely Real Co', confidence_score: 34, company_phone: '417-555-0009' }
  ];

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });

    if (String(url).includes('/api/leads/disqualify')) {
      current = current.filter((lead) => lead.company_id !== 'low-1');
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: current }) };
  };

  const destroy = mountTriageView(container, { fetchImpl, date: '2026-09-12' });
  await tick(5);

  const text = textOf(container);
  assert.match(text, /2 low-confidence leads/);
  assert.match(text, /Shady LLC/);
  assert.match(text, /12% · no phone/);
  assert.match(text, /Generate D365 Report/, 'the D365 export lives in Triage');
  assert.ok(calls.some((call) => call.url.includes('mode=TRIAGE')), 'the grid reads the TRIAGE band');

  const buttons = container.querySelectorAll('[data-disqualify]');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].getAttribute('data-disqualify'), 'low-1');

  buttons[0].dispatchEvent({ type: 'click' });
  await tick(5);

  const post = calls.find((call) => call.url.includes('/api/leads/disqualify'));
  assert.ok(post, 'the tap posts to the disqualify route');
  assert.equal(JSON.parse(post.init.body).company_id, 'low-1');

  const after = textOf(container);
  assert.ok(!after.includes('Shady LLC'), 'the row leaves the queue on tap');
  assert.match(after, /Barely Real Co/);
  assert.match(after, /1 low-confidence lead/);

  destroy();
  assert.equal(container.children.length, 0, 'teardown releases the container');
});

test('triage with nothing left to clean shows the clear state', async () => {
  installDom();
  const container = new FakeElement('div');

  const destroy = mountTriageView(container, { fetchImpl: leadsFetcher([]) });
  await tick(5);

  assert.match(textOf(container), /Triage is clear/);
  destroy();
});

test('importing without choosing a file says so and uploads nothing', async () => {
  installDom();
  const container = new FakeElement('div');
  const recorded = [];

  const destroy = mountTriageView(container, { fetchImpl: leadsFetcher([], recorded) });
  await tick(5);

  container.querySelectorAll('[data-triage-import]')[0].dispatchEvent({ type: 'click' });
  await tick(5);

  assert.match(textOf(container), /Choose a CSV export first/);
  assert.equal(
    recorded.filter((call) => call.init?.method === 'POST').length,
    0,
    'an empty picker must not post an empty batch'
  );

  destroy();
});

test('an unreachable triage grid degrades to guidance, not a blank panel', async () => {
  installDom();
  const container = new FakeElement('div');

  const destroy = await withQuietConsole(async () => {
    const teardown = mountTriageView(container, {
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); }
    });
    await tick(5);
    return teardown;
  });

  assert.match(textOf(container), /Triage grid unavailable/);
  assert.match(textOf(container), /Generate D365 Report/, 'the export is still offered');

  destroy();
});
