import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import mcp from '../api/mcp.mjs';

// Throwaway values made fresh for each run; nothing real.
const fresh = () => randomBytes(16).toString('hex');
const TOKEN = fresh();
const ENV = { METERBOARD_MCP_TOKEN: TOKEN, METERBOARD_SOURCE: 'http', METERBOARD_HTTP_URL: 'https://read.example.test/hook', METERBOARD_HTTP_KEY: fresh() };
// A minimal valid read API answer.
const answer = () => ({ ok: true, from: '2026-11-01', to: '2026-11-16', accounts: [], rows: [], totals: { invoice: { tokens_in: 1, tokens_out: 1, cost_usd: 2, by_account: [], by_model: [] }, estimate: { tokens_in: 3, tokens_out: 3, cost_usd: 0, by_account: [], by_model: [] } }, limits: [] });
const realFetch = globalThis.fetch;
let upstream;

beforeEach(() => {
  Object.assign(process.env, ENV);
  upstream = { calls: [], answer: answer() };
  globalThis.fetch = async (url, init) => { upstream.calls.push({ url, init }); return Response.json(upstream.answer); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const post = (body, headers = { authorization: `Bearer ${TOKEN}` }) =>
  mcp.fetch(new Request('https://usage.example.test/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('no token answers 401 and nothing reaches the data source', async () => {
  const r = await post(rpc('tools/list'), {});
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), 'Bearer');
  assert.equal(upstream.calls.length, 0);
});

test('a wrong token answers 401 before any tool runs', async () => {
  const r = await post(rpc('tools/call', { name: 'usage_query', arguments: { from: '2026-11-01', to: '2026-11-02' } }), { authorization: `Bearer ${fresh()}` });
  assert.equal(r.status, 401);
  assert.equal(upstream.calls.length, 0);
});

test('an unset or empty METERBOARD_MCP_TOKEN refuses everyone, even an empty bearer', async () => {
  for (const value of [undefined, '']) {
    if (value === undefined) delete process.env.METERBOARD_MCP_TOKEN; else process.env.METERBOARD_MCP_TOKEN = value;
    for (const authorization of [`Bearer ${TOKEN}`, 'Bearer ', 'Bearer']) {
      assert.equal((await post(rpc('tools/list'), { authorization })).status, 401);
    }
  }
  assert.equal(upstream.calls.length, 0);
});

test('GET and DELETE answer 405 with Allow: POST', async () => {
  for (const method of ['GET', 'DELETE']) {
    const r = await mcp.fetch(new Request('https://usage.example.test/api/mcp', { method, headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST');
  }
});

test('initialize returns protocolVersion, tools capability and serverInfo as JSON', async () => {
  const r = await post(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  const { result, id, jsonrpc } = await r.json();
  assert.equal(jsonrpc, '2.0'); assert.equal(id, 1);
  assert.equal(result.protocolVersion, '2025-06-18');   // echoes a version it supports
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.serverInfo.name, 'meterboard');
});

test('initialize with an unknown version answers with one this server supports', async () => {
  const { result } = await (await post(rpc('initialize', { protocolVersion: '1999-01-01' }))).json();
  assert.equal(result.protocolVersion, '2025-11-25');
});

test('notifications/initialized answers 202 with no body', async () => {
  const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(r.status, 202);
  assert.equal(await r.text(), '');
});

test('ping answers an empty result', async () => {
  assert.deepEqual((await (await post(rpc('ping'))).json()).result, {});
});

test('tools/list lists exactly 2 tools, each with an input schema', async () => {
  const { result } = await (await post(rpc('tools/list'))).json();
  assert.deepEqual(result.tools.map((t) => t.name), ['usage_summary', 'usage_query']);
  for (const t of result.tools) assert.equal(t.inputSchema.type, 'object');
  assert.ok(result.tools[0].outputSchema);
});

test('tools/call usage_summary runs against the faked read API', async () => {
  const { result } = await (await post(rpc('tools/call', { name: 'usage_summary', arguments: { period: 'last_7_days' } }))).json();
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].init.headers['x-meterboard-key'], ENV.METERBOARD_HTTP_KEY);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.structuredContent.period, 'last_7_days');
  assert.ok(!result.isError);
});

test('tools/call usage_query runs against the faked read API', async () => {
  const { result } = await (await post(rpc('tools/call', { name: 'usage_query', arguments: { from: '2026-11-01', to: '2026-11-16', account_id: 'acct-05' } }))).json();
  assert.deepEqual(JSON.parse(upstream.calls[0].init.body), { from: '2026-11-01', to: '2026-11-16', account_id: 'acct-05' });
  assert.equal(result.structuredContent.ok, true);
});

test('ok:false from the data source arrives as isError:true, not a protocol error', async () => {
  upstream.answer = { ok: false, reason: 'from must be a real date' };
  const body = await (await post(rpc('tools/call', { name: 'usage_query', arguments: { from: '2026-02-31', to: '2026-03-02' } }))).json();
  assert.equal(body.error, undefined);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /from must be a real date/);
});

test('an unknown tool is -32602; bad tool arguments are a tool error the model can read', async () => {
  assert.equal((await (await post(rpc('tools/call', { name: 'nope' }))).json()).error.code, -32602);
  assert.equal((await (await post(rpc('tools/call', { name: 'usage_query', arguments: [] }))).json()).error.code, -32602);
  const bad = await (await post(rpc('tools/call', { name: 'usage_query', arguments: { from: 'x' } }))).json();
  assert.equal(bad.error, undefined);
  assert.equal(bad.result.isError, true);
});

test('an unknown method answers -32601', async () => {
  const body = await (await post(rpc('resources/list'))).json();
  assert.equal(body.error.code, -32601);
  assert.equal(body.id, 1);
});

test('bad JSON answers -32700', async () => {
  const r = await post('{not json');
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, -32700);
});

test('a batch and a non-JSON-RPC body answer -32600', async () => {
  assert.equal((await (await post([rpc('ping')])).json()).error.code, -32600);
  assert.equal((await (await post({ hello: 1 })).json()).error.code, -32600);
});

test('MCP-Protocol-Version: unsupported answers 400, supported or absent answers 200, initialize negotiates in its body', async () => {
  const withVersion = (version, body) => post(body, { authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': version });
  assert.equal((await withVersion('2099-01-01', rpc('tools/list'))).status, 400);
  assert.equal((await withVersion('2025-06-18', rpc('tools/list'))).status, 200);
  assert.equal((await post(rpc('tools/list'))).status, 200);
  assert.equal((await withVersion('2099-01-01', rpc('initialize', { protocolVersion: '2025-11-25' }))).status, 200);
  assert.equal(upstream.calls.length, 0);
});

test('an unknown data source is a tool error in plain words, not an internal error', async () => {
  process.env.METERBOARD_SOURCE = 'postgres';
  const r = await (await post(rpc('tools/call', { name: 'usage_summary', arguments: {} }))).json();
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Unknown data source "postgres"/);
});
