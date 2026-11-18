// API list prices per million tokens, used to say what plan tokens would have cost if paid per use.
// Source: https://platform.claude.com/docs/en/about-claude/pricing, read 11/17/2026. Standard (not batch) prices, USD.
// Update the figures and PRICES_CHECKED together whenever a price changes or a model is added.
//   input     base input tokens
//   cacheHit  cache hits and refreshes
//   output    output tokens
// Haiku 5.5 has two rows on the page: prompts up to 100,000 tokens (low) and over (high).

export const PRICES_CHECKED = '2026-11-17';
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

export const PRICES = {
  'claude-opus-5-5': { low: { input: 4, cacheHit: 0.2, output: 20 }, high: { input: 4, cacheHit: 0.2, output: 20 } },
  'claude-sonnet-5-5': { low: { input: 2, cacheHit: 0.1, output: 10 }, high: { input: 2, cacheHit: 0.1, output: 10 } },
  'claude-haiku-5-5': { low: { input: 0.1, cacheHit: 0.01, output: 0.5 }, high: { input: 0.5, cacheHit: 0.05, output: 2.5 } },
};

/**
 * What tokens would have cost at API list prices, as a range.
 * The usage rows do not split cache reads from fresh input, so:
 *   low  prices every input token as a cache hit (the cheapest it could be),
 *   high prices every input token at the base input rate (the dearest it could be).
 * Output tokens are priced at the output rate in both.
 * @param {{model: string, tokens_in: number, tokens_out: number}[]} models
 * @returns {{low: number, high: number, priced: string[], unpriced: string[]}}
 */
export function apiRateValue(models = []) {
  let low = 0, high = 0;
  const priced = [], unpriced = [];
  for (const m of models) {
    const p = PRICES[m.model];
    const tin = Number(m.tokens_in) || 0, tout = Number(m.tokens_out) || 0;
    if (!tin && !tout) continue;
    if (!p) { unpriced.push(m.model || 'No model named'); continue; }
    priced.push(m.model);
    low += (tin * p.low.cacheHit + tout * p.low.output) / 1e6;
    high += (tin * p.high.input + tout * p.high.output) / 1e6;
  }
  return { low, high, priced, unpriced };
}
