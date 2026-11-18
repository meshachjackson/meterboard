import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_LIMITS } from '../lib/sources/fixture.mjs';
import { ROW_CAP, TOOLS, usageQuery, usageSummary } from '../lib/usage-tools.mjs';

// Shared fake read API answer for the MCP tests. Invented numbers. One account and one agent appear in BOTH sources,
// with distinctive figures, so a test can catch any code that adds invoice and estimate together.
const answer = (over = {}) => ({
  ok: true, from: '2026-11-01', to: '2026-11-16',
  accounts: [{ account_id: 'acct-05', provider: 'anthropic', plan: 'max', monthly_fee: 100 }, { account_id: 'acct-06', provider: 'openai', plan: '', monthly_fee: '' }],
  rows: [
    { usage_date: '2026-11-15', account_id: 'acct-05', agent_id: 'agent-helper', model: 'm-a', tokens_in: 1000, tokens_out: 100, cost_usd: 12.5, source: 'invoice' },
    { usage_date: '2026-11-15', account_id: 'acct-05', agent_id: 'agent-helper', model: 'm-a', tokens_in: 70000, tokens_out: 7000, cost_usd: '', source: 'estimate' },
  ],
  totals: {
    invoice: { tokens_in: 1000, tokens_out: 100, cost_usd: 12.5, by_account: [{ account_id: 'acct-05', tokens_in: 1000, tokens_out: 100, cost_usd: 12.5 }], by_model: [{ account_id: 'acct-05', model: 'm-a', tokens_in: 1000, tokens_out: 100, cost_usd: 12.5 }] },
    estimate: { tokens_in: 70000, tokens_out: 7000, cost_usd: 0, by_account: [{ account_id: 'acct-05', tokens_in: 70000, tokens_out: 7000, cost_usd: 0 }], by_model: [{ account_id: 'acct-05', model: 'm-a', tokens_in: 70000, tokens_out: 7000, cost_usd: 0 }] },
  },
  limits: [
    { account_id: 'acct-02', usage_date: '2026-11-16', source: 'invoice', name: 'cloud_month_to_date_usd', used: 17, total: 20, pct: 85, level: 'warn' },
    { account_id: 'acct-01', usage_date: '2026-11-16', source: 'estimate', name: 'workflow_runs_month', used: 3000, total: 10000, pct: 30, level: 'ok' },
  ],
  ...over,
});

const fake = (a = answer()) => { const calls = []; return { calls, read: async (q) => { calls.push(q); return typeof a === 'function' ? a(q) : a; } }; };

test('usage_summary text and structuredContent keep invoice and estimate apart, with no sum', async () => {
  const { read, calls } = fake();
  const r = await usageSummary({}, { read, now: new Date('2026-11-16T18:00:00Z') });
  assert.deepEqual(calls, [{ from: '2026-11-01', to: '2026-11-16' }]);
  const s = r.structuredContent;
  assert.deepEqual(s.invoice, { tokens_in: 1000, tokens_out: 100, cost_usd: 12.5 });
  assert.deepEqual(s.estimate, { tokens_in: 70000, tokens_out: 7000, cost_usd: null });   // no price recorded, not $0.00
  const text = r.content[0].text, lines = text.split('\n');
  assert.ok(lines.some((l) => l.startsWith('From bills (invoice)') && l.includes('$12.50')));
  assert.ok(lines.some((l) => l.startsWith('Our own count (estimate)') && l.includes('No price recorded')));
  assert.match(text, /not added together/);
  // No number equals invoice + estimate for any field, in the text or in the JSON.
  const all = text + JSON.stringify(s);
  for (const sum of ['71,000', '71000', '7,100', '7100', '71K', '7.1K']) assert.ok(!all.includes(sum), `found a summed figure ${sum}`);
  assert.match(text, /70,000 in/);
});

test('usage_summary lists top 5 per source and only limits at or past 80%', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ account_id: `acct-${i}`, tokens_in: 100 * (i + 1), tokens_out: 0, cost_usd: 0 }));
  const a = answer(); a.totals.invoice.by_account = many;
  const r = await usageSummary({ period: 'this_month' }, { read: fake(a).read, now: new Date('2026-11-16T18:00:00Z'), settings: { timeZone: 'UTC', limits: FIXTURE_LIMITS } });
  assert.equal(r.structuredContent.top_accounts.invoice.length, 5);
  assert.match(r.structuredContent.top_accounts.invoice[0].name, /^acct-7/);
  assert.deepEqual(r.structuredContent.limits_at_or_past_80, [{ name: 'cloud_month_to_date_usd', label: 'Cloud host spend this month', pct: 85 }]);
  assert.match(r.content[0].text, /Cloud host spend this month: 85%/);
  assert.doesNotMatch(r.content[0].text, /n8n runs this month: 30/);
});

test('usage_summary structuredContent matches its outputSchema keys and types', async () => {
  const schema = TOOLS.find((t) => t.name === 'usage_summary').outputSchema;
  const s = (await usageSummary({}, { read: fake().read, now: new Date('2026-11-16T18:00:00Z') })).structuredContent;
  for (const key of schema.required) assert.ok(key in s, `missing ${key}`);
  assert.deepEqual(Object.keys(s).sort(), Object.keys(schema.properties).sort());
  for (const src of ['invoice', 'estimate']) for (const k of ['tokens_in', 'tokens_out', 'cost_usd']) assert.ok(k in s[src]);
});

test('usage_summary period dates follow the settings time zone at a month boundary', async () => {
  // A zone six hours behind UTC all year.
  const settings = { timeZone: 'America/Mexico_City', limits: {} };
  const run = async (iso, period) => { const { read, calls } = fake(); await usageSummary({ period }, { read, now: new Date(iso), settings }); return calls[0]; };
  // 12/1/2026 00:30 local = 06:30 UTC
  assert.deepEqual(await run('2026-12-01T06:30:00Z', 'this_month'), { from: '2026-12-01', to: '2026-12-01' });
  assert.deepEqual(await run('2026-12-01T06:30:00Z', 'last_month'), { from: '2026-11-01', to: '2026-11-30' });
  // 11/30/2026 23:30 local = 12/1 05:30 UTC: still November there
  assert.deepEqual(await run('2026-12-01T05:30:00Z', 'this_month'), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(await run('2026-12-01T05:30:00Z', 'last_7_days'), { from: '2026-11-24', to: '2026-11-30' });
  // January: last month is December of the year before
  assert.deepEqual(await run('2027-01-01T07:00:00Z', 'last_month'), { from: '2026-12-01', to: '2026-12-31' });
});

test('usage_summary text shows American dates', async () => {
  const r = await usageSummary({ period: 'last_month' }, { read: fake().read, now: new Date('2026-12-01T06:30:00Z') });
  assert.match(r.content[0].text, /11\/1\/2026 to 11\/30\/2026/);
});

test('usage_summary answers a bad period as a tool error, without calling the data source', async () => {
  const { read, calls } = fake();
  for (const period of ['forever', 'toString', 5]) {
    const r = await usageSummary({ period }, { read });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /period must be one of: this_month, last_month, last_7_days/);
  }
  assert.equal(calls.length, 0);
});

test('usage_summary adds no figure when both sources are priced: 12.50 + 3.25 never shows as 15.75', async () => {
  const a = answer();
  a.rows[1].cost_usd = 3.25; a.totals.estimate.cost_usd = 3.25;
  const r = await usageSummary({}, { read: fake(a).read, now: new Date('2026-11-16T18:00:00Z') });
  assert.equal(r.structuredContent.invoice.cost_usd, 12.5);
  assert.equal(r.structuredContent.estimate.cost_usd, 3.25);
  assert.ok(!(r.content[0].text + JSON.stringify(r.structuredContent)).includes('15.75'));
  assert.match(r.content[0].text, /\$12\.50/); assert.match(r.content[0].text, /\$3\.25/);
});

test('usage_query passes filters through and returns totals and limits in full', async () => {
  const { read, calls } = fake();
  const r = await usageQuery({ from: '2026-11-01', to: '2026-11-16', provider: 'anthropic', agent_id: 'agent-helper' }, { read });
  assert.deepEqual(calls, [{ from: '2026-11-01', to: '2026-11-16', provider: 'anthropic', agent_id: 'agent-helper' }]);
  assert.deepEqual(r.structuredContent.totals, answer().totals);
  assert.deepEqual(r.structuredContent.limits, answer().limits);
  assert.equal(r.structuredContent.rows_cut, false);
  assert.ok(!r.isError);
});

test('usage_query caps rows at 200 and says so', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ usage_date: '2026-11-01', n: i }));
  const r = await usageQuery({ from: '2026-11-01', to: '2026-11-16' }, { read: fake(answer({ rows })).read });
  assert.equal(r.structuredContent.rows.length, ROW_CAP);
  assert.equal(r.structuredContent.rows_total, 250);
  assert.equal(r.structuredContent.rows_cut, true);
  assert.match(r.structuredContent.note, /first 200 of 250/);
  assert.match(r.content[0].text, /first 200 of 250/);
});

test('ok:false from the data source becomes a tool error in plain words, for both tools', async () => {
  const bad = { ok: false, reason: 'range is longer than 93 days' };
  const q = await usageQuery({ from: '2026-01-01', to: '2026-11-16' }, { read: fake(bad).read });
  assert.equal(q.isError, true);
  assert.match(q.content[0].text, /range is longer than 93 days/);
  const s = await usageSummary({}, { read: fake(bad).read, now: new Date() });
  assert.equal(s.isError, true);
});

test('a data source failure becomes a tool error', async () => {
  const q = await usageQuery({ from: '2026-11-01', to: '2026-11-02' }, { read: async () => { throw new Error('The usage API did not answer.'); } });
  assert.equal(q.isError, true);
  assert.match(q.content[0].text, /did not answer/);
});

test('usage_query answers bad arguments as tool errors, without calling the data source', async () => {
  const { read, calls } = fake();
  for (const args of [{ from: '11/1/2026', to: '2026-11-02' }, { from: '2026-11-01' }, { from: '2026-11-01', to: '2026-11-02', provider: 5 }]) {
    const r = await usageQuery(args, { read });
    assert.equal(r.isError, true);
    assert.ok(r.content[0].text.length > 10);
  }
  assert.equal(calls.length, 0);
});
