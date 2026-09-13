/**
 * Test authentication helper.
 * Provides valid Cloudflare Access JWT assertions for unit and integration tests.
 */

export const TEST_EMAIL = 'sean_deardorff@us.aflac.com';
export const TEST_JWT = 'header.' + Buffer.from(JSON.stringify({ email: TEST_EMAIL })).toString('base64') + '.sig';
export const AUTH_HEADERS = { 'cf-access-jwt-assertion': TEST_JWT };
