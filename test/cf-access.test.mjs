import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { accessConfig, accessToken, clearKeyCache, verifyAccessToken } from '../lib/cf-access.mjs';
import { makeDevAccess } from './helpers/dev-access.mjs';

const dev = makeDevAccess();
const fetchImpl = dev.wrapFetch(async () => new Response('no', { status: 404 }));
const check = (token, env = dev.env, now) => verifyAccessToken(token, { env, fetchImpl, now });

beforeEach(() => clearKeyCache());

test('a good token from the team for an allowed email passes', async () => {
  assert.deepEqual(await check(dev.sign()), { ok: true, email: dev.email });
});

test('email match ignores case; allowlist may hold several', async () => {
  const env = { ...dev.env, CF_ACCESS_ALLOWED_EMAILS: 'other@example.test, SOMEONE@example.test' };
  assert.equal((await check(dev.sign({ email: 'Someone@Example.test' }), env)).ok, true);
});

test('fails closed when any setting is missing or the team is not a cloudflareaccess.com address', async () => {
  for (const k of Object.keys(dev.env)) {
    const env = { ...dev.env, [k]: '' };
    assert.equal((await check(dev.sign(), env)).ok, false, k);
  }
  assert.equal(accessConfig({ ...dev.env, CF_ACCESS_TEAM_DOMAIN: 'evil.example.com' }), null);
});

test('refuses: wrong email, wrong audience, wrong issuer, expired, not yet valid', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    email: dev.sign({ email: 'intruder@example.test' }),
    noEmail: dev.sign({ email: '' }),
    aud: dev.sign({ aud: ['someone-elses-app'] }),
    iss: dev.sign({ iss: 'https://other.cloudflareaccess.com' }),
    exp: dev.sign({ exp: now - 3600 }),
    nbf: dev.sign({ nbf: now + 3600 }),
  };
  for (const [name, token] of Object.entries(cases)) assert.equal((await check(token)).ok, false, name);
});

test('refuses a token signed by another key, even with the right key id', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal((await check(dev.sign({}, { key: privateKey }))).ok, false);
  assert.equal((await check(dev.sign({}, { keyId: 'unknown' }))).ok, false);
});

test('refuses tampered claims, alg=none and junk', async () => {
  const [h, , s] = dev.sign().split('.');
  const body = Buffer.from(JSON.stringify({ iss: `https://${dev.team}`, aud: [dev.aud], email: dev.email, exp: 9999999999 })).toString('base64url');
  const none = Buffer.from(JSON.stringify({ alg: 'none', kid: dev.kid })).toString('base64url');
  for (const token of [`${h}.${body}.${s}`, `${none}.${body}.`, 'a.b.c', 'garbage', '', undefined]) {
    assert.equal((await check(token)).ok, false, String(token));
  }
});

test('a certs download failure refuses with a reason', async () => {
  const r = await verifyAccessToken(dev.sign(), { env: dev.env, fetchImpl: async () => new Response('x', { status: 500 }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 500/);
});

test('the token is read from the header first, then the CF_Authorization cookie', () => {
  const req = (headers) => new Request('https://x.test', { headers });
  assert.equal(accessToken(req({ 'cf-access-jwt-assertion': 'from-header', cookie: 'CF_Authorization=from-cookie' })), 'from-header');
  assert.equal(accessToken(req({ cookie: 'a=1; CF_Authorization=from-cookie' })), 'from-cookie');
  assert.equal(accessToken(req({})), undefined);
});
