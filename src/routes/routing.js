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

/**
 * Expected Premium Value (EPV) industry risk multipliers for B2B prospecting.
 * High-margin voluntary benefit risk verticals receive 1.5x - 2.0x multipliers.
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
  const trimmed = industry.trim();
  if (INDUSTRY_MULTIPLIERS[trimmed]) return INDUSTRY_MULTIPLIERS[trimmed];
  const lower = trimmed.toLowerCase();
  if (lower.includes('construct') || lower.includes('trade') || lower.includes('roof')) return 2.0;
  if (lower.includes('manufactur') || lower.includes('tool') || lower.includes('die') || lower.includes('metal') || lower.includes('fab')) return 1.8;
  if (lower.includes('transport') || lower.includes('logistic') || lower.includes('warehous') || lower.includes('truck')) return 1.7;
  if (lower.includes('health') || lower.includes('medic') || lower.includes('dental') || lower.includes('veterin')) return 1.6;
  if (lower.includes('auto') || lower.includes('dealer') || lower.includes('body shop') || lower.includes('repair')) return 1.5;
  if (lower.includes('agri') || lower.includes('forest') || lower.includes('mining')) return 1.5;
  if (lower.includes('hospit') || lower.includes('food') || lower.includes('wholesale') || lower.includes('distrib') || lower.includes('util')) return 1.3;
  if (lower.includes('real estate') || lower.includes('retail') || lower.includes('personal') || lower.includes('entertain')) return 1.1;
  return 1.0;
}

export function calculateEpv(target, distanceMiles) {
  let count;
  if (target?.employees !== null && target?.employees !== undefined && Number(target.employees) > 0) {
    count = Math.max(Number(target.employees), 3);
  } else if (target?.estimated_w2_count !== null && target?.estimated_w2_count !== undefined && Number(target.estimated_w2_count) > 0) {
    count = Math.max(Number(target.estimated_w2_count), 3);
  } else if (target && ('employees' in target || 'estimated_w2_count' in target)) {
    count = 3;
  } else {
    // Default fallback when neither property was provided on target
    count = 5;
  }
  const mult = getIndustryMultiplier(target?.industry);
  const dist = (distanceMiles !== null && distanceMiles !== undefined && Number.isFinite(distanceMiles))
    ? distanceMiles
    : 1.0;
  const score = (count * mult) / (dist + 0.5);
  return Math.round(score * 10) / 10;
}

export function buildIndustryHook(industry) {
  const mult = getIndustryMultiplier(industry);
  if (mult >= 2.0) return 'Section 125 FICA Tax Offset for Construction & High-Risk Trades';
  if (mult >= 1.8) return 'Section 125 FICA Tax Offset for Fabrication & Manufacturing';
  if (mult >= 1.7) return 'Section 125 FICA Tax Offset for Transport & Warehousing';
  if (mult >= 1.6) return 'Section 125 FICA Tax Offset for Healthcare & Clinical Staff';
  if (mult >= 1.5) return 'Section 125 FICA Tax Offset for Auto Dealerships & Technicians';
  return `Section 125 FICA Tax Offset for ${industry || 'Commercial Businesses'}`;
}

/** Great-circle distance in miles. */
export function haversineMiles(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.long - a.long);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

export const tourLength = (stops) => stops.reduce(
  (total, stop, i) => (i === 0 ? 0 : total + haversineMiles(stops[i - 1], stop)),
  0
);

/**
 * Nearest neighbour from the fixed start, then 2-opt until no improving
 * segment reversal remains. Index 0 is pinned — it is where the agent is
 * standing right now.
 */
export function heuristicSequence(stops) {
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
  const userEmail = c.get('userEmail') || 'sean_deardorff@us.aflac.com';
  if (!userEmail) return c.json({ error: 'Unauthorized' }, 401);

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

  const isAutonomous = companyIds.length === 0 && (!Array.isArray(body?.stops) || body.stops.length === 0);

  if (isAutonomous) {
    const startLat = asLatitude(body?.start?.lat) ?? 37.2089;
    const startLong = asLongitude(body?.start?.long ?? body?.start?.lng) ?? -93.2923;
    const startPoint = { lat: startLat, long: startLong };

    const radiusRaw = Number(body?.radius_miles);
    const radiusMiles = Number.isFinite(radiusRaw) && radiusRaw > 0 ? Math.min(Math.max(radiusRaw, 0.1), 15.0) : 5.0;

    const limitRaw = Number(body?.limit);
    const stopLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 30) : 25;

    const industryFilter = typeof body?.industry === 'string' && body.industry.trim() ? body.industry.trim() : null;

    let query = `
      SELECT company_id, company_name, street_1, city, state, zip_code, lat, long, 
             COALESCE(employees, estimated_w2_count, 3) AS employees,
             estimated_w2_count, industry, pipeline_stage, decision_maker, company_phone
      FROM companies 
      WHERE agent_email = ? 
        AND status = 'ACTIVE' 
        AND lat IS NOT NULL AND long IS NOT NULL 
        AND pipeline_stage NOT IN ('DISQUALIFIED', 'CLOSED_LOST', 'CLOSED_WON')
    `;
    const binds = [userEmail];

    if (industryFilter) {
      query += ` AND industry LIKE ?`;
      binds.push(`%${industryFilter}%`);
    }

    const { results } = await c.env.DB.prepare(query).bind(...binds).all();
    const candidates = Array.isArray(results) ? results : [];

    const scored = [];
    for (const cand of candidates) {
      if (!Number.isFinite(cand.lat) || !Number.isFinite(cand.long)) continue;
      const dist = haversineMiles(startPoint, { lat: cand.lat, long: cand.long });
      if (dist <= radiusMiles) {
        const epv = calculateEpv(cand, dist);
        scored.push({
          ...cand,
          employees: Number(cand.employees || cand.estimated_w2_count || 3),
          dist_from_start: dist,
          epv_score: epv
        });
      }
    }

    scored.sort((a, b) => b.epv_score - a.epv_score);
    const topStops = scored.slice(0, stopLimit);

    if (topStops.length === 0) {
      return c.json({
        success: true,
        total_stops: 0,
        total_estimated_miles: 0,
        cumulative_epv: 0,
        ordered_stops: [],
        sequence: [],
        distance_miles: 0,
        duration_minutes: 0,
        provider: 'autonomous-epv'
      });
    }

    const waypoints = [
      { company_id: null, company_name: 'Current position', lat: startLat, long: startLong },
      ...topStops
    ];

    const ordered = heuristicSequence(waypoints);
    const ordered_stops = [];
    let total_estimated_miles = 0;
    let cumulative_epv = 0;

    for (let i = 1; i < ordered.length; i++) {
      const s = ordered[i];
      const leg = Math.round(haversineMiles(ordered[i - 1], s) * 10) / 10;
      total_estimated_miles += leg;
      cumulative_epv += s.epv_score;
      const addr = [s.street_1, s.city, s.state, s.zip_code].filter(Boolean).join(', ') || s.street_1 || '';

      ordered_stops.push({
        sequence_rank: i,
        company_id: s.company_id,
        company_name: s.company_name,
        address: addr,
        employees: Number(s.employees || s.estimated_w2_count || 3),
        epv_score: s.epv_score,
        leg_miles: leg,
        industry_hook: buildIndustryHook(s.industry),
        lat: s.lat,
        long: s.long
      });
    }

    total_estimated_miles = Math.round(total_estimated_miles * 10) / 10;
    cumulative_epv = Math.round(cumulative_epv * 10) / 10;

    return c.json({
      success: true,
      total_stops: ordered_stops.length,
      total_estimated_miles,
      cumulative_epv,
      ordered_stops,
      sequence: ordered.map((stop, i) => ({ ...stop, order: i })),
      distance_miles: total_estimated_miles,
      duration_minutes: Math.round((total_estimated_miles / 28) * 60),
      provider: 'autonomous-epv'
    });
  }

  if (companyIds.length > 0) {
    const placeholders = companyIds.map(() => '?').join(', ');
    const { results } = await c.env.DB.prepare(`
      SELECT company_id, company_name, street_1, city, state, zip_code, lat, long, 
             COALESCE(employees, estimated_w2_count, 3) AS employees,
             estimated_w2_count, industry
      FROM companies
      WHERE company_id IN (${placeholders}) AND lat IS NOT NULL AND long IS NOT NULL AND agent_email = ?
    `).bind(...companyIds, userEmail).all();
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
      long: asLongitude(s?.long ?? s?.lng),
      employees: Number(s?.employees || s?.estimated_w2_count || 3),
      industry: cleanCapped(s?.industry, LIMITS.industry)
    }));
  }

  // A stop without coordinates cannot be routed. Report it rather than
  // silently dropping it — the agent needs to know to geocode it.
  const unroutable = stops.filter((s) => s.lat === null || s.long === null || s.lat === undefined || s.long === undefined);
  stops = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.long));

  if (stops.length === 0) {
    return c.json({ error: 'No stops with coordinates to route', unroutable }, 400);
  }

  // Auto-truncate stops exceeding LIMITS.routeStops (30) by prioritizing high EPV targets
  if (stops.length > LIMITS.routeStops) {
    stops.sort((a, b) => {
      const epvA = calculateEpv(a, 1.0);
      const epvB = calculateEpv(b, 1.0);
      return epvB - epvA;
    });
    stops = stops.slice(0, LIMITS.routeStops);
  }

  const startLat = asLatitude(body?.start?.lat);
  const startLong = asLongitude(body?.start?.long ?? body?.start?.lng);
  const hasStart = startLat !== null && startLong !== null;

  const waypoints = hasStart
    ? [{ company_id: null, company_name: 'Current position', lat: startLat, long: startLong }, ...stops]
    : stops;

  if (waypoints.length < 2) {
    const singleLeg = 0;
    const singleEpv = stops[0] ? calculateEpv(stops[0], 1.0) : 0;
    const singleAddr = stops[0] ? [stops[0].street_1, stops[0].city, stops[0].state, stops[0].zip_code].filter(Boolean).join(', ') : '';
    const singleOrdered = stops[0] ? [{
      sequence_rank: 1,
      company_id: stops[0].company_id,
      company_name: stops[0].company_name,
      address: singleAddr,
      employees: Number(stops[0].employees || stops[0].estimated_w2_count || 3),
      epv_score: singleEpv,
      leg_miles: 0,
      industry_hook: buildIndustryHook(stops[0].industry),
      lat: stops[0].lat,
      long: stops[0].long
    }] : [];

    return c.json({
      success: true,
      provider: 'single-stop',
      total_stops: singleOrdered.length,
      total_estimated_miles: 0,
      cumulative_epv: singleEpv,
      ordered_stops: singleOrdered,
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
  const ordered_stops = [];
  let cumulative_epv = 0;

  const startIndex = hasStart ? 1 : 0;
  for (let i = startIndex; i < ordered.length; i++) {
    const s = ordered[i];
    const prev = i > 0 ? ordered[i - 1] : ordered[0];
    const leg = Math.round(haversineMiles(prev, s) * 10) / 10;
    const epv = calculateEpv(s, leg);
    cumulative_epv += epv;
    const addr = [s.street_1, s.city, s.state, s.zip_code].filter(Boolean).join(', ') || s.street_1 || '';

    ordered_stops.push({
      sequence_rank: hasStart ? i : i + 1,
      company_id: s.company_id,
      company_name: s.company_name,
      address: addr,
      employees: Number(s.employees || s.estimated_w2_count || 3),
      epv_score: epv,
      leg_miles: leg,
      industry_hook: buildIndustryHook(s.industry),
      lat: s.lat,
      long: s.long
    });
  }

  const roundedMiles = Math.round(miles * 10) / 10;
  return c.json({
    success: true,
    provider: c.env.MAPBOX_TOKEN ? 'heuristic-fallback' : 'heuristic',
    total_stops: ordered_stops.length,
    total_estimated_miles: roundedMiles,
    cumulative_epv: Math.round(cumulative_epv * 10) / 10,
    ordered_stops,
    sequence: ordered.map((stop, i) => ({ ...stop, order: i })),
    distance_miles: roundedMiles,
    duration_minutes: Math.round((roundedMiles / 28) * 60),
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
