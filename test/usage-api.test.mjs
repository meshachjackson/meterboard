import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { clearKeyCache } from '../lib/cf-access.mjs';
import { makeDevAccess } from './helpers/dev-access.mjs';
import usage from '../api/usage.mjs';

// Throwaway values made fresh for each run; nothing real.
const fresh = () => randomBytes(16).toString('hex');
const access = makeDevAccess();
const ENV = { ...access.env, METERBOARD_AUTH: 'cloudflare-access', METERBOARD_SOURCE: 'http', METERBOARD_HTTP_URL: 'https://read.example.test/hook', METERBOARD_HTTP_KEY: fresh() };
const realFetch = globalThis.fetch;
let upstream;

beforeEach(() => {
  clearKeyCache();
  Object.assign(process.env, ENV);
  upstream = { calls: [], answer: { ok: true, from: '2026-11-01', to: '2026-11-16', accounts: [], rows: [], totals: {}, limits: [] } };
  globalThis.fetch = access.wrapFetch(async (url, init) => { upstream.calls.push({ url, init }); return Response.json(upstream.answer); });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const get = (query, token) => usage.fetch(new Request(`https://usage.example.test/api/usage?${query}`, { headers: token ? { 'cf-access-jwt-assertion': token } : {} }));

test('GET /api/usage without an Access token answers 401 and does not call the data source', async () => {
  const response = await get('from=2026-11-01&to=2026-11-16');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(upstream.calls.length, 0);
});

test('a token for another email, an expired token or a forged one answers 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const token of [access.sign({ email: 'intruder@example.test' }), access.sign({ exp: now - 600 }), 'a.b.c']) {
    assert.equal((await get('from=2026-11-01&to=2026-11-16', token)).status, 401);
  }
  assert.equal(upstream.calls.length, 0);
});

test('with Access settings unset, everyone is refused', async () => {
  delete process.env.CF_ACCESS_AUD;
  assert.equal((await get('from=2026-11-01&to=2026-11-16', access.sign())).status, 401);
});

test('signed-in GET forwards only the five query keys, with the key header, to the data source URL', async () => {
  const response = await get('from=2026-11-01&to=2026-11-16&agent_id=agent-helper&evil=1', access.sign());
  assert.equal(response.status, 200);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].url, ENV.METERBOARD_HTTP_URL);
  assert.equal(upstream.calls[0].init.headers['x-meterboard-key'], ENV.METERBOARD_HTTP_KEY);
  assert.deepEqual(JSON.parse(upstream.calls[0].init.body), { from: '2026-11-01', to: '2026-11-16', agent_id: 'agent-helper' });
  const text = await response.text();
  assert.ok(!text.includes(ENV.METERBOARD_HTTP_KEY));
});

test('the API passes ok:false reasons through from the data source', async () => {
  upstream.answer = { ok: false, reason: 'the range is 120 days; the most is 93' };
  const response = await get('from=2026-06-01&to=2026-09-28', access.sign());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), upstream.answer);
});

test('a read API failure answers 502 with a plain reason and no key or URL', async () => {
  globalThis.fetch = access.wrapFetch(async () => new Response('oops', { status: 500 }));
  const response = await get('from=2026-11-01&to=2026-11-16', access.sign());
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.reason, /HTTP 500/);
  assert.ok(!JSON.stringify(body).includes(ENV.METERBOARD_HTTP_KEY) && !JSON.stringify(body).includes(ENV.METERBOARD_HTTP_URL));
});

