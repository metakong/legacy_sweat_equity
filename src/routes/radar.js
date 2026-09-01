/**
 * Radar Scan — Discover nearby uncharted B2B targets using OpenStreetMap Overpass API.
 */

import { Hono } from 'hono';
import { asLatitude, asLongitude } from '../lib/validate.js';

export async function handleRadar(c) {
  const url = new URL(c.req.url);
  const latRaw = url.searchParams.get('lat') || c.req.query('lat');
  const lngRaw = url.searchParams.get('lng') || url.searchParams.get('long') || c.req.query('lng') || c.req.query('long');

  const lat = asLatitude(latRaw);
  const lng = asLongitude(lngRaw);

  if (lat === null || lng === null) {
    return c.json({ error: 'Valid lat and lng query parameters are required' }, 400);
  }

  const radius = 500; // 500 meters
  const overpassQuery = `[out:json][timeout:15];(node["amenity"](around:${radius},${lat},${lng});node["shop"](around:${radius},${lat},${lng});node["office"](around:${radius},${lat},${lng});node["craft"](around:${radius},${lat},${lng}););out center;`;

  try {
    const response = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`, {
      headers: {
        'User-Agent': 'AflacFieldProspecting/2.0 (sean_deardorff@us.aflac.com)',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return c.json({ error: `Overpass API responded with status ${response.status}`, results: [] }, 502);
    }

    const data = await response.json().catch(() => ({ elements: [] }));
    const elements = Array.isArray(data?.elements) ? data.elements : [];

    const seen = new Set();
    const results = [];

    for (const el of elements) {
      const name = el.tags?.name?.trim();
      const elLat = el.lat ?? el.center?.lat;
      const elLng = el.lon ?? el.center?.lon;

      if (!name || elLat === undefined || elLat === null || elLng === undefined || elLng === null) {
        continue;
      }

      // Deduplicate by normalized name and rough coordinates
      const key = `${name.toLowerCase()}|${Number(elLat).toFixed(4)}|${Number(elLng).toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        name,
        lat: elLat,
        lng: elLng
      });
    }

    return c.json(results, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    console.error('Radar Overpass query failed:', err);
    return c.json({ error: 'Failed to fetch radar POI data', results: [] }, 502);
  }
}

const radar = new Hono();
radar.get('/', handleRadar);

export default radar;
