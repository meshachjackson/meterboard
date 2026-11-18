// The two read-only tools of the usage MCP endpoint: usage_summary and usage_query.
// Pure functions: the data source and the clock are passed in, so tests need no network.
// Rule: invoice figures (from bills) and estimates (our own count) are listed apart and never added together.
import { buildView, DEFAULT_SETTINGS, formatDay, formatTokens, formatUsd, monthRanges, todayIn, WARN_PCT } from '../public/usage/view.js';

export const ROW_CAP = 200;
const TOP = 5;
const PERIODS = { this_month: 'this month', last_month: 'last month', last_7_days: 'the last 7 days' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Date range for a period, from a local yyyy-mm-dd "today". Last 7 days includes today. */
export function periodRange(period, today) {
  const { thisMonth, lastMonth } = monthRanges(today);
  if (period === 'last_month') return lastMonth;
  if (period === 'last_7_days') {
    const [y, m, d] = today.split('-').map(Number);
    return { from: new Date(Date.UTC(y, m - 1, d - 6)).toISOString().slice(0, 10), to: today };
  }
  return thisMonth;
}

const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });
const sortByTokens = (list) => [...list].sort((p, q) => q.tokens_in + q.tokens_out - (p.tokens_in + p.tokens_out));

const SUMMARY_SOURCE = { type: 'object', properties: { tokens_in: { type: 'number' }, tokens_out: { type: 'number' }, cost_usd: { type: ['number', 'null'], description: 'null when no price is recorded' } }, required: ['tokens_in', 'tokens_out', 'cost_usd'] };
const TOP_LIST = { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, tokens_in: { type: 'number' }, tokens_out: { type: 'number' } }, required: ['name', 'tokens_in', 'tokens_out'] } };
const BY_SOURCE = (item) => ({ type: 'object', properties: { invoice: item, estimate: item }, required: ['invoice', 'estimate'] });

/** The tool list. `zoneLabel` names the time zone periods are counted in, for example UTC. */
export const toolList = (zoneLabel = 'UTC') => [
  {
    name: 'usage_summary',
    title: 'AI usage summary',
    description: 'A short summary of AI usage for a period: invoice totals (from bills) and estimate totals (our own count) as separate figures, the top 5 accounts, agents and models by tokens for each, and every limit at or past 80%. Read-only.',
    inputSchema: { type: 'object', properties: { period: { type: 'string', enum: Object.keys(PERIODS), default: 'this_month', description: `${zoneLabel}. Default this_month.` } }, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
        invoice: SUMMARY_SOURCE, estimate: SUMMARY_SOURCE,
        top_accounts: BY_SOURCE(TOP_LIST), top_agents: BY_SOURCE(TOP_LIST), top_models: BY_SOURCE(TOP_LIST),
        limits_at_or_past_80: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, label: { type: 'string' }, pct: { type: 'number' } }, required: ['name', 'label', 'pct'] } },
      },
      required: ['period', 'from', 'to', 'invoice', 'estimate', 'top_accounts', 'top_agents', 'top_models', 'limits_at_or_past_80'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'usage_query',
    title: 'AI usage query',
    description: `Ask the usage data source directly for one date range (at most 93 days). Returns totals and limits in full, plus up to ${ROW_CAP} rows. Invoice and estimate figures are kept apart. Read-only.`,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, yyyy-mm-dd.' },
        to: { type: 'string', description: 'Last day, yyyy-mm-dd.' },
        account_id: { type: 'string' }, provider: { type: 'string' }, agent_id: { type: 'string' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];
export const TOOLS = toolList();

const top = (items) => sortByTokens(items).slice(0, TOP).map(({ name, tokens_in, tokens_out }) => ({ name, tokens_in, tokens_out }));
const topText = (items) => (items.length ? items.map((i) => `${i.name} (${formatTokens(i.tokens_in)} in, ${formatTokens(i.tokens_out)} out)`).join('; ') : 'none');

/** usage_summary. Returns an MCP tool result. A bad argument is a tool error in plain words, so the model can correct it. */
export async function usageSummary(args = {}, { read, now = new Date(), settings = DEFAULT_SETTINGS, zoneLabel = settings.timeZone || 'UTC' } = {}) {
  const period = args.period ?? 'this_month';
  if (!Object.hasOwn(PERIODS, period)) return errorResult(`period must be one of: ${Object.keys(PERIODS).join(', ')}.`);
  const range = periodRange(period, todayIn(now, settings.timeZone));
  let answer;
  try { answer = await read(range); } catch (error) { return errorResult(error.message); }
  if (!answer?.ok) return errorResult(`The usage data source said: ${answer?.reason || 'no reason given'}`);

  const view = buildView(answer, null, settings);
  const providerOf = new Map((answer.accounts || []).map((a) => [a.account_id, a.provider || a.account_id]));
  const data = { period, from: range.from, to: range.to, top_accounts: {}, top_agents: {}, top_models: {} };
  const lines = [`AI usage for ${PERIODS[period]}, ${formatDay(range.from)} to ${formatDay(range.to)} (${zoneLabel}).`, ''];
  for (const s of view.sources) {
    const t = answer.totals?.[s.key] || {};
    data[s.key] = { tokens_in: s.thisMonth.tokens_in, tokens_out: s.thisMonth.tokens_out, cost_usd: s.priced ? s.thisMonth.cost_usd : null };
    data.top_accounts[s.key] = top((t.by_account || []).map((a) => ({ name: `${a.account_id} (${providerOf.get(a.account_id) || 'unknown'})`, tokens_in: +a.tokens_in || 0, tokens_out: +a.tokens_out || 0 })));
    data.top_agents[s.key] = top(s.agents.map((a) => ({ name: a.agentText, tokens_in: a.tokens_in, tokens_out: a.tokens_out })));
    data.top_models[s.key] = top((t.by_model || []).map((m) => ({ name: `${m.model} (${m.account_id})`, tokens_in: +m.tokens_in || 0, tokens_out: +m.tokens_out || 0 })));
  }
  for (const s of view.sources) lines.push(`${s.label} (${s.key}): spend ${s.costText}; tokens ${s.tokensText}.`);
  lines.push('These two are counted differently. They are not added together.');
  for (const s of view.sources) {
    lines.push('', `${s.label}:`,
      `  Top accounts: ${topText(data.top_accounts[s.key])}`,
      `  Top agents: ${topText(data.top_agents[s.key])}`,
      `  Top models: ${topText(data.top_models[s.key])}`);
  }
  data.limits_at_or_past_80 = view.limits.filter((l) => l.hasLimit && l.pct >= WARN_PCT).map((l) => ({ name: l.name, label: l.label, pct: l.pct }));
  lines.push('', data.limits_at_or_past_80.length
    ? `Limits at or past ${WARN_PCT}%:\n` + data.limits_at_or_past_80.map((l) => `  ${l.label}: ${l.pct}%`).join('\n')
    : `No limits are at or past ${WARN_PCT}%.`);
  return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: data };
}

/** usage_query. Passes the filters to the data source. A bad argument is a tool error in plain words. */
export async function usageQuery(args = {}, { read } = {}) {
  const query = {};
  for (const k of ['from', 'to']) {
    if (typeof args[k] !== 'string' || !DAY.test(args[k])) return errorResult(`${k} is required, as a date like 2026-11-16.`);
    query[k] = args[k];
  }
  for (const k of ['account_id', 'provider', 'agent_id']) {
    if (args[k] === undefined) continue;
    if (typeof args[k] !== 'string') return errorResult(`${k} must be text.`);
    query[k] = args[k];
  }
  let answer;
  try { answer = await read(query); } catch (error) { return errorResult(error.message); }
  if (!answer?.ok) return errorResult(`The usage data source said: ${answer?.reason || 'no reason given'}`);

  const rows = Array.isArray(answer.rows) ? answer.rows : [];
  const cut = rows.length > ROW_CAP;
  const data = { ok: true, from: answer.from, to: answer.to, accounts: answer.accounts || [], totals: answer.totals || {}, limits: answer.limits || [], rows: rows.slice(0, ROW_CAP), rows_total: rows.length, rows_cut: cut };
  if (cut) data.note = `Showing the first ${ROW_CAP} of ${rows.length} rows. Narrow the dates or add a filter to see the rest. Totals and limits cover all rows.`;
  const head = `Usage ${formatDay(answer.from)} to ${formatDay(answer.to)}. Invoice spend ${formatUsd(answer.totals?.invoice?.cost_usd)}, estimate spend ${formatUsd(answer.totals?.estimate?.cost_usd)} (not added together). ${data.rows.length} of ${rows.length} rows shown.`;
  return { content: [{ type: 'text', text: `${head}${cut ? '\n' + data.note : ''}\n\n${JSON.stringify(data)}` }], structuredContent: data };
}

export const HANDLERS = { usage_summary: usageSummary, usage_query: usageQuery };
