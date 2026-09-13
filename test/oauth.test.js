/**
 * Tests for Mock OAuth 2.0 Provider & Discovery Server (/api/oauth, /.well-known)
 * Standards: RFC 8414 (Auth Server Metadata), RFC 9728 (Protected Resource), RFC 7591 (Dynamic Client Registration)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { app } from '../src/index.js';

const call = (env, url, init) =>
  app.fetch(new Request(`http://localhost${url}`, init), env, { waitUntil() {} });

// ---------------------------------------------------------------------
// RFC 8414 & RFC 9728 DISCOVERY ENDPOINTS
// ---------------------------------------------------------------------

test('GET /.well-known/oauth-authorization-server returns correct RFC 8414 metadata', async () => {
  const res = await call({}, '/.well-known/oauth-authorization-server');
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.issuer, 'https://legacysweatequity.com');
  assert.equal(json.authorization_endpoint, 'https://legacysweatequity.com/api/oauth/authorize');
  assert.equal(json.token_endpoint, 'https://legacysweatequity.com/api/oauth/token');
  assert.equal(json.registration_endpoint, 'https://legacysweatequity.com/api/oauth/register');
  assert.deepEqual(json.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(json.response_types_supported, ['code']);
  assert.deepEqual(json.code_challenge_methods_supported, ['S256', 'plain']);
});

test('GET /.well-known/openid-configuration is an alias for oauth-authorization-server', async () => {
  const res = await call({}, '/.well-known/openid-configuration');
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.issuer, 'https://legacysweatequity.com');
  assert.equal(json.authorization_endpoint, 'https://legacysweatequity.com/api/oauth/authorize');
  assert.equal(json.token_endpoint, 'https://legacysweatequity.com/api/oauth/token');
  assert.equal(json.registration_endpoint, 'https://legacysweatequity.com/api/oauth/register');
});

test('GET /.well-known/oauth-protected-resource returns correct RFC 9728 metadata', async () => {
  const res = await call({}, '/.well-known/oauth-protected-resource');
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.resource, 'https://legacysweatequity.com/api/mcp');
  assert.deepEqual(json.authorization_servers, ['https://legacysweatequity.com']);
});

// ---------------------------------------------------------------------
// RFC 7591 DYNAMIC CLIENT REGISTRATION (DCR)
// ---------------------------------------------------------------------

test('POST /api/oauth/register returns registered client profile (201 Created)', async () => {
  const res = await call({}, '/api/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Gemini Spark',
      redirect_uris: ['https://example.com/callback']
    })
  });

  assert.equal(res.status, 201);

  const json = await res.json();
  assert.equal(json.client_id, 'gemini_spark_dynamic_client');
  assert.equal(json.client_secret, 'dynamic_secret');
  assert.equal(json.client_id_issued_at, 1726230000);
  assert.deepEqual(json.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(json.response_types, ['code']);
});

// ---------------------------------------------------------------------
// GET /api/oauth/authorize
// ---------------------------------------------------------------------

test('GET /api/oauth/authorize returns 302 redirect with code and state', async () => {
  const env = { MCP_SECRET_KEY: 'test_key_123' };

  const res = await call(env, '/api/oauth/authorize?client_id=gemini&redirect_uri=https://example.com/callback&state=xyz789&code_challenge=challenge_123', {
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

test('POST /api/oauth/token rejects when MCP_SECRET_KEY is not configured', async () => {
  const env = {};

  const res = await call(env, '/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: 'mock_auth_code'
    })
  });

  assert.equal(res.status, 401);
});

test('POST /api/oauth/token issues valid token payload containing MCP_SECRET_KEY & refresh_token', async () => {
  const env = { MCP_SECRET_KEY: 'real_secret_key' };

  const res = await call(env, '/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: 'mock_auth_code',
      client_id: 'gemini_spark_dynamic_client',
      client_secret: 'dynamic_secret'
    })
  });

  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.access_token, 'real_secret_key');
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.expires_in, 31536000);
  assert.equal(body.refresh_token, 'mock_refresh_token');
});
