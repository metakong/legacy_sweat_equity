/**
 * POST /api/route/optimize — drive-sequence planner for the desktop console.
 *
 * Mapbox's Optimization API solves this properly against real road geometry.
 * When MAPBOX_TOKEN is absent (or Mapbox is down) we fall back to a
 * nearest-neighbour tour improved with 2-opt over great-circle distance. For
 * a dozen stops inside one metro that lands within a few percent of optimal,
 * which is well inside the noise of traffic — so the feature stays usable on
 * a zero-cost setup instead of erroring out.
 *
 * The token is server-side only. It is never sent to the browser.
 */

import { Hono } from 'hono';
import { LIMITS, asId, asLatitude, asLongitude, cleanCapped } from '../lib/validate.js';

const routing = new Hono();

const MAPBOX_OPTIMIZED_TRIPS = 'https://api.mapbox.com/optimized-trips/v1/mapbox/driving';
const EARTH_RADIUS_MI = 3958.8;

/** Great-circle distance in miles. */
function haversineMiles(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.long - a.long);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

const tourLength = (stops) => stops.reduce(
  (total, stop, i) => (i === 0 ? 0 : total + haversineMiles(stops[i - 1], stop)),
  0
);

/**
 * Nearest neighbour from the fixed start, then 2-opt until no improving
 * segment reversal remains. Index 0 is pinned — it is where the agent is
 * standing right now.
 */
function heuristicSequence(stops) {
  if (stops.length <= 2) return stops.slice();

  const remaining = stops.slice(1);
  const ordered = [stops[0]];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let best = 0;
    let bestDistance = Infinity;
    remaining.forEach((stop, i) => {
      const d = haversineMiles(last, stop);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    ordered.push(remaining.splice(best, 1)[0]);
  }

  // 2-opt. Bounded so a pathological input cannot spin the CPU budget away.
  let improved = true;
  let passes = 0;
  while (improved && passes < 40) {
    improved = false;
    passes += 1;
    for (let i = 1; i < ordered.length - 1; i += 1) {
      for (let k = i + 1; k < ordered.length; k += 1) {
        const candidate = [
          ...ordered.slice(0, i),
          ...ordered.slice(i, k + 1).reverse(),
          ...ordered.slice(k + 1)
        ];
        if (tourLength(candidate) < tourLength(ordered) - 1e-9) {
          ordered.splice(0, ordered.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  return ordered;
}

/**
 * Body: {
 *   company_ids: [...],                       // resolved against D1, OR
 *   stops: [{ company_id, company_name, lat, long }],
 *   start: { lat, long }                      // optional current position
 * }
 */
routing.post('/optimize', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  let stops = [];

  const companyIds = Array.isArray(body?.company_ids)
    ? body.company_ids.map(asId).filter(Boolean).slice(0, LIMITS.routeStops)
    : [];

  if (companyIds.length > 0) {
    const placeholders = companyIds.map(() => '?').join(', ');
    const { results } = await c.env.DB.prepare(`
      SELECT company_id, company_name, street_1, city, state, zip_code, lat, long
      FROM companies
      WHERE company_id IN (${placeholders}) AND lat IS NOT NULL AND long IS NOT NULL
    `).bind(...companyIds).all();
    stops = results || [];
  } else if (Array.isArray(body?.stops)) {
    stops = body.stops.slice(0, LIMITS.routeStops).map((s) => ({
      company_id: asId(s?.company_id),
      company_name: cleanCapped(s?.company_name, LIMITS.companyName),
      street_1: cleanCapped(s?.street_1, LIMITS.street),
      city: cleanCapped(s?.city, LIMITS.city),
      state: cleanCapped(s?.state, LIMITS.state),
      zip_code: cleanCapped(s?.zip_code, LIMITS.zip),
      lat: asLatitude(s?.lat),
      long: asLongitude(s?.long ?? s?.lng)
    }));
  }

  // A stop without coordinates cannot be routed. Report it rather than
  // silently dropping it — the agent needs to know to geocode it.
  const unroutable = stops.filter((s) => s.lat === null || s.long === null || s.lat === undefined || s.long === undefined);
  stops = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.long));

  if (stops.length === 0) {
    return c.json({ error: 'No stops with coordinates to route', unroutable }, 400);
  }
  if (stops.length > LIMITS.routeStops) {
    return c.json({ error: `Mapbox Optimization accepts at most ${LIMITS.routeStops} stops` }, 400);
  }

  const startLat = asLatitude(body?.start?.lat);
  const startLong = asLongitude(body?.start?.long ?? body?.start?.lng);
  const hasStart = startLat !== null && startLong !== null;

  const waypoints = hasStart
    ? [{ company_id: null, company_name: 'Current position', lat: startLat, long: startLong }, ...stops]
    : stops;

  if (waypoints.length < 2) {
    return c.json({
      success: true,
      provider: 'single-stop',
      sequence: waypoints.map((stop, i) => ({ ...stop, order: i })),
      distance_miles: 0,
      duration_minutes: 0,
      unroutable
    });
  }

  if (c.env.MAPBOX_TOKEN) {
    try {
      const result = await optimizeWithMapbox(c.env, waypoints);
      return c.json({ ...result, unroutable }, 200, { 'Cache-Control': 'no-store' });
    } catch (err) {
      console.error('Mapbox optimization failed, using local heuristic:', err);
    }
  }

  const ordered = heuristicSequence(waypoints);
  const miles = tourLength(ordered);
  return c.json({
    success: true,
    provider: c.env.MAPBOX_TOKEN ? 'heuristic-fallback' : 'heuristic',
    sequence: ordered.map((stop, i) => ({ ...stop, order: i })),
    distance_miles: Math.round(miles * 10) / 10,
    // Straight-line miles under-report drive time; 28 mph is a realistic
    // door-to-door average for Springfield surface streets with stops.
    duration_minutes: Math.round((miles / 28) * 60),
    note: 'Great-circle estimate. Set MAPBOX_TOKEN for road-network optimization.',
    unroutable
  }, 200, { 'Cache-Control': 'no-store' });
});

async function optimizeWithMapbox(env, waypoints) {
  // Mapbox takes lon,lat — reversing these is the classic silent bug here.
  const coords = waypoints.map((s) => `${s.long},${s.lat}`).join(';');
  const url = new URL(`${MAPBOX_OPTIMIZED_TRIPS}/${coords}`);
  url.searchParams.set('access_token', env.MAPBOX_TOKEN);
  url.searchParams.set('source', 'first');   // start where the agent is
  url.searchParams.set('roundtrip', 'false'); // no need to drive back to stop 1
  url.searchParams.set('destination', 'last');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'simplified');

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Mapbox returned ${res.status}`);

  const data = await res.json();
  if (data?.code !== 'Ok' || !Array.isArray(data?.waypoints)) {
    throw new Error(`Mapbox code ${data?.code}`);
  }

  // waypoint_index is the position in the OPTIMIZED tour; the array itself is
  // still in input order, so sort by it to recover the driving sequence.
  const sequence = data.waypoints
    .map((wp, inputIndex) => ({ ...waypoints[inputIndex], order: wp.waypoint_index }))
    .sort((a, b) => a.order - b.order);

  const trip = data.trips?.[0] || {};
  return {
    success: true,
    provider: 'mapbox',
    sequence,
    distance_miles: Math.round((Number(trip.distance || 0) / 1609.344) * 10) / 10,
    duration_minutes: Math.round(Number(trip.duration || 0) / 60),
    geometry: trip.geometry || null
  };
}

export default routing;
