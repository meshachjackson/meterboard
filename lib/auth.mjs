// Who may read the dashboard API. One mode per deployment, set by METERBOARD_AUTH:
//
//   cloudflare-access  Cloudflare Access signs people in and adds a signed token to each request.
//                      lib/cf-access.mjs checks it (CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, CF_ACCESS_ALLOWED_EMAILS).
//   token              a shared secret (METERBOARD_TOKEN). The page asks for it once and sends it as
//                      Authorization: Bearer <token>. Fine for one person; anyone with the token sees everything.
//   none               no check at all. WARNING: anyone who can reach the server reads your usage.
//                      Only for the built-in sample data, or a server on your own machine.
//
// Fails closed: with no mode set, only the sample data (METERBOARD_SOURCE=fixture) is served without a check.
// A real data source with no mode, or an unknown mode, refuses every request.
import { createHash, timingSafeEqual } from 'node:crypto';
import { AUTH_MODES } from './config.mjs';
import { checkRequest as checkAccess } from './cf-access.mjs';

/** { mode } or { mode: null, problem } for a config. */
export function authMode(config) {
  if (config.auth) {
    if (AUTH_MODES.includes(config.auth)) return { mode: config.auth };
    return { mode: null, problem: `METERBOARD_AUTH must be one of ${AUTH_MODES.join(', ')}.` };
  }
  if (config.source === 'fixture') return { mode: 'none' };
  return { mode: null, problem: 'Sign-in is not set up: set METERBOARD_AUTH before serving real data.' };
}

// Hash both sides to the same length first: timingSafeEqual throws on unequal lengths.
const digest = (text) => createHash('sha256').update('meterboard-token:' + text).digest();

/** True when `Authorization: Bearer <secret>` matches `secret` (constant-time). An empty secret matches nothing. */
export function bearerMatches(request, secret) {
  if (!secret) return false;
  const match = /^Bearer +(\S+)$/i.exec(request.headers.get('authorization') || '');
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(secret));
}

let warned = false;

/**
 * Check one dashboard request.
 * @returns {Promise<{ ok: true, mode, email? } | { ok: false, mode, reason, setup?: true }>}
 *   setup: true means the server is not set up (answer 503), otherwise the visitor is not signed in (answer 401).
 */
export async function checkRequest(request, config, options) {
  const { mode, problem } = authMode(config);
  if (!mode) return { ok: false, mode, reason: problem, setup: true };
  if (mode === 'none') {
    if (config.source !== 'fixture' && !warned) {
      warned = true;
      console.warn('meterboard: WARNING: METERBOARD_AUTH=none with real data. Anyone who can reach this server can read it.');
    }
    return { ok: true, mode };
  }
  if (mode === 'token') {
    if (!config.token) return { ok: false, mode, reason: 'METERBOARD_TOKEN is not set.', setup: true };
    return bearerMatches(request, config.token) ? { ok: true, mode } : { ok: false, mode, reason: 'Wrong or missing token.' };
  }
  const access = await checkAccess(request, options);
  return { ...access, mode };
}
