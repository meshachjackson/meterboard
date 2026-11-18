import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDashboard, buildView, todayIn, formatDay, formatUsd, meteredSpend, modelTier, monthRanges, priceChecked, priorMonths, PRICE_STALE_DAYS } from '../public/usage/view.js';
import { FIXTURE_LIMITS, fakeReadApi, sampleData } from '../lib/sources/fixture.mjs';

// A zone west of UTC, so day edges are tested. Limits as the fixture labels them.
const TZ = 'America/Denver';
const S = { timeZone: TZ, limits: FIXTURE_LIMITS };
import { apiRateValue, PRICES } from '../public/usage/prices.js';

const today = '2026-11-16';
const data = sampleData(today);
const { thisMonth, lastMonth } = monthRanges(today);
const view = buildView(fakeReadApi(thisMonth, data), fakeReadApi(lastMonth, data), S);

// Every string and number the view shows, walked recursively.
function leaves(value, out = []) {
  if (value && typeof value === 'object') for (const v of Object.values(value)) leaves(v, out);
  else out.push(value);
  return out;
}

test('invoice and estimate stay in separate fields, and no shown value adds them together', () => {
  const answer = fakeReadApi(thisMonth, data);
  const invoice = view.sources.find((s) => s.key === 'invoice');
  const estimate = view.sources.find((s) => s.key === 'estimate');
  assert.deepEqual(view.sources.map((s) => s.key), ['invoice', 'estimate']);
  assert.equal(invoice.thisMonth.cost_usd, answer.totals.invoice.cost_usd);
  assert.equal(estimate.thisMonth.tokens_in, answer.totals.estimate.tokens_in);
  assert.ok(invoice.thisMonth.cost_usd > 0 && estimate.thisMonth.cost_usd > 0, 'the sample has figures on both sides');
  const combined = {
    cost: answer.totals.invoice.cost_usd + answer.totals.estimate.cost_usd,
    tokensIn: answer.totals.invoice.tokens_in + answer.totals.estimate.tokens_in,
    tokensOut: answer.totals.invoice.tokens_out + answer.totals.estimate.tokens_out,
  };
  const shown = leaves(view);
  for (const [name, sum] of Object.entries(combined)) {
    assert.ok(!shown.includes(sum), `${name} sum appears as a number`);
  }
  const money = formatUsd(combined.cost);
  assert.ok(!shown.some((v) => typeof v === 'string' && v.includes(money)), 'combined dollars appear as text');
  assert.ok(!('total' in view) && !('combined' in view) && !('total' in view.subscriptions));
});

test('subscriptions show "not set" for a blank monthly fee and limits carry the 80% warn level', () => {
  const fees = Object.fromEntries(view.subscriptions.rows.map((r) => [r.account_id, r.feeText]));
  assert.equal(fees['acct-01'], 'not set');    // null
  assert.equal(fees['acct-07'], 'not set');    // ""
  assert.equal(fees['acct-09'], '$24.00');
  assert.equal(fees['acct-03'], '$0.00');      // zero is set, not blank

  const byName = Object.fromEntries(view.limits.map((l) => [l.name, l]));
  assert.equal(byName.cloud_month_to_date_usd.warn, true);          // 29.4 of 35 is 84%
  assert.match(byName.cloud_month_to_date_usd.levelText, /past the 80% mark/);
  assert.equal(byName.agent_runner_usd_day.warn, false);        // 2.5%
  assert.equal(byName.web_host_month_to_date_usd.hasLimit, false); // no_limit: no bar, no mark
  assert.equal(byName.web_host_month_to_date_usd.pct, null);
});

test('per-agent figures come from usage rows, split by source, with a blank agent named', () => {
  const estimate = view.sources.find((s) => s.key === 'estimate').agents.map((a) => a.agent_id);
  const invoice = view.sources.find((s) => s.key === 'invoice').agents.map((a) => a.agentText);
  assert.deepEqual(estimate.sort(), ['agent-desk', 'agent-helper']);
  assert.deepEqual(invoice, ['No agent named']);
});

test('dates are American and the month ranges follow the settings time zone', () => {
  assert.equal(formatDay('2026-11-16'), '11/16/2026');
  assert.equal(formatDay('2026-01-05'), '1/5/2026');
  assert.deepEqual(monthRanges('2026-01-09'), { thisMonth: { from: '2026-01-01', to: '2026-01-09' }, lastMonth: { from: '2025-12-01', to: '2025-12-31' } });
  assert.equal(monthRanges('2028-03-02').lastMonth.to, '2028-02-29');
  // 11/17/2026 at 3:00 UTC is still 11/16/2026 in Mountain time.
  assert.equal(todayIn(new Date('2026-11-17T03:00:00Z'), TZ), '2026-11-16');
  assert.equal(view.rangeText, '11/1/2026 to 11/16/2026');
});

test('estimates without a price show "No price recorded", not $0.00', () => {
  const real = sampleData(today, { unpriced: true });
  const v = buildView(fakeReadApi(thisMonth, real), fakeReadApi(lastMonth, real), S);
  const invoice = v.sources.find((s) => s.key === 'invoice');
  const estimate = v.sources.find((s) => s.key === 'estimate');
  assert.equal(estimate.costText, 'No price recorded');
  assert.match(estimate.lastText, /^No price recorded, tokens /);
  assert.ok(estimate.thisMonth.tokens_in > 0);
  assert.ok(estimate.agentRows.every((row) => row[3] === 'no price'));
  assert.ok(estimate.modelRows.every((row) => row[3] === 'no price'));
  assert.equal(invoice.costText, 'No price recorded');
  assert.deepEqual(invoice.agentRows, []);
  // A limit row with no limit still shows what was used, with no bar.
  const spend = v.limits.find((l) => l.name === 'web_host_month_to_date_usd');
  assert.equal(spend.hasLimit, false);
  assert.equal(spend.usedText, '$0.00');
});

// The spend dashboard: dollars only from flat fees, invoice API cost and the allowlisted hosting readings.
const history = priorMonths(today, 3).map((r) => fakeReadApi(r, data));
const dash = buildDashboard(fakeReadApi(thisMonth, data), history, today, S);

test('spent so far is full subscription fees plus billed metered spend, and nothing from our own count', () => {
  const answer = fakeReadApi(thisMonth, data);
  const subs = 100 + 20 + 24;                                       // flat plans with a fee; prepaid and metered left out
  const api = answer.totals.invoice.cost_usd;
  const hosting = answer.limits.find((l) => l.name === 'cloud_month_to_date_usd').used;
  assert.equal(dash.parts.find((p) => p.key === 'subscriptions').value, subs);
  assert.ok(Math.abs(dash.spent - (subs + api + hosting)) < 1e-9);
  // Counters and estimate per-day dollars are not money spent.
  assert.ok(!answer.limits.some((l) => l.name === 'agent_runner_usd_day' && dash.spent === subs + api + hosting + l.used));
  const m = meteredSpend(answer, S);
  assert.equal(m.hosting, hosting);
  assert.ok(answer.totals.estimate.cost_usd > 0, 'the sample prices some estimate rows');
  assert.ok(!(dash.spent > subs + api + hosting), 'estimate cost never enters the dollars');
});

test('per day and projection: fees spread over the month, metered at this month\'s daily pace', () => {
  const metered = dash.parts.filter((p) => p.key !== 'subscriptions').reduce((s, p) => s + p.value, 0);
  assert.equal(dash.daysInMonth, 30);
  assert.equal(dash.day, 16);
  assert.ok(Math.abs(dash.perDay - (144 / 30 + metered / 16)) < 1e-9);
  assert.ok(Math.abs(dash.projected - (144 + (metered / 16) * 30)) < 1e-9);
  assert.equal(dash.monthName, 'November');
});

test('trend compares the projection with a usual month from prior months that have bills', () => {
  assert.notEqual(dash.usual, null);
  assert.match(dash.usualBasis, /averaged over 1 full month/);       // only last month has rows; empty months are skipped
  assert.ok(['over', 'under', 'on'].includes(dash.trend.state));
  assert.equal(dash.trend.state, 'over');                             // this month runs at 1.0, last month at 0.8
  assert.match(dash.trend.detail, /above a usual month/);
  assert.ok(dash.flags.some((f) => /over a usual month/.test(f.title)));
});

test('with no full month on record there is no trend, and no made-up average', () => {
  const fresh = sampleData(today, { history: false });
  const d = buildDashboard(fakeReadApi(thisMonth, fresh), priorMonths(today, 3).map((r) => fakeReadApi(r, fresh)), today, S);
  assert.equal(d.usual, null);
  assert.equal(d.trend.state, 'none');
  assert.match(d.trend.detail, /11\/30\/2026/);
  assert.equal(d.usualParts.find((p) => p.key === 'api').valueText, 'No full month yet');
  assert.equal(d.usualParts.find((p) => p.key === 'subscriptions').value, 144);
});

test('where to cut: paid plans with no usage, premium model share, warn limits, prepaid left out', () => {
  const titles = dash.flags.map((f) => f.title).join('\n');
  assert.match(titles, /ChatGPT Plus: \$20\.00 a month, no usage recorded/);
  assert.match(titles, /Cloud Starter: \$24\.00 a month, no usage recorded/);
  assert.doesNotMatch(titles, /Claude Max: .* no usage recorded/);    // it has token counts
  assert.match(titles, /% of tokens went to premium models/);
  assert.match(titles, /Cloud host spend this month is at 84%/);
  assert.match(titles, /Linear Credits \(prepaid\): prepaid, not in these totals/);
  assert.equal(dash.flags[0].level, 'warn');
  assert.equal(modelTier('claude-opus-5-5'), 'Premium');
  assert.equal(modelTier('gpt-5-mini'), 'Light');
  assert.equal(modelTier('claude-sonnet-5-5'), 'Standard');
});

test('daily tokens keep sources apart and cover each day of the month so far', () => {
  for (const d of dash.daily) {
    assert.equal(d.perDay.length, 16);
    assert.ok(d.max > 0);
  }
  assert.deepEqual(dash.daily.map((d) => d.source), ['invoice', 'estimate']);
  assert.deepEqual(priorMonths('2026-01-09', 2), [{ from: '2025-12-01', to: '2025-12-31' }, { from: '2025-11-01', to: '2025-11-30' }]);
});

test('API-rate value: input as cache hits at the low end, at the base rate at the high end', () => {
  const v = apiRateValue([
    { model: 'claude-opus-5-5', tokens_in: 1e6, tokens_out: 1e6 },
    { model: 'claude-haiku-5-5', tokens_in: 2e6, tokens_out: 0 },
    { model: 'some-new-model', tokens_in: 5, tokens_out: 5 },
  ]);
  const o = PRICES['claude-opus-5-5'], h = PRICES['claude-haiku-5-5'];
  assert.ok(Math.abs(v.low - (o.low.cacheHit + o.low.output + 2 * h.low.cacheHit)) < 1e-9);
  assert.ok(Math.abs(v.high - (o.high.input + o.high.output + 2 * h.high.input)) < 1e-9);
  assert.deepEqual(v.unpriced, ['some-new-model']);
  assert.ok(v.low < v.high);
});

test('plan value sits on the flat plan with token counts, compared with its fee, and never enters the dollars', () => {
  const max = dash.accounts.find((a) => a.account_id === 'acct-05');
  assert.ok(max.apiValue, 'Claude Max has a value');
  assert.match(max.apiValue.rangeText, /^\$[\d,.]+ to \$[\d,.]+$/);
  assert.ok(['pays', 'between', 'cheaper'].includes(max.apiValue.state));
  assert.equal(dash.accounts.find((a) => a.account_id === 'acct-08').apiValue, null);   // ChatGPT Plus: no token counts
  assert.equal(dash.accounts.find((a) => a.account_id === 'acct-06').apiValue, null);   // metered API account: billed, not valued
  const answer = fakeReadApi(thisMonth, data);
  const subs = 144, api = answer.totals.invoice.cost_usd, hosting = answer.limits.find((l) => l.name === 'cloud_month_to_date_usd').used;
  assert.ok(Math.abs(dash.spent - (subs + api + hosting)) < 1e-9, 'spent so far is unchanged by the value');
  assert.ok(dash.flags.some((f) => /Claude Max: tokens worth .* at API rates so far/.test(f.title)));
});

test('a plan whose tokens are worth less than its fee at API rates gets a cut flag', () => {
  const small = sampleData(today);
  small.usage = small.usage.map((r) => (r.account_id === 'acct-05' && !r.limit_name ? { ...r, tokens_in: 1000, tokens_out: 100 } : r));
  const d = buildDashboard(fakeReadApi(thisMonth, small), [], today, S);
  const max = d.accounts.find((a) => a.account_id === 'acct-05');
  assert.equal(max.apiValue.state, 'cheaper');
  const flag = d.flags.find((f) => /Claude Max: paying per use would likely cost less/.test(f.title));
  assert.equal(flag.level, 'warn');
});

test('subscription prices: checked date from price_checked or updated_at, flagged when older than one billing cycle', () => {
  const byPlan = Object.fromEntries(dash.accounts.map((a) => [a.plan, a]));
  assert.equal(PRICE_STALE_DAYS, 35);
  assert.equal(priceChecked({ price_checked: '2026-09-30', updated_at: '2026-11-17T15:05:00.000Z' }, TZ), '2026-09-30');
  assert.equal(priceChecked({ updated_at: '2026-11-12T03:00:00.000Z' }, TZ), '2026-11-11');    // 8 PM Mountain on 11/11
  assert.equal(priceChecked({}, TZ), null);
  assert.equal(priceChecked({ price_checked: '2026-11-17T00:00:00.000Z' }, TZ), '2026-11-17');   // a date column, day only
  assert.equal(priceChecked({ price_checked: null, updated_at: '2026-11-17T00:00:00.000Z' }, TZ), '2026-11-16');   // a real moment: 5 PM Mountain
  assert.equal(byPlan['ChatGPT Plus'].price.stale, true);                                    // 47 days before 11/16
  assert.equal(byPlan['ChatGPT Plus'].priceText, '9/30/2026, 47 days ago');
  assert.equal(byPlan['Cloud Starter'].price.stale, false);
  assert.equal(byPlan['Cloud Starter'].priceText, '11/11/2026');
  assert.equal(byPlan['Claude Max'].price.days, 0);                                         // checked after "today" counts as fresh
  assert.equal(byPlan['self-hosted'].price, null);                                           // no fee, nothing to check
  assert.equal(byPlan['Hobby (free)'].price, null);                                          // metered
  const titles = dash.flags.map((f) => f.title).join('\n');
  assert.match(titles, /ChatGPT Plus: \$20\.00 a month, price last checked 9\/30\/2026/);
  assert.doesNotMatch(titles, /Cloud Starter: .* price last checked/);
  const subs = dash.parts.find((p) => p.key === 'subscriptions');
  assert.equal(subs.checkedText, '1 of 3 prices not checked in 35 days');
  assert.equal(subs.stale, true);
  assert.equal(subs.value, 144, 'a stale price still counts at its recorded fee');
});

test('a plan with no checked date at all is flagged as never checked', () => {
  const bare = sampleData(today);
  bare.accounts = bare.accounts.map((a) => ({ ...a, updated_at: undefined, price_checked: undefined }));
  const d = buildDashboard(fakeReadApi(thisMonth, bare), [], today, S);
  assert.ok(d.flags.some((f) => /Claude Max: \$100\.00 a month, price never checked/.test(f.title)));
  assert.equal(d.accounts.find((a) => a.plan === 'Claude Max').priceText, 'never');
});
