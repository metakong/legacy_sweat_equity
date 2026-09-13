/**
 * Radar Scan — nearby accounts from D1 by indexed Geohash cell.
 *
 * This route used to call the public OpenStreetMap Overpass API and return
 * points of interest that were not in the CRM at all. That meant a field
 * agent standing on a doorstep was shown a list of strangers while the
 * accounts she already owned and had not yet closed sat in D1 unseen.
 *
 * It now answers a different question: "which of MY accounts are within a
 * short walk of here?" Companies store a seven-character Geohash, and the
 * lookup binds the target's six-character cell plus its eight neighbouring
 * cells, so the WHERE clause is served by `idx_companies_agent_geohash6`
 * with no table scan and no outbound network call.
 *
 * The remaining distance work happens in memory over at most 50 rows, which
 * is exact (Haversine) rather than approximate, and free at that size.
 */

import { Hono } from 'hono';
import { asLatitude, asLongitude } from '../lib/validate.js';
import { getGeohashQueryCells } from '../lib/geo.js';

/** IUGG mean Earth radius, in metres. */
const EARTH_RADIUS_METERS = 6371008.8;
const METERS_PER_MILE = 1609.344;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

/** Cell size for the lookup. Six characters is roughly a 1.2 km x 0.6 km box. */
const QUERY_CELL_PRECISION = 6;

const RADAR_SQL = `
  SELECT
    company_id                      AS id,
    company_name                    AS name,
    street_1                        AS address,
    city                            AS city,
    state                           AS state,
    zip_code                        AS zip,
    company_phone                   AS phone,
    NULL                            AS website,
    lat                             AS latitude,
    long                            AS longitude,
    geohash                         AS geohash,
    pipeline_stage                  AS pipeline_stage,
    status                          AS status,
    current_voluntary_carrier       AS current_voluntary_carrier,
    major_medical_carrier           AS major_medical_carrier,
    is_hdhp                         AS is_hdhp,
    estimated_w2_count              AS estimated_w2_count,
    confidence_score                AS confidence_score,
    COALESCE(d365_modified_on, created_at) AS updated_at
  FROM companies
  WHERE agent_email = ?
    AND SUBSTR(geohash, 1, 6) IN (?, ?, ?, ?, ?, ?, ?, ?, ?)
    AND status NOT IN ('DISQUALIFIED', 'DO_NOT_CONTACT')
  LIMIT ?
`;

/**
 * Great-circle distance in metres.
 *
 * Clamps the haversine intermediate to 1: floating-point error on near-zero
 * distances and on antipodal pairs can push it a hair outside [0, 1], and
 * Math.asin(Math.sqrt(x)) then returns NaN for the one doorstep that is exact.
 */
export function haversineDistanceMeters(sourceLatitude, sourceLongitude, targetLatitude, targetLongitude) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;

  const dLat = toRadians(targetLatitude - sourceLatitude);
  const dLon = toRadians(targetLongitude - sourceLongitude);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(sourceLatitude)) *
      Math.cos(toRadians(targetLatitude)) *
      Math.sin(dLon / 2) ** 2;

  const clamped = Math.min(1, Math.max(0, a));
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(clamped));
}

/**
 * Coerce the `limit` query parameter.
 *
 * Absent, non-numeric and non-positive values fall back to the default rather
 * than erroring: a malformed limit is not a reason to refuse to show the agent
 * the accounts standing next to her. Anything above the ceiling is capped,
 * because the ceiling is what bounds the in-memory sort.
 */
export function normalizeRadarLimit(raw) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Place one D1 row in the radar payload.
 *
 * Returns null for a row without usable coordinates: such an account cannot be
 * ordered or walked to, and a 0,0 pin in the Gulf of Guinea is worse than no
 * pin at all.
 */
function toRadarResult(row, originLatitude, originLongitude) {
  const latitude = asLatitude(row?.latitude);
  const longitude = asLongitude(row?.longitude);
  if (latitude === null || longitude === null) return null;

  const distanceMeters = haversineDistanceMeters(originLatitude, originLongitude, latitude, longitude);

  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    phone: row.phone,
    website: row.website,
    latitude,
    longitude,
    geohash: row.geohash,
    pipeline_stage: row.pipeline_stage,
    status: row.status,
    current_voluntary_carrier: row.current_voluntary_carrier,
    major_medical_carrier: row.major_medical_carrier,
    is_hdhp: row.is_hdhp,
    estimated_w2_count: row.estimated_w2_count,
    confidence_score: row.confidence_score,
    updated_at: row.updated_at,
    distance_meters: distanceMeters,
    distance_miles: distanceMeters / METERS_PER_MILE,
    // Canonical aliases so the field PWA can select, enrich and log against a
    // stored account without needing a translation layer.
    company_id: row.id,
    company_name: row.name,
    street_1: row.address,
    zip_code: row.zip,
    company_phone: row.phone,
    lat: latitude,
    lng: longitude
  };
}

/**
 * GET /api/radar?lat=&lng=&limit=
 *
 * One indexed D1 read, then an exact in-memory distance sort. No outbound
 * network call, so a scan works from a truck with one bar of signal.
 */
export async function handleRadar(c) {
  const userEmail = c.get('userEmail');
  if (!userEmail) return c.json({ error: 'Unauthorized' }, 401);

  const url = new URL(c.req.url);
  const latRaw = url.searchParams.get('lat');
  const lngRaw = url.searchParams.get('lng') ?? url.searchParams.get('long');

  // asLatitude/asLongitude treat null and '' as unknown rather than as 0, so a
  // missing or empty parameter is a 400 instead of the Gulf of Guinea.
  const lat = asLatitude(latRaw);
  const lng = asLongitude(lngRaw);

  if (lat === null || lng === null) {
    return c.json({ error: 'Valid lat and lng query parameters are required' }, 400);
  }

  const limit = normalizeRadarLimit(url.searchParams.get('limit'));
  const cells = getGeohashQueryCells(lat, lng, QUERY_CELL_PRECISION);

  const { results } = await c.env.DB
    .prepare(RADAR_SQL)
    .bind(userEmail, ...cells, limit)
    .all();

  const rows = Array.isArray(results) ? results : [];

  const data = rows
    .map((row) => toRadarResult(row, lat, lng))
    .filter(Boolean)
    .sort((a, b) => a.distance_meters - b.distance_meters || String(a.id).localeCompare(String(b.id)));

  return c.json({ success: true, count: data.length, data }, 200, { 'Cache-Control': 'no-store' });
}

const radar = new Hono();
radar.get('/', handleRadar);

export default radar;
