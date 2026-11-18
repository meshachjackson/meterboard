import { apiRateValue, PRICES_CHECKED } from './prices.js';

// Turns usage answers into what the dashboard shows. Pure functions: no DOM, no network.
// Used by app.js in the browser, by the MCP tools on the server and by the tests.
// Rule: invoice figures (from a bill) and estimate figures (our own count) are shown apart and never added together.
//
// Settings (from the server's /api/usage?config, or lib/config.mjs on the server):
//   timeZone  IANA zone for "today" and month edges. Default UTC.
//   limits    { [limit name]: { label, unit: 'usd' | 'hours' | 'count' | 'runs', hosting?: true } }
//             hosting: true counts an invoice reading of that limit as month-to-date hosting dollars.
export const DEFAULT_SETTINGS = { timeZone: 'UTC', limits: {} };
const settingsOf = (s) => ({ ...DEFAULT_SETTINGS, ...(s || {}), limits: { ...((s && s.limits) || {}) } });
export const WARN_PCT = 80;
export const SOURCES = [
  { key: 'invoice', label: 'From bills', note: 'Invoice figures: what a provider billed or reports as charged.' },
  { key: 'estimate', label: 'Our own count', note: 'Estimate figures: counted by our own tools, not billed.' },
];

/** Label and unit for a limit name. Unknown names show as they are; a name ending in _usd is dollars. */
export function limitMeta(name, settings) {
  const known = settingsOf(settings).limits[name];
  if (known) return { unit: 'count', ...known, label: known.label || name };
  return { label: name, unit: /_usd(_|$)/.test(name) ? 'usd' : 'count' };
}
/** Limit names whose invoice readings are month-to-date hosting dollars. */
export const hostingLimits = (settings) => Object.entries(settingsOf(settings).limits).filter(([, v]) => v && v.hosting).map(([k]) => k);

const PROVIDER_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', digitalocean: 'DigitalOcean', vercel: 'Vercel', neon: 'Neon', linear: 'Linear', railway: 'Railway', n8n: 'n8n', google: 'Google' };
/** A provider id as a name: openai as OpenAI. Unknown ids get a capital first letter. */
export function providerName(id = '') {
  return PROVIDER_NAMES[id] || (id ? id[0].toUpperCase() + id.slice(1) : '');
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const num = (v) => (Number.isFinite(+v) ? +v : 0);

const formatters = new Map();
function formatter(kind, timeZone = 'UTC') {
  const key = `${kind}|${timeZone}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat('en-US', kind === 'day'
      ? { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }
      : { timeZone, month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
  }
  return formatters.get(key);
}

/** Today in the given time zone as yyyy-mm-dd. */
export function todayIn(now = new Date(), timeZone = 'UTC') {
  const parts = Object.fromEntries(formatter('day', timeZone).formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** This month to date and all of last month, from a local yyyy-mm-dd day. */
export function monthRanges(today) {
  const [y, m] = today.split('-').map(Number);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return {
    thisMonth: { from: iso(y, m, 1), to: today },
    lastMonth: { from: iso(py, pm, 1), to: iso(py, pm, lastDay) },
  };
}

/** yyyy-mm-dd as 11/16/2026. Split the text: new Date('2026-11-16') would show 11/15 west of UTC. */
export function formatDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : '';
}

/** A moment (Date) as 11/16/2026, 5:30 PM in the given time zone. */
export function formatMoment(date, timeZone = 'UTC') {
  return formatter('moment', timeZone).format(date);
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const formatUsd = (v) => USD.format(num(v));
export const formatCount = (v) => COUNT.format(num(v));
export const formatTokens = (v) => (num(v) >= 1e6 ? COMPACT : COUNT).format(num(v));
const tokensText = (t) => `${formatTokens(t.tokens_in)} in, ${formatTokens(t.tokens_out)} out`;

function formatLimitValue(value, unit) {
  if (value === null || value === undefined || value === '') return '';
  if (unit === 'usd') return formatUsd(value);
  if (unit === 'hours') return `${formatCount(value)} h`;
  return formatCount(value);
}

const pick = (t) => ({ tokens_in: num(t?.tokens_in), tokens_out: num(t?.tokens_out), cost_usd: num(t?.cost_usd) });

// A cost is "recorded" when a row carries one. Estimate rows often carry tokens but no price; show that, not $0.00.
const hasCost = (r) => r.cost_usd !== '' && r.cost_usd !== null && r.cost_usd !== undefined;
const NO_PRICE = 'No price recorded';
const costOrNone = (value, priced, none = NO_PRICE) => (priced ? formatUsd(value) : none);
const usageRows = (answer, source) => (answer?.rows || []).filter((r) => r.source === source && !r.limit_name);

/** Subscriptions from the accounts list. monthly_fee may be "", null or a number; blank shows "not set". */
function buildSubscriptions(accounts = []) {
  const rows = accounts.map((a) => {
    const blank = a.monthly_fee === '' || a.monthly_fee === null || !Number.isFinite(Number(a.monthly_fee));
    const fee = blank ? null : Number(a.monthly_fee);
    return { account_id: a.account_id, provider: a.provider || a.account_id, plan: a.plan || '', fee, feeText: fee === null ? 'not set' : formatUsd(fee) };
  });
  const set = rows.filter((r) => r.fee !== null);
  const total = set.reduce((s, r) => s + r.fee, 0);
  return {
    rows,
    setCount: set.length,
    summary: set.length === rows.length
      ? `${formatUsd(total)} a month across ${rows.length} accounts`
      : `${formatUsd(total)} a month from ${set.length} of ${rows.length} accounts; ${rows.length - set.length} not set`,
  };
}

/** Limits as the read API judged them. no_limit rows show what was used, with no bar and no 80% mark. */
function buildLimits(limits = [], settings) {
  return limits.map((l) => {
    const meta = limitMeta(l.name, settings);
    const hasLimit = l.level !== 'no_limit' && l.total !== null && l.total !== undefined;
    return {
      name: l.name,
      label: meta.label,
      sourceLabel: SOURCES.find((s) => s.key === l.source)?.label || l.source,
      hasLimit,
      pct: hasLimit ? num(l.pct) : null,
      warn: l.level === 'warn',
      levelText: !hasLimit ? 'No limit set' : l.level === 'warn' ? `At ${formatCount(l.pct)}%, past the ${WARN_PCT}% mark` : `At ${formatCount(l.pct)}%`,
      usedText: formatLimitValue(l.used, meta.unit),
      totalText: hasLimit ? formatLimitValue(l.total, meta.unit) : '',
      asOf: formatDay(l.usage_date),
    };
  });
}

/** Tokens and spend per agent from usage rows, one list per source. Limit rows are left out. */
function buildAgents(rows = []) {
  const out = {};
  for (const { key } of SOURCES) {
    const map = new Map();
    for (const r of rows) {
      if (r.source !== key || r.limit_name) continue;
      const id = r.agent_id || '';
      if (!map.has(id)) map.set(id, { agent_id: id, agentText: id || 'No agent named', tokens_in: 0, tokens_out: 0, cost_usd: 0, priced: false, days: new Set() });
      const a = map.get(id);
      a.tokens_in += num(r.tokens_in); a.tokens_out += num(r.tokens_out); a.cost_usd += num(r.cost_usd); a.priced ||= hasCost(r); a.days.add(r.usage_date);
    }
    out[key] = [...map.values()]
      .map(({ days, ...a }) => ({ ...a, days: days.size }))
      .sort((p, q) => q.tokens_in + q.tokens_out - (p.tokens_in + p.tokens_out) || p.agentText.localeCompare(q.agentText));
  }
  return out;
}

/**
 * Everything the dashboard shows, from this month's answer and last month's answer.
 * Each source keeps its own figures. There is no field that adds invoice and estimate.
 * Table rows are display text, ready for the page.
 */
export function buildView(current, previous, settings) {
  const agents = buildAgents(current?.rows);
  const lastRangeText = previous?.ok ? `${formatDay(previous.from)} to ${formatDay(previous.to)}` : '';
  const sources = SOURCES.map(({ key, label, note }) => {
    const now = pick(current?.totals?.[key]);
    const before = previous?.ok ? pick(previous.totals?.[key]) : null;
    const mine = usageRows(current, key);
    const pricedModels = new Set(mine.filter(hasCost).map((r) => `${r.account_id}|${r.model}`));
    return {
      key, label, note,
      thisMonth: now,
      lastMonth: before,
      priced: mine.some(hasCost),
      costText: costOrNone(now.cost_usd, mine.some(hasCost)),
      tokensText: tokensText(now),
      lastText: before ? `${costOrNone(before.cost_usd, usageRows(previous, key).some(hasCost))}, tokens ${tokensText(before)}` : 'not available',
      agentRows: agents[key].map((a) => [a.agentText, formatTokens(a.tokens_in), formatTokens(a.tokens_out), costOrNone(a.cost_usd, a.priced, 'no price'), formatCount(a.days)]),
      modelRows: (current?.totals?.[key]?.by_model || []).map((m) => [`${m.model} (${m.account_id})`, formatTokens(m.tokens_in), formatTokens(m.tokens_out), costOrNone(m.cost_usd, pricedModels.has(`${m.account_id}|${m.model}`), 'no price')]),
      agents: agents[key],
    };
  });
  return {
    rangeText: `${formatDay(current?.from)} to ${formatDay(current?.to)}`,
    lastRangeText,
    sources,
    subscriptions: buildSubscriptions(current?.accounts),
    limits: buildLimits(current?.limits, settings),
  };
}

// ---------------------------------------------------------------------------
// The spend dashboard: the dollar headline, the usual month, the trend and where to cut.
// Dollars come from three places only, named here so nothing else slips in:
//   subscriptions  accounts with billing_kind "flat" and a monthly_fee, counted in full for the month, before tax;
//   api            invoice usage rows (cost_usd), as the read API totals them;
//   hosting        invoice month-to-date readings of limits marked hosting in settings (the latest reading is the month so far).
// Estimate figures (our own count) never enter a dollar sum, and their tokens are never added to invoice tokens.
// Prepaid accounts (credits bought as needed) are listed but left out of the totals.

export const SPEND_KINDS = [
  { key: 'subscriptions', label: 'Subscriptions', note: 'Flat monthly plans, full fee, before tax' },
  { key: 'api', label: 'API, pay per use', note: 'From provider bills' },
  { key: 'hosting', label: 'Hosting, metered', note: 'Cloud bills, month to date' },
];
export const TREND_BAND_PCT = 5;
const MONTH_NAME = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });

/** Full months before today's month, newest first, for the monthly average. */
export function priorMonths(today, count = 3) {
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const yy = d.getUTCFullYear(), mm = d.getUTCMonth() + 1;
    out.push({ from: iso(yy, mm, 1), to: iso(yy, mm, new Date(Date.UTC(yy, mm, 0)).getUTCDate()) });
  }
  return out;
}

const blankFee = (v) => v === '' || v === null || v === undefined || !Number.isFinite(Number(v));
const isFlat = (a) => (a.billing_kind ? a.billing_kind === 'flat' : !blankFee(a.monthly_fee));
const KIND_TEXT = { flat: 'Subscription', metered: 'Pay per use', prepaid: 'Prepaid credits' };

// Fixed fees are typed in from a plan page or a bill: no provider offers a customer billing API for these plans,
// and the dashboard does not read email. A price not checked in PRICE_STALE_DAYS (about one billing cycle) is flagged.
// The date is the row's price_checked (yyyy-mm-dd) when set, else its updated_at, both in the settings time zone.
export const PRICE_STALE_DAYS = 35;
const dayNumber = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
export function priceChecked(a = {}, timeZone = 'UTC') {
  for (const v of [a.price_checked, a.updated_at]) {
    if (!v) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    // A date-only value saved in some date columns comes back as midnight UTC: keep its day, not the local evening before.
    const midnight = /^(\d{4}-\d{2}-\d{2})T00:00:00(\.000)?Z$/.exec(v);
    if (v === a.price_checked && midnight) return midnight[1];
    const t = new Date(v);
    if (!Number.isNaN(t.getTime())) return todayIn(t, timeZone);
  }
  return null;
}
function priceAge(a, today, timeZone) {
  const checked = priceChecked(a, timeZone);
  const days = checked ? Math.max(0, dayNumber(today) - dayNumber(checked)) : null;
  const stale = days === null || days > PRICE_STALE_DAYS;
  return { checked, days, stale, checkedText: checked ? `${formatDay(checked)}${stale ? `, ${days} days ago` : ''}` : 'never' };
}

/** Model tier, by name. Used to point at token share on the dearest models. */
export function modelTier(model = '') {
  if (/opus/i.test(model)) return 'Premium';
  if (/haiku|mini|nano|flash|lite/i.test(model)) return 'Light';
  return 'Standard';
}

/** Billed metered dollars in one month's answer (invoice only), with a per-account split. */
export function meteredSpend(answer, settings) {
  const hostingNames = hostingLimits(settings);
  const byAccount = new Map();
  const bump = (id, k, v) => {
    if (!byAccount.has(id)) byAccount.set(id, { api: 0, hosting: 0 });
    byAccount.get(id)[k] += v;
  };
  const invoice = answer?.totals?.invoice || {};
  for (const a of invoice.by_account || []) bump(a.account_id, 'api', num(a.cost_usd));
  const readings = (answer?.limits || []).filter((l) => l.source === 'invoice' && hostingNames.includes(l.name));
  for (const l of readings) bump(l.account_id, 'hosting', num(l.used));
  const api = num(invoice.cost_usd);
  const hosting = readings.reduce((s, l) => s + num(l.used), 0);
  return { api, hosting, total: api + hosting, hasData: (invoice.by_account || []).length > 0 || readings.length > 0, byAccount };
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Tokens per recorded day for one source, split by model. Limit rows are left out. */
function dailyTokens(answer, source, today) {
  const days = Number(today.slice(8));
  const prefix = today.slice(0, 8);
  const models = new Map();
  const perDay = Array.from({ length: days }, (_, i) => ({ day: `${prefix}${pad(i + 1)}`, total: 0, byModel: {} }));
  for (const r of usageRows(answer, source)) {
    const i = Number(String(r.usage_date).slice(8)) - 1;
    if (!String(r.usage_date).startsWith(prefix) || !perDay[i]) continue;
    const t = num(r.tokens_in) + num(r.tokens_out);
    const model = r.model || 'No model named';
    perDay[i].byModel[model] = (perDay[i].byModel[model] || 0) + t;
    perDay[i].total += t;
    models.set(model, (models.get(model) || 0) + t);
  }
  return { source, perDay, models: [...models.keys()].sort(), max: Math.max(0, ...perDay.map((d) => d.total)) };
}

/** Token share per model for one source, largest first. */
function modelMix(answer, source) {
  const list = (answer?.totals?.[source]?.by_model || []).map((m) => ({
    model: m.model || 'No model named', account_id: m.account_id, tier: modelTier(m.model),
    tokens_in: num(m.tokens_in), tokens_out: num(m.tokens_out), tokens: num(m.tokens_in) + num(m.tokens_out), cost_usd: num(m.cost_usd),
  }));
  const all = list.reduce((s, m) => s + m.tokens, 0);
  return list.map((m) => ({ ...m, share: all ? (m.tokens / all) * 100 : 0 })).sort((a, b) => b.tokens - a.tokens);
}

/**
 * What one flat plan's tokens this month would have cost at API list prices (our own count only), as a range,
 * with a month-end projection compared with the fee. An estimate: never added to billed dollars.
 */
function planValue(answer, accountId, fee, day, dim) {
  const models = (answer?.totals?.estimate?.by_model || []).filter((m) => m.account_id === accountId);
  const v = apiRateValue(models);
  if (!v.priced.length) return null;
  const scale = dim / day;
  const monthLow = v.low * scale, monthHigh = v.high * scale;
  const state = monthHigh < fee ? 'cheaper' : monthLow >= fee ? 'pays' : 'between';
  const ratio = (x) => `${formatCount(x / fee)}x`;
  return {
    low: v.low, high: v.high, monthLow, monthHigh, state, unpriced: v.unpriced,
    rangeText: `${formatUsd(v.low)} to ${formatUsd(v.high)}`,
    ratioText: v.low >= fee ? `at least ${ratio(v.low)}` : `${ratio(v.low)} to ${ratio(v.high)}`,
    note: `Low end prices all input as cache hits, high end at the full input rate; prices checked ${formatDay(PRICES_CHECKED)}.${v.unpriced.length ? ` No price on file for ${v.unpriced.join(', ')}.` : ''}`,
  };
}

/**
 * Everything above the breakdowns: the dollar headline, a usual month, the trend, the accounts and where to cut.
 * @param {object} current  this month's answer from the read API
 * @param {object[]} history  answers for prior full months (any order); failed or empty months are skipped
 * @param {string} today  yyyy-mm-dd in the settings time zone
 * @param {object} [settings]  { timeZone, limits }, see the top of this file
 */
export function buildDashboard(current, history = [], today, settings) {
  const day = Number(today.slice(8));
  const [y, m] = today.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthName = MONTH_NAME.format(new Date(Date.UTC(y, m - 1, 1)));
  const monthEnd = iso(y, m, dim);
  const accounts = current?.accounts || [];

  // Subscriptions: flat plans, full monthly fee.
  const subs = accounts.filter(isFlat).map((a) => ({ account_id: a.account_id, provider: providerName(a.provider) || a.account_id, plan: a.plan || '', fee: blankFee(a.monthly_fee) ? null : Number(a.monthly_fee) }));
  const subsTotal = subs.reduce((s, a) => s + (a.fee || 0), 0);

  // Metered: billed API and hosting so far this month.
  const metered = meteredSpend(current, settings);
  const spent = subsTotal + metered.total;
  const meteredPerDay = metered.total / day;
  const perDay = subsTotal / dim + meteredPerDay;
  const projected = subsTotal + meteredPerDay * dim;

  // A usual month: today's fees plus the average of prior months that have billed readings.
  const past = history.filter((a) => a?.ok).map((a) => meteredSpend(a, settings)).filter((x) => x.hasData);
  const avg = past.length ? { api: mean(past.map((x) => x.api)), hosting: mean(past.map((x) => x.hosting)) } : null;
  const usual = avg ? subsTotal + avg.api + avg.hosting : null;

  let trend;
  if (usual === null) {
    trend = { state: 'none', label: 'No trend yet', detail: `No full month on record to compare with. The first one closes ${formatDay(monthEnd)}.` };
  } else {
    const diff = projected - usual;
    const pct = usual ? (diff / usual) * 100 : 0;
    const state = pct > TREND_BAND_PCT ? 'over' : pct < -TREND_BAND_PCT ? 'under' : 'on';
    trend = {
      state, pct, diff,
      label: state === 'over' ? 'Over trend' : state === 'under' ? 'Under trend' : 'On trend',
      detail: state === 'on'
        ? `Heading for ${formatUsd(projected)}, within ${TREND_BAND_PCT}% of a usual month (${formatUsd(usual)}).`
        : `Heading for ${formatUsd(projected)}, ${formatUsd(Math.abs(diff))} (${formatCount(Math.abs(pct))}%) ${state === 'over' ? 'above' : 'below'} a usual month (${formatUsd(usual)}).`,
    };
  }

  const parts = [
    { key: 'subscriptions', value: subsTotal },
    { key: 'api', value: metered.api },
    { key: 'hosting', value: metered.hosting },
  ].map((p) => ({ ...p, ...SPEND_KINDS.find((k) => k.key === p.key), valueText: formatUsd(p.value) }));

  const usualParts = SPEND_KINDS.map((k) => {
    const value = k.key === 'subscriptions' ? subsTotal : avg ? avg[k.key] : null;
    return { ...k, value, valueText: value === null ? 'No full month yet' : formatUsd(value) };
  });

  // Accounts: what each costs and what it was used for this month.
  const est = new Map((current?.totals?.estimate?.by_account || []).map((a) => [a.account_id, a]));
  const inv = new Map((current?.totals?.invoice?.by_account || []).map((a) => [a.account_id, a]));
  const limitAccounts = new Set((current?.limits || []).map((l) => l.account_id));
  const accountRows = accounts.map((a) => {
    const fee = blankFee(a.monthly_fee) ? null : Number(a.monthly_fee);
    const kind = a.billing_kind || (fee === null ? 'metered' : 'flat');
    const billed = metered.byAccount.get(a.account_id);
    const tokens = [inv.get(a.account_id) && { ...pick(inv.get(a.account_id)), sourceLabel: 'from bills' }, est.get(a.account_id) && { ...pick(est.get(a.account_id)), sourceLabel: 'our own count' }].filter(Boolean);
    const used = tokens.some((t) => t.tokens_in + t.tokens_out > 0) || limitAccounts.has(a.account_id) || Boolean(billed);
    const price = kind === 'flat' && fee !== null ? priceAge(a, today, settingsOf(settings).timeZone) : null;
    return {
      account_id: a.account_id, provider: providerName(a.provider) || a.account_id, plan: a.plan || '', kind, kindText: KIND_TEXT[kind] || kind,
      fee, feeText: kind === 'prepaid' ? 'prepaid' : fee === null ? (kind === 'flat' ? 'not set' : 'none') : formatUsd(fee),
      billed: billed ? billed.api + billed.hosting : null,
      billedText: billed ? formatUsd(billed.api + billed.hosting) : kind === 'metered' ? 'no bill reading' : '',
      tokensText: tokens.length ? tokens.map((t) => `${tokensText(t)} (${t.sourceLabel})`).join('; ') : '',
      used,
      price,
      priceText: price ? price.checkedText : '',
      costPerMillion: kind === 'flat' && fee && est.get(a.account_id) ? fee / ((num(est.get(a.account_id).tokens_in) + num(est.get(a.account_id).tokens_out)) / 1e6) : null,
      apiValue: kind === 'flat' && fee > 0 ? planValue(current, a.account_id, fee, day, dim) : null,
    };
  }).sort((p, q) => (q.fee || 0) + (q.billed || 0) - ((p.fee || 0) + (p.billed || 0)) || p.provider.localeCompare(q.provider));

  const priced = accountRows.filter((r) => r.price);
  const staleCount = priced.filter((r) => r.price.stale).length;
  const oldest = priced.map((r) => r.price.checked).filter(Boolean).sort()[0];
  const subsPart = parts.find((p) => p.key === 'subscriptions');
  subsPart.checkedText = !priced.length ? '' : staleCount
    ? `${staleCount} of ${priced.length} prices not checked in ${PRICE_STALE_DAYS} days`
    : `Prices checked since ${formatDay(oldest)}`;
  subsPart.stale = staleCount > 0;

  // Where to cut.
  const flags = [];
  for (const a of accountRows.filter((r) => r.apiValue)) {
    const v = a.apiValue, name = `${a.provider}${a.plan ? ` ${a.plan}` : ''}`;
    if (v.state === 'cheaper') {
      flags.push({ level: 'warn', amount: a.fee - v.monthHigh, title: `${name}: paying per use would likely cost less than the ${formatUsd(a.fee)} fee`, detail: `At API rates this month's tokens come to ${v.rangeText}, heading for at most ${formatUsd(v.monthHigh)} by month end. ${v.note}` });
    } else {
      flags.push({ level: 'info', amount: null, title: `${name}: tokens worth ${v.rangeText} at API rates so far, ${v.ratioText} its ${formatUsd(a.fee)} fee`, detail: v.state === 'pays' ? `The plan pays for itself even at the cheapest reading. ${v.note}` : `Somewhere between below and above the fee; the plan's value depends on how much input was cached. ${v.note}` });
    }
  }
  for (const a of accountRows) {
    if (a.kind === 'flat' && a.fee > 0 && !a.used) {
      flags.push({ level: 'warn', amount: a.fee, title: `${a.provider}${a.plan ? ` ${a.plan}` : ''}: ${formatUsd(a.fee)} a month, no usage recorded this month`, detail: 'Either it sat idle or the tracker cannot see it yet. If you are not using it, cancel it.' });
    }
  }
  for (const { key, label } of SOURCES) {
    const mix = modelMix(current, key);
    const premium = mix.filter((x) => x.tier === 'Premium');
    const share = premium.reduce((s, x) => s + x.share, 0);
    if (premium.length && share >= 25) {
      flags.push({ level: 'info', amount: null, title: `${formatCount(share)}% of tokens went to premium models (${label.toLowerCase()})`, detail: `${premium.map((x) => x.model).join(', ')}. Routine work on a standard or light model costs less and uses less of a plan's limit.` });
    }
  }
  for (const l of current?.limits || []) {
    if (l.level === 'warn') flags.push({ level: 'warn', amount: null, title: `${limitMeta(l.name, settings).label} is at ${formatCount(l.pct)}% of its limit`, detail: `Past the ${WARN_PCT}% mark as of ${formatDay(l.usage_date)}.` });
  }
  for (const a of accountRows.filter((r) => r.price?.stale)) {
    flags.push({ level: 'warn', amount: null, title: `${a.provider}${a.plan ? ` ${a.plan}` : ''}: ${a.feeText} a month, price ${a.price.checked ? `last checked ${formatDay(a.price.checked)}` : 'never checked'}`, detail: `Fixed fees are typed in, not read from the provider. Check the plan page or the latest bill, then update price_checked on account ${a.account_id}.` });
  }
  if (trend.state === 'over') flags.push({ level: 'warn', amount: trend.diff, title: `Metered spend is running ${formatCount(trend.pct)}% over a usual month`, detail: trend.detail });
  for (const a of accountRows.filter((r) => r.kind === 'prepaid')) {
    flags.push({ level: 'info', amount: null, title: `${a.provider} ${a.plan || 'credits'}: prepaid, not in these totals`, detail: 'Credits are bought as needed, so they have no monthly figure here.' });
  }
  flags.sort((p, q) => (p.level === q.level ? (q.amount || 0) - (p.amount || 0) : p.level === 'warn' ? -1 : 1));

  return {
    monthName, day, daysInMonth: dim,
    spent, spentText: formatUsd(spent),
    perDay, perDayText: formatUsd(perDay),
    perDayDetail: `${formatUsd(subsTotal / dim)} of subscriptions (fees divided by ${dim} days) plus ${formatUsd(meteredPerDay)} metered`,
    projected, projectedText: formatUsd(projected),
    parts, usual, usualText: usual === null ? 'No full month yet' : formatUsd(usual), usualParts,
    usualBasis: past.length ? `Subscriptions at today's fees, metered spend averaged over ${past.length} full month${past.length === 1 ? '' : 's'}.` : `Subscriptions at today's fees. Metered spend has no full month on record yet; this month is heading for ${formatUsd(metered.total + meteredPerDay * (dim - day))} metered.`,
    expectedByToday: usual === null ? null : subsTotal + (avg.api + avg.hosting) * (day / dim),
    trend,
    pace: { scaleMax: Math.max(projected, usual || 0, spent, 1) * 1.04 },
    accounts: accountRows,
    flags,
    daily: SOURCES.map(({ key, label }) => ({ ...dailyTokens(current, key, today), label })).filter((d) => d.max > 0),
    mix: SOURCES.map(({ key, label }) => ({ key, label, models: modelMix(current, key) })).filter((x) => x.models.length),
    rowsCut: Boolean(current?.rows_cut),
  };
}
