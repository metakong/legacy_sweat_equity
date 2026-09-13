/**
 * Mock OAuth 2.0 Provider & Discovery Server for Gemini Spark Custom Connected Apps
 * Standards: RFC 8414 (Auth Server Metadata), RFC 9728 (Protected Resource), RFC 7591 (Dynamic Client Registration)
 *
 * Provides endpoints for Gemini Spark automated discovery, dynamic client registration,
 * authorization code redirection, and token issuance.
 */

import { Hono } from 'hono';

const oauthRouter = new Hono();
const wellKnownRouter = new Hono();

// Metadata constants
const BASE_URL = 'https://legacysweatequity.com';

const AUTH_SERVER_METADATA = {
  issuer: BASE_URL,
  authorization_endpoint: `${BASE_URL}/api/oauth/authorize`,
  token_endpoint: `${BASE_URL}/api/oauth/token`,
  registration_endpoint: `${BASE_URL}/api/oauth/register`,
  grant_types_supported: ['authorization_code', 'refresh_token'],
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256', 'plain']
};

const PROTECTED_RESOURCE_METADATA = {
  resource: `${BASE_URL}/api/mcp`,
  authorization_servers: [BASE_URL]
};

// ---------------------------------------------------------------------
// RFC 8414 & RFC 9728 DISCOVERY ENDPOINTS
// ---------------------------------------------------------------------

wellKnownRouter.get('/oauth-authorization-server', (c) => c.json(AUTH_SERVER_METADATA));
wellKnownRouter.get('/openid-configuration', (c) => c.json(AUTH_SERVER_METADATA));
wellKnownRouter.get('/oauth-protected-resource', (c) => c.json(PROTECTED_RESOURCE_METADATA));

// ---------------------------------------------------------------------
// RFC 7591 DYNAMIC CLIENT REGISTRATION (DCR)
// ---------------------------------------------------------------------

oauthRouter.post('/register', async (c) => {
  return c.json({
    client_id: 'gemini_spark_dynamic_client',
    client_secret: 'dynamic_secret',
    client_id_issued_at: 1726230000,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  }, 201);
});

// ---------------------------------------------------------------------
// OAUTH AUTHORIZE & TOKEN ENDPOINTS
// ---------------------------------------------------------------------

/**
 * GET /api/oauth/authorize
 * Accepts standard OAuth query parameters and immediately redirects to redirect_uri.
 */
oauthRouter.get('/authorize', (c) => {
  const redirectUri = c.req.query('redirect_uri');
  const state = c.req.query('state') || '';

  if (!redirectUri) {
    return c.json({ error: 'redirect_uri is required' }, 400);
  }

  const url = new URL(redirectUri);
  url.searchParams.set('code', 'mock_auth_code');
  if (state) url.searchParams.set('state', state);

  return c.redirect(url.toString(), 302);
});

/**
 * Constant-time string comparison preventing timing attacks.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  const maxLen = Math.max(aBuf.byteLength, bBuf.byteLength);
  let diff = aBuf.byteLength ^ bBuf.byteLength;
  for (let i = 0; i < maxLen; i++) {
    const aByte = i < aBuf.byteLength ? aBuf[i] : 0;
    const bByte = i < bBuf.byteLength ? bBuf[i] : 0;
    diff |= aByte ^ bByte;
  }
  return diff === 0;
}

/**
 * POST /api/oauth/token
 * Returns access_token containing c.env.MCP_SECRET_KEY after validating client credentials.
 */
oauthRouter.post('/token', async (c) => {
  let clientId = null;
  let clientSecret = null;

  // 1. Check Authorization header: Basic <base64(client_id:client_secret)>
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const base64 = authHeader.slice(6).trim();
      const decoded = typeof atob === 'function'
        ? atob(base64)
        : Buffer.from(base64, 'base64').toString('utf-8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        clientId = decoded.slice(0, colonIdx);
        clientSecret = decoded.slice(colonIdx + 1);
      }
    } catch {
      // Malformed header
    }
  }

  // 2. Check request body (JSON or form-urlencoded)
  if (!clientId || !clientSecret) {
    try {
      const contentType = c.req.header('Content-Type') || '';
      let body = {};
      if (contentType.includes('application/json')) {
        body = await c.req.json();
      } else {
        body = await c.req.parseBody();
      }
      if (!clientId && body?.client_id) clientId = String(body.client_id);
      if (!clientSecret && body?.client_secret) clientSecret = String(body.client_secret);
    } catch {
      // Malformed body
    }
  }

  const expectedClientId = c.env?.OAUTH_CLIENT_ID || 'gemini_spark_dynamic_client';
  const expectedClientSecret = c.env?.OAUTH_CLIENT_SECRET || 'dynamic_secret';

  if (!clientId || !clientSecret) {
    return c.json({ error: 'invalid_client', error_description: 'Client credentials missing' }, 401);
  }

  const idMatch = timingSafeEqual(clientId, expectedClientId);
  const secretMatch = timingSafeEqual(clientSecret, expectedClientSecret);

  if (!idMatch || !secretMatch) {
    return c.json({ error: 'invalid_client', error_description: 'Invalid client credentials' }, 401);
  }

  const secretKey = c.env?.MCP_SECRET_KEY;

  if (!secretKey) {
    return c.json({ error: 'invalid_client', error_description: 'MCP_SECRET_KEY is not configured' }, 401);
  }

  return c.json({
    access_token: secretKey,
    token_type: 'Bearer',
    expires_in: 31536000,
    refresh_token: 'mock_refresh_token'
  });
});

export default oauthRouter;
export { wellKnownRouter };
