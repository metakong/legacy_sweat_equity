/**
 * Tests for Mock OAuth 2.0 Provider (/api/oauth)
 *
 * Verifies the dummy authorization-code flow that Gemini Spark's
 * Custom Connected Apps requires to connect to the MCP endpoint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { app } from '../src/index.js';

const call = (env, url, init) =>
  app.fetch(new Request(`http://localhost${url}`, init), env, { waitUntil() {} });

// ---------------------------------------------------------------------
// GET /api/oauth/authorize
// ---------------------------------------------------------------------

test('GET /api/oauth/authorize returns 302 redirect with code and state', async () => {
  const env = { MCP_SECRET_KEY: 'test_key_123' };

  const res = await call(env, '/api/oauth/authorize?client_id=gemini&redirect_uri=https://example.com/callback&state=xyz789', {
    redirect: 'manual'
  });

  assert.equal(res.status, 302);

  const location = res.headers.get('Location');
  assert.ok(location, 'Location header must be present');

  const redirectUrl = new URL(location);
  assert.equal(redirectUrl.origin, 'https://example.com');
  assert.equal(redirectUrl.pathname, '/callback');
  assert.equal(redirectUrl.searchParams.get('code'), 'mock_auth_code');
  assert.equal(redirectUrl.searchParams.get('state'), 'xyz789');
});

test('GET /api/oauth/authorize omits state when not provided', async () => {
  const env = { MCP_SECRET_KEY: 'test_key_123' };

  const res = await call(env, '/api/oauth/authorize?client_id=gemini&redirect_uri=https://example.com/callback', {
    redirect: 'manual'
  });

  assert.equal(res.status, 302);

  const location = res.headers.get('Location');
  const redirectUrl = new URL(location);
  assert.equal(redirectUrl.searchParams.get('code'), 'mock_auth_code');
  assert.equal(redirectUrl.searchParams.has('state'), false);
});

test('GET /api/oauth/authorize returns 400 when redirect_uri is missing', async () => {
  const env = { MCP_SECRET_KEY: 'test_key_123' };

  const res = await call(env, '/api/oauth/authorize?client_id=gemini');
  assert.equal(res.status, 400);

  const body = await res.json();
  assert.equal(body.error, 'redirect_uri is required');
});

// ---------------------------------------------------------------------
// POST /api/oauth/token
// ---------------------------------------------------------------------

test('POST /api/oauth/token rejects invalid client_secret with 401', async () => {
  const env = { MCP_SECRET_KEY: 'real_secret' };

  const res = await call(env, '/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'gemini',
      client_secret: 'wrong_secret',
      code: 'mock_auth_code',
      grant_type: 'authorization_code'
    })
  });

  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'invalid_client');
});

test('POST /api/oauth/token rejects when MCP_SECRET_KEY is not configured', async () => {
  const env = {};

  const res = await call(env, '/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'gemini',
      client_secret: 'anything',
      code: 'mock_auth_code',
      grant_type: 'authorization_code'
    })
  });

  assert.equal(res.status, 401);
});

test('POST /api/oauth/token issues valid token when client_secret matches (JSON body)', async () => {
  const env = { MCP_SECRET_KEY: 'real_secret' };

  const res = await call(env, '/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'gemini',
      client_secret: 'real_secret',
      code: 'mock_auth_code',
      grant_type: 'authorization_code'
    })
  });

  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.access_token, 'real_secret');
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.expires_in, 31536000);
});

test('POST /api/oauth/token issues valid token when client_secret matches (form-encoded body)', async () => {
  const env = { MCP_SECRET_KEY: 'form_secret' };

  const res = await call(env, '/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'gemini',
      client_secret: 'form_secret',
      code: 'mock_auth_code',
      grant_type: 'authorization_code'
    }).toString()
  });

  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.access_token, 'form_secret');
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.expires_in, 31536000);
});
