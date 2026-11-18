// The fixture source: invented sample data, so meterboard runs with no database and no account.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_LIMITS, fixtureSource, sampleData } from '../lib/sources/fixture.mjs';
import { loadConfig } from '../lib/config.mjs';
import { buildDashboard, monthRanges, todayIn } from '../public/usage/view.js';

test('with no settings at all, the config uses the fixture source and its limit labels', () => {
  const config = loadConfig({});
  assert.equal(config.source, 'fixture');
  assert.equal(config.timeZone, 'UTC');
  assert.deepEqual(config.limits, FIXTURE_LIMITS);
});

test('the fixture answers this month by default, dated from today in the given zone', async () => {
  const zone = 'Pacific/Kiritimati'; // UTC+14, so its "today" is often a day ahead of UTC
  const today = todayIn(new Date(), zone);
  const { thisMonth } = monthRanges(today);
  const answer = await fixtureSource({ timeZone: zone }).read(thisMonth);
  assert.equal(answer.ok, true);
  assert.ok(answer.rows.some((r) => r.usage_date.startsWith(today.slice(0, 7))));
});

test('the sample data is invented: ids are generic and no row is in the future', () => {
  const today = '2026-11-16';
  const { accounts, usage } = sampleData(today);
  assert.ok(accounts.every((a) => /^acct-\d\d$/.test(a.account_id)));
  assert.ok(usage.every((r) => !r.agent_id || /^agent-[a-z]+$/.test(r.agent_id)));
  assert.ok(usage.every((r) => r.usage_date <= '2026-11-30'));
});

test('variants: unpriced drops invoice usage and estimate prices; new has no last month', async () => {
  const today = '2026-11-16';
  const { lastMonth, thisMonth } = monthRanges(today);
  const unpriced = await fixtureSource({ today, variant: 'unpriced' }).read(thisMonth);
  assert.ok(unpriced.rows.filter((r) => !r.limit_name).every((r) => r.source === 'estimate' && r.cost_usd === null));
  const fresh = await fixtureSource({ today, variant: 'new' }).read(lastMonth);
  assert.equal(fresh.rows.length, 0);
});

test('the dashboard over the fixture counts hosting readings as dollars', async () => {
  const today = '2026-11-16';
  const { thisMonth } = monthRanges(today);
  const answer = await fixtureSource({ today }).read(thisMonth);
  const dash = buildDashboard(answer, [], today, { timeZone: 'UTC', limits: FIXTURE_LIMITS });
  assert.ok(dash.parts.find((p) => p.key === 'hosting').value > 0);
  const bare = buildDashboard(answer, [], today, { timeZone: 'UTC', limits: {} });
  assert.equal(bare.parts.find((p) => p.key === 'hosting').value, 0, 'no hosting limits named, no hosting dollars');
});
