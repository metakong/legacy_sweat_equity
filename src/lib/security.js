/**
 * Response hardening + origin policy for the Aflac field prospecting Worker.
 *
 * Exported (rather than inlined) because dev-server.js serves static files
 * without going through the Worker. A drifting second copy of the CSP means a
 * violation only ever surfaces after deploy.
 */

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Microphone is the core input device now (Samson Q2U on the Book Go, phone
  // mic on the S21+). Camera is off: photo capture was a roofing feature and
  // was removed in the B2B pivot.
  'Permissions-Policy': 'geolocation=(self), microphone=(self), camera=(), interest-cohort=()'
};

/**
 * No inline <script> exists in any page, so script-src stays strict.
 *   unpkg.com       — Leaflet (mobile map + desktop route planner)
 *   cdn.sheetjs.com — SheetJS, desktop-only Tier 2 .xlsx generation
 *   fonts.*         — Outfit
 *   *.tile.osm.org  — raster map tiles
 *   blob:           — MediaRecorder audio preview and generated export files
 *
 * Mapbox is deliberately absent: routing is proxied through
 * /api/route/optimize so the token never reaches the browser.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com https://cdn.sheetjs.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ');

/**
 * Origins permitted to make cross-origin API calls — and to POST at all.
 *
 * NOTE: wrangler.jsonc still routes this Worker at legacysweatequity.com; that
 * file is not modified without explicit permission, so the legacy hostnames
 * stay on the allowlist until the custom domain is repointed. Add a new domain
 * through the ALLOWED_ORIGINS env var (comma separated) rather than editing
 * this list.
 */
export function allowedOrigins(env, url) {
  const configured = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return new Set([
    url.origin, // the Worker's own origin — covers custom domains and previews
    'https://legacysweatequity.com',
    'https://www.legacysweatequity.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    ...configured
  ]);
}

export const isHtmlResponse = (response) =>
  (response.headers.get('Content-Type') || '').includes('text/html');
