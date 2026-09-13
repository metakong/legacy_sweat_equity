/**
 * Mock OAuth 2.0 Provider for Gemini Spark Custom Connected Apps
 *
 * Gemini Spark requires a standard OAuth 2.0 authorization-code flow to
 * connect. This module implements a minimal "dummy" provider that issues
 * the Worker's MCP_SECRET_KEY as the Bearer token, so the existing MCP
 * endpoint auth check (`Authorization: Bearer <MCP_SECRET_KEY>`) works
 * without any changes.
 *
 * Routes (mounted under /api/oauth):
 *   GET  /authorize  — redirects with a mock auth code
 *   POST /token      — exchanges the code for an access token
 */

import { Hono } from 'hono';

const oauthRouter = new Hono();

/**
 * GET /authorize
 *
 * Accepts standard OAuth query parameters and immediately redirects to the
 * provided redirect_uri with a mock authorization code and the original state.
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
 * POST /token
 *
 * Accepts URL-encoded form data or JSON. Validates client_secret against
 * the Worker's MCP_SECRET_KEY and issues the key itself as the access_token.
 */
oauthRouter.post('/token', async (c) => {
  let body;
  const ct = (c.req.header('Content-Type') || '').toLowerCase();

  if (ct.includes('application/x-www-form-urlencoded')) {
    body = await c.req.parseBody();
  } else {
    // Assume JSON
    body = await c.req.json();
  }

  const clientSecret = body.client_secret;
  const secretKey = c.env?.MCP_SECRET_KEY;

  if (!secretKey || clientSecret !== secretKey) {
    return c.json({ error: 'invalid_client', error_description: 'client_secret does not match' }, 401);
  }

  return c.json({
    access_token: secretKey,
    token_type: 'Bearer',
    expires_in: 31536000
  });
});

export default oauthRouter;
