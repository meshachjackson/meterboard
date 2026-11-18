// Auth mode selection (lib/auth.mjs) and what the API answers in each mode.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authMode, bearerMatches, checkRequest } from '../lib/auth.mjs';
import { clearKeyCache } from '../lib/cf-access.mjs';
import { loadConfig, pageSettings } from '../lib/config.mjs';
import { usageHandler } from '../lib/handlers.mjs';
import { makeDevAccess } from './helpers/dev-access.mjs';

const req = (headers = {}, query = 'from=2026-11-01&to=2026-11-16') => new Request(`https://usage.example.test/api/usage?${query}`, { headers });
const TOKEN = 'token-for-tests-only-not-real';

test('no mode set: the sample data needs no sign-in, real data refuses everyone', () => {
  assert.deepEqual(authMode(loadConfig({})), { mode: 'none' });
  const real = authMode(loadConfig({ METERBOARD_SOURCE: 'http' }));
  assert.equal(real.mode, null);
  assert.match(real.problem, /METERBOARD_AUTH/);
});

test('each named mode is chosen as set; an unknown one refuses everyone', () => {
  for (const mode of ['cloudflare-access', 'token', 'none']) assert.equal(authMode(loadConfig({ METERBOARD_AUTH: mode, METERBOARD_SOURCE: 'http' })).mode, mode);
  assert.equal(authMode(loadConfig({ METERBOARD_AUTH: 'CLOUDFLARE-ACCESS' })).mode, 'cloudflare-access', 'case does not matter');
  const bad = authMode(loadConfig({ METERBOARD_AUTH: 'open' }));
  assert.equal(bad.mode, null);
  assert.match(bad.problem, /must be one of/);
});

test('token mode: the right bearer gets in, a wrong or missing one does not, an unset token refuses all', async () => {
  const config = loadConfig({ METERBOARD_AUTH: 'token', METERBOARD_TOKEN: TOKEN, METERBOARD_SOURCE: 'http' });
  assert.equal((await checkRequest(req({ authorization: `Bearer ${TOKEN}` }), config)).ok, true);
  assert.equal((await checkRequest(req({ authorization: 'Bearer nope' }), config)).ok, false);
  assert.equal((await checkRequest(req(), config)).ok, false);
  const unset = await checkRequest(req({ authorization: 'Bearer ' }), loadConfig({ METERBOARD_AUTH: 'token' }));
  assert.equal(unset.ok, false);
  assert.equal(unset.setup, true);
  assert.equal(bearerMatches(req({ authorization: `Bearer ${TOKEN}` }), ''), false);
});

test('none mode with real data lets requests in and warns once', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const config = loadConfig({ METERBOARD_AUTH: 'none', METERBOARD_SOURCE: 'http' });
  assert.equal((await checkRequest(req(), config)).ok, true);
  await checkRequest(req(), config);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /WARNING/);
});

test('cloudflare-access mode checks the Access token', async () => {
  const access = makeDevAccess();
  clearKeyCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = access.wrapFetch(realFetch);
  try {
    const options = { env: access.env, fetchImpl: globalThis.fetch };
    const config = loadConfig({ METERBOARD_AUTH: 'cloudflare-access' });
    assert.equal((await checkRequest(req({ 'cf-access-jwt-assertion': access.sign() }), config, options)).ok, true);
    assert.equal((await checkRequest(req(), config, options)).ok, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the API answers 503 when sign-in is not set up, and never calls the source', async () => {
  let called = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called += 1; return Response.json({ ok: true }); };
  try {
    const handler = usageHandler({ settings: () => loadConfig({ METERBOARD_SOURCE: 'http', METERBOARD_HTTP_URL: 'https://x.example.test', METERBOARD_HTTP_KEY: 'k' }) });
    const response = await handler.fetch(req());
    assert.equal(response.status, 503);
    assert.match((await response.json()).reason, /METERBOARD_AUTH/);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('with no settings, the API serves the sample data with no sign-in', async () => {
  const handler = usageHandler({ settings: () => loadConfig({}) });
  const body = await (await handler.fetch(req({}, `from=${new Date().toISOString().slice(0, 8)}01&to=${new Date().toISOString().slice(0, 10)}`))).json();
  assert.equal(body.ok, true);
  assert.ok(body.rows.length > 0);
});

test('token mode: the API answers 401 without the token and 200 with it', async () => {
  const handler = usageHandler({ settings: () => loadConfig({ METERBOARD_AUTH: 'token', METERBOARD_TOKEN: TOKEN }) });
  assert.equal((await handler.fetch(req())).status, 401);
  assert.equal((await handler.fetch(req({ authorization: `Bearer ${TOKEN}` }))).status, 200);
});

test('?config before sign-in holds only the sign-in fields', async () => {
  const handler = usageHandler({ settings: () => loadConfig({ METERBOARD_AUTH: 'token', METERBOARD_TOKEN: TOKEN, METERBOARD_TIME_ZONE: 'Europe/Berlin' }) });
  const body = await (await handler.fetch(req({}, 'config'))).json();
  assert.deepEqual(Object.keys(body).sort(), ['auth', 'signInText', 'signOutUrl', 'title']);
  assert.equal(body.auth, 'token');
});

test('?config once signed in holds the display settings and no secret or address', async () => {
  const env = {
    METERBOARD_AUTH: 'token', METERBOARD_TOKEN: TOKEN, METERBOARD_MCP_TOKEN: 'mcp-secret-for-tests',
    METERBOARD_SOURCE: 'http', METERBOARD_HTTP_URL: 'https://hidden.example.test/usage', METERBOARD_HTTP_KEY: 'http-secret-for-tests', METERBOARD_HTTP_KEY_HEADER: 'x-hidden-header',
    METERBOARD_TIME_ZONE: 'Europe/Berlin', METERBOARD_TIME_ZONE_LABEL: 'Berlin time',
  };
  const handler = usageHandler({ settings: () => loadConfig(env) });
  const response = await handler.fetch(req({ authorization: `Bearer ${TOKEN}` }, 'config'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['auth', 'limits', 'signInText', 'signOutUrl', 'timeZone', 'timeZoneLabel', 'title']);
  assert.equal(body.auth, 'token');
  assert.equal(body.timeZoneLabel, 'Berlin time');
  const text = JSON.stringify(body);
  for (const secret of [TOKEN, 'mcp-secret-for-tests', 'hidden.example.test', 'http-secret-for-tests', 'x-hidden-header']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(pageSettings(loadConfig(env)), body);
});

test('cloudflare-access mode sends people to the Access sign-out by default; others have none', () => {
  assert.equal(loadConfig({ METERBOARD_AUTH: 'cloudflare-access' }).signOutUrl, '/cdn-cgi/access/logout');
  assert.equal(loadConfig({ METERBOARD_AUTH: 'token' }).signOutUrl, '');
});

test('settings passed as defaults are used, and env wins over them', () => {
  const defaults = { source: 'http', auth: 'cloudflare-access', httpKeyHeader: 'x-instance', timeZone: 'Asia/Tokyo', limits: { a: { label: 'A' } } };
  const c = loadConfig({}, defaults);
  assert.equal(c.source, 'http');
  assert.equal(c.http.header, 'x-instance');
  assert.equal(c.timeZoneLabel, 'Asia/Tokyo');
  assert.deepEqual(c.limits, { a: { label: 'A' } });
  assert.equal(loadConfig({ METERBOARD_TIME_ZONE: 'UTC' }, defaults).timeZone, 'UTC');
  assert.deepEqual(loadConfig({ METERBOARD_LIMITS: '{"b":{"label":"B"}}' }, defaults).limits, { b: { label: 'B' } });
});
