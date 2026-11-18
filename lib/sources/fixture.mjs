// The fixture data source: invented sample data, so meterboard runs with no database and no account.
// Dated relative to "today" in the configured time zone, in the same answer shape as any other source:
// flat plans, metered accounts and a prepaid one; estimate rows with tokens and often no price; billed hosting as
// month-to-date limit readings; counters that are not dollars. No real figures.
//
// METERBOARD_FIXTURE picks a variant: full (default), unpriced (no prices on estimates, no invoice usage),
// new (only this month has rows, so no trend yet).
import { monthRanges, SOURCES, todayIn, WARN_PCT } from '../../public/usage/view.js';

/** Labels for the sample limits. Hosting readings count as month-to-date hosting dollars. */
export const FIXTURE_LIMITS = {
  cloud_month_to_date_usd: { label: 'Cloud host spend this month', unit: 'usd', hosting: true },
  web_host_month_to_date_usd: { label: 'Web host spend this month', unit: 'usd', hosting: true },
  workflow_runs_month: { label: 'Workflow runs this month', unit: 'runs' },
  workflow_run_counter: { label: 'Workflow run counter (latest run number)', unit: 'count' },
  agent_runner_usd_day: { label: 'Agent runner spend for the day', unit: 'usd' },
};

//   history: false   only this month has rows (no full month on record yet, so no trend).
//   unpriced: true   no prices on estimates and no invoice usage rows.
export function sampleData(today, { unpriced = false, history = true } = {}) {
  const { thisMonth, lastMonth } = monthRanges(today);
  const day = (range, d) => `${range.from.slice(0, 8)}${String(d).padStart(2, '0')}`;
  const accounts = [
    { account_id: 'acct-01', provider: 'n8n', plan: 'self-hosted', billing_kind: 'flat', monthly_fee: null },
    { account_id: 'acct-02', provider: 'digitalocean', plan: 'pay as you go', billing_kind: 'metered', monthly_fee: null },
    { account_id: 'acct-03', provider: 'vercel', plan: 'Hobby (free)', billing_kind: 'metered', monthly_fee: 0 },
    { account_id: 'acct-05', provider: 'anthropic', plan: 'Claude Max', billing_kind: 'flat', monthly_fee: 100, updated_at: '2026-11-17T15:05:00.000Z' },
    { account_id: 'acct-06', provider: 'anthropic', plan: '', billing_kind: 'metered', monthly_fee: null },
    { account_id: 'acct-07', provider: 'openai', plan: '', billing_kind: 'metered', monthly_fee: '' },
    { account_id: 'acct-08', provider: 'openai', plan: 'ChatGPT Plus', billing_kind: 'flat', monthly_fee: 20, price_checked: '2026-09-30', updated_at: '2026-11-17T15:05:00.000Z' },
    { account_id: 'acct-09', provider: 'n8n', plan: 'Cloud Starter', billing_kind: 'flat', monthly_fee: 24, updated_at: '2026-11-12T03:00:00.000Z' },
    { account_id: 'acct-11', provider: 'linear', plan: 'Credits (prepaid)', billing_kind: 'prepaid', monthly_fee: null },
  ];
  const row = (date, f) => ({ usage_id: `usg-${date}-${f.account_id}-${f.model || f.limit_name}-${f.source}`, usage_date: date, provider: '', agent_id: '', model: '', tokens_in: null, tokens_out: null, cost_usd: null, limit_name: '', limit_used: null, limit_total: null, created_at: `${date}T23:00:00Z`, ...f });
  const usage = [];
  const months = history ? [[thisMonth, 1], [lastMonth, 0.8]] : [[thisMonth, 1]];
  for (const [month, scale] of months) {
    const last = Number(month.to.slice(8));
    const r = (v) => Math.round(v * scale);
    const c = (v) => Math.round(v * scale * 100) / 100;
    for (let i = 1; i <= last; i += 3) {
      const d = day(month, i);
      usage.push(row(d, { account_id: 'acct-05', provider: 'anthropic', agent_id: 'agent-desk', model: 'claude-opus-5-5', tokens_in: r(42000000), tokens_out: r(110000), source: 'estimate' }));
      usage.push(row(d, { account_id: 'acct-05', provider: 'anthropic', agent_id: 'agent-desk', model: 'claude-sonnet-5-5', tokens_in: r(30000000), tokens_out: r(90000), source: 'estimate' }));
      usage.push(row(d, { account_id: 'acct-05', provider: 'anthropic', agent_id: 'agent-helper', model: 'claude-haiku-5-5', tokens_in: r(900000), tokens_out: r(23000), cost_usd: c(0.61), source: 'estimate' }));
      usage.push(row(d, { account_id: 'acct-06', provider: 'anthropic', agent_id: '', model: 'claude-haiku-5-5', tokens_in: r(310000), tokens_out: r(12000), cost_usd: c(0.42), source: 'invoice' }));
      usage.push(row(d, { account_id: 'acct-02', provider: 'digitalocean', limit_name: 'cloud_month_to_date_usd', limit_used: c((29.4 * i) / last), limit_total: 35, source: 'invoice' }));
      usage.push(row(d, { account_id: 'acct-01', provider: 'n8n', limit_name: 'workflow_run_counter', limit_used: 16000 + i * 60, source: 'estimate' }));
    }
    const end = day(month, last);
    usage.push(row(end, { account_id: 'acct-02', provider: 'digitalocean', limit_name: 'cloud_month_to_date_usd', limit_used: c(29.4), limit_total: 35, source: 'invoice' }));
    usage.push(row(end, { account_id: 'acct-03', provider: 'vercel', limit_name: 'web_host_month_to_date_usd', limit_used: 0, limit_total: null, source: 'invoice' }));
    usage.push(row(end, { account_id: 'acct-01', provider: 'n8n', limit_name: 'workflow_runs_month', limit_used: r(3120), limit_total: null, source: 'estimate' }));
    usage.push(row(end, { account_id: 'acct-05', provider: 'anthropic', limit_name: 'agent_runner_usd_day', limit_used: 0.76, limit_total: 30, source: 'estimate' }));
  }
  return { accounts, usage: unpriced ? usage.filter((r) => r.limit_name || r.source === 'estimate').map((r) => ({ ...r, cost_usd: r.limit_name ? r.cost_usd : null })) : usage };
}

/** Answers one query from sample data, the way a real usage API would (same shape, simpler code). */
export function fakeReadApi(body, { accounts, usage }) {
  if (!body?.from || !body?.to) return { ok: false, reason: 'from must be a real date as yyyy-mm-dd' };
  const rows = usage.filter((r) => r.usage_date >= body.from && r.usage_date <= body.to && (!body.account_id || r.account_id === body.account_id));
  const n = (v) => Number(v) || 0;
  const totals = {};
  const add = (t, r) => { t.tokens_in += n(r.tokens_in); t.tokens_out += n(r.tokens_out); t.cost_usd = Math.round((t.cost_usd + n(r.cost_usd)) * 1e6) / 1e6; return t; };
  for (const { key: s } of SOURCES) {
    const all = { tokens_in: 0, tokens_out: 0, cost_usd: 0 }, accounts = new Map(), models = new Map();
    for (const r of rows.filter((r) => r.source === s && !r.limit_name)) {
      add(all, r);
      if (!accounts.has(r.account_id)) accounts.set(r.account_id, { account_id: r.account_id, tokens_in: 0, tokens_out: 0, cost_usd: 0 });
      add(accounts.get(r.account_id), r);
      const k = `${r.account_id}|${r.model}`;
      if (!models.has(k)) models.set(k, { account_id: r.account_id, model: r.model, tokens_in: 0, tokens_out: 0, cost_usd: 0 });
      add(models.get(k), r);
    }
    totals[s] = { ...all, by_account: [...accounts.values()], by_model: [...models.values()] };
  }
  const latest = new Map();
  for (const r of rows.filter((r) => r.limit_name)) latest.set(`${r.account_id}|${r.limit_name}`, r);
  const limits = [...latest.values()].map((r) => {
    const total = r.limit_total === '' || r.limit_total === null ? null : n(r.limit_total);
    const pct = total ? Math.round((n(r.limit_used) / total) * 1000) / 10 : null;
    return { account_id: r.account_id, usage_date: r.usage_date, source: r.source, name: r.limit_name, used: n(r.limit_used), total, pct, level: total ? (pct >= WARN_PCT ? 'warn' : 'ok') : 'no_limit' };
  });
  return { ok: true, from: body.from, to: body.to, accounts, rows, totals, limits };
}

/** A data source over the sample data. */
export function fixtureSource({ timeZone = 'UTC', variant = 'full', today } = {}) {
  return {
    name: 'fixture',
    async read(query) {
      const day = today || todayIn(new Date(), timeZone);
      return fakeReadApi(query, sampleData(day, { unpriced: variant === 'unpriced', history: variant !== 'new' }));
    },
  };
}
