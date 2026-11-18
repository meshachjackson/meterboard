import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpSource, readUsage } from '../lib/sources/http.mjs';

const KEY = 'test-key-not-real';
const URL_ = 'https://read.example.test/usage';

function fakeFetch(answer, { status = 200, json = true } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(json ? JSON.stringify(answer) : 'not json', { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('readUsage sends the key header and the body to the given URL', async () => {
  const fetch = fakeFetch({ ok: true });
  const query = { from: '2026-11-01', to: '2026-11-16', agent_id: 'agent-helper' };
  await readUsage(query, { fetch, url: URL_, key: KEY });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, URL_);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-meterboard-key'], KEY);
  assert.deepEqual(JSON.parse(init.body), query);
});

test('the key header name is a setting, and httpSource passes everything through', async () => {
  const fetch = fakeFetch({ ok: true });
  const source = httpSource({ url: URL_, key: KEY, header: 'x-custom-key', fetch });
  assert.equal(source.name, 'http');
  await source.read({ from: '2026-11-01', to: '2026-11-01' });
  assert.equal(fetch.calls[0].url, URL_);
  assert.equal(fetch.calls[0].init.headers['x-custom-key'], KEY);
});

test('readUsage returns an ok:false answer as is', async () => {
  const answer = { ok: false, reason: 'from is after to' };
  assert.deepEqual(await readUsage({}, { fetch: fakeFetch(answer), url: URL_, key: KEY }), answer);
});

test('readUsage refuses to call without a URL or key', async () => {
  await assert.rejects(readUsage({}, { fetch: fakeFetch({}), url: '', key: KEY }), /METERBOARD_HTTP_URL/);
  await assert.rejects(readUsage({}, { fetch: fakeFetch({}), url: URL_, key: '' }), /METERBOARD_HTTP_KEY/);
});

test('readUsage errors are plain and never hold the URL or key', async () => {
  const failing = async () => { throw new Error(`connect failed to ${URL_} with ${KEY}`); };
  for (const [fetch, pattern] of [[failing, /did not answer/], [fakeFetch({}, { status: 500 }), /HTTP 500/], [fakeFetch({}, { json: false }), /not JSON/]]) {
    const error = await readUsage({}, { fetch, url: URL_, key: KEY }).catch((e) => e);
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(KEY) && !error.message.includes(URL_));
  }
});
