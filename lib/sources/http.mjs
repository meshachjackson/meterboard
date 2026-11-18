// The http data source: POSTs each query as JSON to a usage API you run, and passes its answer through.
// Settings: METERBOARD_HTTP_URL, METERBOARD_HTTP_KEY, METERBOARD_HTTP_KEY_HEADER (the header the key is sent in).
// Node built-ins only. Server side only: the key must never reach a browser.
//
// The API must answer in the shape described in lib/sources/index.mjs.

/**
 * Ask the usage API for one date range.
 *
 * @param {object} query  { from, to, account_id?, provider?, agent_id? }. Dates are yyyy-mm-dd.
 *                        The API checks the query itself and answers { ok: false, reason } when it is wrong.
 * @param {object} options
 * @param {string} options.url     the API address
 * @param {string} options.key     sent in the header named by options.header
 * @param {string} [options.header]  default x-meterboard-key
 * @param {Function} [options.fetch]  fetch to use (tests pass a fake). Default: global fetch at call time.
 * @returns {Promise<object>} The parsed answer, as the API sent it.
 * @throws {Error} with a plain-language message when the URL or key is not set, the call fails,
 *   the answer is not HTTP 2xx, or the answer is not JSON. The message never holds the URL or the key.
 */
export async function readUsage(query, { url, key, header = 'x-meterboard-key', fetch = (...a) => globalThis.fetch(...a) } = {}) {
  if (!url) throw new Error('The usage API URL is not set (METERBOARD_HTTP_URL).');
  if (!key) throw new Error('The usage API key is not set (METERBOARD_HTTP_KEY).');
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [header]: key },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('The usage API did not answer.');
  }
  if (!response.ok) throw new Error(`The usage API answered HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error('The usage API sent an answer that is not JSON.');
  }
}

/** A data source over an http usage API. */
export function httpSource({ url, key, header, fetch } = {}) {
  return { name: 'http', read: (query) => readUsage(query, { url, key, header, ...(fetch ? { fetch } : {}) }) };
}
