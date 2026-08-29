#!/usr/bin/env node
/**
 * geocode-backfill.js — Low-memory Mapbox Geocoding Backfill for Windows ARM64.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import XLSX from 'xlsx';

let mapboxToken = process.env.MAPBOX_TOKEN;
if (!mapboxToken) {
  try {
    mapboxToken = readFileSync('mapbox_token.txt', 'utf8').trim();
  } catch {
    console.error('❌ MAPBOX_TOKEN not found in environment or mapbox_token.txt');
    process.exit(1);
  }
}

const DEFAULT_FILE = 'All Open Leads (Editable) 8-28-2026 6-56-18 PM.xlsx';
const inputPath = resolve(DEFAULT_FILE);

console.log(`🗺️ Mapbox Geocoding Backfill`);
console.log(`   Source: ${basename(inputPath)}`);

const buf = readFileSync(inputPath);
const wb = XLSX.read(buf, { type: 'buffer' });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
console.log(`   Total records in export: ${rows.length}`);

async function geocodeAddress(addressStr, token) {
  const query = encodeURIComponent(addressStr);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${token}&country=US&types=address,poi`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.features && data.features.length > 0 && Array.isArray(data.features[0].center)) {
      const [long, lat] = data.features[0].center;
      return { lat, long };
    }
    return null;
  } catch {
    return null;
  }
}

async function run() {
  const uniqueAddresses = new Set();
  for (const row of rows) {
    const street = (row['Street 1'] || '').trim();
    const city = (row['City'] || 'Springfield').trim();
    const state = (row['State'] || 'MO').trim();
    const zip = (row['Zip Code'] || '').trim();
    if (street) {
      uniqueAddresses.add(`${street}, ${city}, ${state} ${zip}`.trim());
    }
  }

  const addrList = Array.from(uniqueAddresses);
  console.log(`   Unique addresses to geocode: ${addrList.length}`);

  const cache = new Map();
  // Safe sequential execution to avoid Windows ARM64 emulation Zone memory limits
  for (let i = 0; i < addrList.length; i++) {
    const addr = addrList[i];
    const coords = await geocodeAddress(addr, mapboxToken);
    if (coords) cache.set(addr, coords);
    if (i % 20 === 0 || i === addrList.length - 1) {
      console.log(`   Progress: ${i + 1} / ${addrList.length} addresses`);
    }
  }

  console.log(`\n   Cached geocode results: ${cache.size}`);

  const updates = [];
  let successful = 0;
  let skipped = 0;

  for (const row of rows) {
    const leadId = row['(Do Not Modify) Lead'];
    const street = (row['Street 1'] || '').trim();
    const city = (row['City'] || 'Springfield').trim();
    const state = (row['State'] || 'MO').trim();
    const zip = (row['Zip Code'] || '').trim();
    if (!leadId || !street) {
      skipped++;
      continue;
    }
    const addressKey = `${street}, ${city}, ${state} ${zip}`.trim();
    const coords = cache.get(addressKey);
    if (coords && coords.lat && coords.long) {
      const sql = `UPDATE companies SET lat = ${coords.lat.toFixed(6)}, long = ${coords.long.toFixed(6)} WHERE d365_lead_id = '${leadId.replace(/'/g, "''")}';`;
      updates.push(sql);
      successful++;
    } else {
      skipped++;
    }
  }

  writeFileSync('geocode-updates.sql', updates.join('\n'), 'utf8');

  const CHUNK_SIZE = 250;
  const chunkFiles = [];
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    const filename = `geocode-chunk-${Math.floor(i / CHUNK_SIZE) + 1}.sql`;
    writeFileSync(filename, chunk.join('\n'), 'utf8');
    chunkFiles.push(filename);
  }

  console.log(`✅ Geocoding backfill complete!`);
  console.log(`   Companies with coordinates: ${successful}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Generated chunks: ${chunkFiles.join(', ')}`);
}

run().catch(console.error);
