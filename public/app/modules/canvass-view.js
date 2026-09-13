/**
 * Agency OS — Field Mode (the canvass route).
 *
 * The field problem is order, not distance: thirty accounts within a few miles
 * of each other is a half-hour of driving if they are sequenced well and two
 * hours if they are not.
 *
 * WHY THE ROUTE IS COMPUTED HERE AND NOT ON THE SERVER
 * Thirty stops is 30! orderings, but the heuristics below are O(n²) and finish
 * in well under a millisecond on a phone. Shipping the array to the edge and
 * back would cost a round trip on a bad connection to save nothing, and the
 * agent can re-order instantly when a stop is skipped.
 *
 * WHY THE ROUTE IS SPLIT INTO BLOCKS
 * Google Maps universal URLs accept at most 10 waypoints. Thirty stops is three
 * blocks of ten — morning, midday, afternoon — which also happens to match how
 * a canvass day is actually run.
 *
 * The map itself is deliberately NOT mounted here: Leaflet comes from a CDN,
 * and a sorted list with one-tap deep links delivers the same driving decision
 * without a third-party dependency on the critical path.
 */

import { el } from '../ui.js';
import { createVoiceWidget } from './voice-widget.js';

export const LEADS_ENDPOINT = '/api/leads';

/** Google's hard ceiling on the `waypoints` parameter. */
export const MAX_WAYPOINTS = 10;

/** Stops per route block. 10 keeps every block inside the waypoint cap. */
export const ROUTE_BLOCK_SIZE = 10;

/** Springfield, MO — the fallback origin when the device has no fix. */
export const DEFAULT_ORIGIN = { lat: 37.2089, long: -93.2923 };

export const BLOCK_LABELS = ['🌅 Morning', '☀️ Midday', '🌇 Afternoon', '🌙 Evening'];

const EARTH_RADIUS_METERS = 6371008.8;

/**
 * True when a lead can actually be driven to.
 *
 * Number(null) is 0, so the obvious Number.isFinite(Number(lat)) check would
 * treat a missing coordinate as the Gulf of Guinea and route the agent there —
 * the same trap that made an ungeocoded account a real map pin in Sprint 1B.
 * D1 returns SQL NULL as null, which is exactly the case that matters.
 */
export function hasCoordinates(stop) {
  const lat = stop?.lat;
  const long = stop?.long;

  if (lat === null || lat === undefined || long === null || long === undefined) return false;
  if (typeof lat === 'string' && lat.trim() === '') return false;
  if (typeof long === 'string' && long.trim() === '') return false;

  return Number.isFinite(Number(lat)) && Number.isFinite(Number(long));
}

function toPoint(value) {
  return { lat: Number(value.lat), long: Number(value.long) };
}

function resolveOrigin(origin) {
  const lat = Number(origin?.lat);
  const long = Number(origin?.long);
  return {
    lat: Number.isFinite(lat) ? lat : DEFAULT_ORIGIN.lat,
    long: Number.isFinite(long) ? long : DEFAULT_ORIGIN.long
  };
}

/** Great-circle metres between two {lat, long} points. */
export function haversineMeters(a, b) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.long - a.long);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** Total drive distance for an ordered route, starting at `origin`. */
export function pathLengthMeters(ordered, origin = DEFAULT_ORIGIN) {
  const stops = Array.isArray(ordered) ? ordered : [];
  let cursor = resolveOrigin(origin);
  let total = 0;

  for (const stop of stops) {
    if (!hasCoordinates(stop)) continue;
    const point = toPoint(stop);
    total += haversineMeters(cursor, point);
    cursor = point;
  }

  return total;
}

/**
 * Nearest-neighbour ordering: from wherever you are, always take the closest
 * stop you have not visited.
 *
 * Leads without coordinates are kept at the end rather than dropped, so the
 * agent still sees them and can geocode them later.
 */
export function orderStopsNearestNeighbor(stops, origin = DEFAULT_ORIGIN) {
  const list = Array.isArray(stops) ? stops : [];
  const remaining = list.filter(hasCoordinates);
  const unroutable = list.filter((stop) => !hasCoordinates(stop));

  const ordered = [];
  let cursor = resolveOrigin(origin);

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Infinity;

    for (let i = 0; i < remaining.length; i += 1) {
      const distance = haversineMeters(cursor, toPoint(remaining[i]));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    cursor = toPoint(next);
  }

  return [...ordered, ...unroutable];
}

/**
 * 2-opt refinement: sweep the route for a pair of edges that get shorter when
 * the segment between them is reversed, and reverse it.
 *
 * Nearest neighbour is greedy and can walk into a dead end — it takes the last
 * house on a cul-de-sac and then drives back out past the one it skipped. 2-opt
 * removes exactly that class of detour, and it is what makes computing the
 * ordering worth doing at all.
 */
export function improveWithTwoOpt(ordered, origin = DEFAULT_ORIGIN, maxPasses = 8) {
  const route = Array.isArray(ordered) ? [...ordered] : [];
  if (route.length < 4) return route;

  const start = resolveOrigin(origin);
  const pointAt = (index) => toPoint(route[index]);

  let improved = true;
  let passes = 0;

  while (improved && passes < maxPasses) {
    improved = false;
    passes += 1;

    for (let i = 0; i < route.length - 1; i += 1) {
      for (let k = i + 1; k < route.length; k += 1) {
        const previous = i === 0 ? start : pointAt(i - 1);
        const first = pointAt(i);
        const last = pointAt(k);
        const next = k + 1 < route.length ? pointAt(k + 1) : null;

        const before = haversineMeters(previous, first) + (next ? haversineMeters(last, next) : 0);
        const after = haversineMeters(previous, last) + (next ? haversineMeters(first, next) : 0);

        if (after + 1e-9 < before) {
          let low = i;
          let high = k;
          while (low < high) {
            const held = route[low];
            route[low] = route[high];
            route[high] = held;
            low += 1;
            high -= 1;
          }
          improved = true;
        }
      }
    }
  }

  return route;
}

/** Nearest neighbour, then 2-opt. This is the ordering the canvass list renders. */
export function orderStopsTwoOpt(stops, origin = DEFAULT_ORIGIN) {
  const ordered = orderStopsNearestNeighbor(stops, origin);
  const routableCount = ordered.filter(hasCoordinates).length;

  return [
    ...improveWithTwoOpt(ordered.slice(0, routableCount), origin),
    ...ordered.slice(routableCount)
  ];
}

/** Chunk an ordered route into drivable blocks. */
export function splitRouteBlocks(ordered, size = ROUTE_BLOCK_SIZE) {
  const stops = Array.isArray(ordered) ? ordered : [];
  const blocks = [];

  for (let i = 0; i < stops.length; i += size) {
    const position = blocks.length;
    blocks.push({
      index: position,
      label: BLOCK_LABELS[position] || `Block ${position + 1}`,
      stops: stops.slice(i, i + size)
    });
  }

  return blocks;
}

function formatPoint(stop) {
  return `${Number(stop.lat).toFixed(6)},${Number(stop.long).toFixed(6)}`;
}

/**
 * Google Maps universal directions URL for one block.
 *
 * The LAST stop is the destination and at most the previous ten are waypoints,
 * which is the only arrangement that fits an 11-stop block inside Google's
 * ten-waypoint ceiling without silently dropping stops.
 *
 * `|` is left literal rather than percent-encoded: Google accepts both, and a
 * readable URL is far easier to debug from a phone's share sheet.
 *
 * @returns {string|null} null when the block holds nothing drivable
 */
export function buildGoogleMapsUrl(stops, { origin = 'Current Location' } = {}) {
  const routable = (Array.isArray(stops) ? stops : []).filter(hasCoordinates);
  if (routable.length === 0) return null;

  const destination = routable[routable.length - 1];
  const waypoints = routable.slice(0, -1).slice(0, MAX_WAYPOINTS);

  const params = [
    'api=1',
    `origin=${encodeURIComponent(origin || 'Current Location')}`,
    `destination=${formatPoint(destination)}`,
    waypoints.length ? `waypoints=${waypoints.map(formatPoint).join('|')}` : null
  ].filter(Boolean);

  return `https://www.google.com/maps/dir/?${params.join('&')}`;
}

/**
 * Section 125 FICA recapture.
 *
 * Conservative (40% participation, $1,500 average annual premium) and baseline
 * (60%, $2,400) are the two figures worth quoting on a doorstep: a number the
 * agent can defend is worth more than a bigger one he cannot.
 */
export function ficaRecaptureEstimates(lives) {
  const count = Number.isFinite(Number(lives)) && Number(lives) > 0 ? Math.floor(Number(lives)) : 0;
  return {
    lives: count,
    conservative: Math.round(count * 0.40 * 1500 * 0.0765),
    baseline: Math.round(count * 0.60 * 2400 * 0.0765)
  };
}

async function requestJson(url, { fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('network unavailable');

  const res = await doFetch(url);
  if (!res || !res.ok) {
    throw new Error(`request failed (${res?.status ?? 'no response'})`);
  }
  return res.json();
}

/**
 * @param {Element} container
 * @param {{fetchImpl?: Function, origin?: {lat: number, long: number}}} [options]
 * @returns {Function} teardown
 */
export function mountCanvassView(container, options = {}) {
  const { fetchImpl, origin } = options;

  let stops = [];
  let blocks = [];
  let destroyed = false;
  let voiceWidget = null;

  const root = el('div', { className: 'canvass-view' });
  const status = el('p', {
    className: 'canvass-status',
    attrs: { role: 'status', 'aria-live': 'polite' }
  });
  const routeHost = el('div', { className: 'canvass-blocks' });
  root.append(status, routeHost);
  container.replaceChildren(root);

  const setStatus = (message) => { status.textContent = message || ''; };

  function renderBlock(block) {
    const list = el('ol', { className: 'canvass-stop-list' });

    for (const stop of block.stops) {
      const fica = ficaRecaptureEstimates(stop.estimated_w2_count);
      const address = [stop.street_1, stop.city, stop.state].filter(Boolean).join(', ');

      const metaBits = [
        stop.current_voluntary_carrier ? `Carrier: ${stop.current_voluntary_carrier}` : 'Carrier: unknown',
        fica.lives ? `${fica.lives} W-2` : null,
        fica.conservative ? `~$${fica.conservative.toLocaleString('en-US')} FICA/yr conservative` : null,
        hasCoordinates(stop) ? null : 'no coordinates — geocode to route'
      ].filter(Boolean);

      list.append(el('li', {
        className: `canvass-stop${hasCoordinates(stop) ? '' : ' canvass-stop-unroutable'}`,
        children: [
          el('span', { className: 'canvass-stop-name', text: stop.company_name || 'Unknown account' }),
          el('span', { className: 'canvass-stop-address', text: address }),
          el('span', { className: 'canvass-stop-meta', text: metaBits.join(' · ') })
        ]
      }));
    }

    const url = buildGoogleMapsUrl(block.stops, { origin: 'Current Location' });
    const launch = el('a', {
      className: url ? 'canvass-launch' : 'canvass-launch canvass-launch-disabled',
      text: `🚗 Launch ${block.label} route (${block.stops.length} stops)`,
      attrs: url
        // target=_blank keeps the PWA alive behind the navigation app; without
        // it, following the link would tear the list down mid-day.
        ? { href: url, target: '_blank', rel: 'noopener noreferrer', 'data-launch-route': String(block.index) }
        : { 'data-launch-route': String(block.index), 'aria-disabled': 'true' }
    });

    const first = block.index * ROUTE_BLOCK_SIZE + 1;
    const last = first + block.stops.length - 1;

    return el('section', {
      className: 'canvass-block',
      children: [
        el('h3', { className: 'canvass-block-title', text: `${block.label} · stops ${first}–${last}` }),
        list,
        launch
      ]
    });
  }

  function render() {
    if (voiceWidget) { voiceWidget.destroy(); voiceWidget = null; }

    if (stops.length === 0) {
      routeHost.replaceChildren(el('div', {
        className: 'agency-empty',
        children: [
          el('h2', { text: 'No canvass targets' }),
          el('p', { text: 'No accounts at 80+ confidence yet. Verify leads on the phone first, or import targets in 📋 Triage.' })
        ]
      }));
      return;
    }

    const miles = (pathLengthMeters(stops, origin) / 1609.344).toFixed(1);

    // A field debrief is written between stops or at the end of the day, so it
    // belongs to the route rather than to one account.
    voiceWidget = createVoiceWidget({
      companyId: null,
      mode: 'FIELD',
      onSaved: () => setStatus('Field debrief queued — transcribes when online.')
    });

    routeHost.replaceChildren(
      el('p', {
        className: 'canvass-summary',
        text: `${stops.length} stops · ${miles} mi planned drive · ${blocks.length} block${blocks.length === 1 ? '' : 's'}`
      }),
      ...blocks.map(renderBlock),
      voiceWidget.element
    );
  }

  async function load() {
    setStatus('Loading today’s canvass route…');
    try {
      const payload = await requestJson(`${LEADS_ENDPOINT}?mode=FIELD`, { fetchImpl });
      const leads = Array.isArray(payload?.data) ? payload.data : [];

      stops = orderStopsTwoOpt(leads, origin);
      blocks = splitRouteBlocks(stops);
      setStatus('');
      render();
    } catch (err) {
      console.error('Agency OS canvass load failed:', err);
      stops = [];
      blocks = [];
      routeHost.replaceChildren(el('div', {
        className: 'agency-empty',
        children: [
          el('h2', { text: 'Route unavailable' }),
          el('p', { text: 'Could not load field leads. Check the connection and reload.' })
        ]
      }));
      setStatus('');
    }
  }

  load();

  return function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (voiceWidget) { voiceWidget.destroy(); voiceWidget = null; }
    root.replaceChildren();
    // The view mounted itself as the container's only child; leaving an empty
    // wrapper behind would accumulate one more per mode switch.
    container.replaceChildren();
  };
}
