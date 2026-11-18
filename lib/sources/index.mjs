// Data sources. meterboard reads usage only through one of these.
//
// A source is { name, read(query) }:
//   query   { from: 'yyyy-mm-dd', to: 'yyyy-mm-dd', account_id?, provider?, agent_id? }
//   read    resolves to an answer, or throws an Error with a plain-language message when the source cannot be reached.
//
// An answer is { ok: false, reason } when the query is wrong, or:
//   {
//     ok: true, from, to,
//     accounts: [{ account_id, provider, plan, billing_kind: 'flat' | 'metered' | 'prepaid', monthly_fee, price_checked?, updated_at? }],
//     rows:     [{ usage_date, account_id, provider, agent_id, model, tokens_in, tokens_out, cost_usd,
//                  limit_name, limit_used, limit_total, source: 'invoice' | 'estimate' }],
//     totals:   { invoice: TOTAL, estimate: TOTAL },
//               TOTAL = { tokens_in, tokens_out, cost_usd, by_account: [{ account_id, ... }], by_model: [{ account_id, model, ... }] }
//     limits:   [{ account_id, usage_date, source, name, used, total, pct, level: 'ok' | 'warn' | 'no_limit' }],
//     rows_cut?: true when the source left rows out (totals and limits still cover all of them)
//   }
// Invoice figures (from bills) and estimate figures (counted by your own tools) are kept apart and never added together.
//
// To add a source: write lib/sources/<name>.mjs with a function that returns { name, read }, add it below and to
// SOURCE_NAMES in lib/config.mjs, and run test/source-contract.test.mjs against it.
import { fixtureSource } from './fixture.mjs';
import { httpSource } from './http.mjs';

/** The source a config names. Throws for an unknown name. */
export function createSource(config, { fetch } = {}) {
  switch (config.source) {
    case 'fixture': return fixtureSource({ timeZone: config.timeZone, variant: config.fixture });
    case 'http': return httpSource({ ...config.http, fetch });
    default: throw new Error(`Unknown data source "${config.source}". Set METERBOARD_SOURCE to fixture or http.`);
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOTAL_KEYS = ['tokens_in', 'tokens_out', 'cost_usd', 'by_account', 'by_model'];

/** Problems with an answer's shape, as sentences. Empty when it follows the contract above. */
export function answerProblems(a) {
  if (!a || typeof a !== 'object') return ['The answer is not an object.'];
  if (a.ok === false) return typeof a.reason === 'string' && a.reason ? [] : ['ok: false needs a reason.'];
  const p = [];
  if (a.ok !== true) p.push('ok must be true or false.');
  for (const k of ['from', 'to']) if (!DAY.test(String(a[k]))) p.push(`${k} must be yyyy-mm-dd.`);
  for (const k of ['accounts', 'rows', 'limits']) if (!Array.isArray(a[k])) p.push(`${k} must be a list.`);
  for (const s of ['invoice', 'estimate']) {
    const t = a.totals?.[s];
    if (!t) { p.push(`totals.${s} is missing.`); continue; }
    for (const k of TOTAL_KEYS) if (!(k in t)) p.push(`totals.${s}.${k} is missing.`);
  }
  for (const r of a.rows || []) if (!['invoice', 'estimate'].includes(r.source)) { p.push('Every row needs source invoice or estimate.'); break; }
  return p;
}
