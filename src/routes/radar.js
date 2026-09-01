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

  const radius = 1609; // 1 mile (1609 meters)
  const overpassQuery = `[out:json][timeout:25];(nwr["amenity"](around:${radius},${lat},${lng});nwr["shop"](around:${radius},${lat},${lng});nwr["office"](around:${radius},${lat},${lng});nwr["craft"](around:${radius},${lat},${lng});nwr["healthcare"](around:${radius},${lat},${lng});nwr["industrial"](around:${radius},${lat},${lng}););out center;`;

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  let data = null;
  let success = false;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${endpoint}?data=${encodeURIComponent(overpassQuery)}`, {
        headers: {
          'User-Agent': 'AflacFieldProspecting/2.0 (sean_deardorff@us.aflac.com)',
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        data = await response.json();
        success = true;
        break; // Success, exit loop
      }
    } catch (err) {
      console.warn(`Overpass endpoint ${endpoint} failed, trying next...`);
    }
  }

  if (!success || !data) {
    return c.json({ error: 'All Overpass API instances failed or timed out', results: [] }, 502);
  }

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

    const street1 = [el.tags?.['addr:housenumber'], el.tags?.['addr:street']].filter(Boolean).join(' ');
    const city = el.tags?.['addr:city'] || '';
    const state = el.tags?.['addr:state'] || '';
    const zip_code = el.tags?.['addr:postcode'] || '';

    results.push({
      name,
      street_1: street1,
      city,
      state,
      zip_code,
      lat: elLat,
      lng: elLng
    });
  }

  return c.json(results, 200, { 'Cache-Control': 'no-store' });
}

const radar = new Hono();
radar.get('/', handleRadar);

export default radar;
