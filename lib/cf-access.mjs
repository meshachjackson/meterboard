// Cloudflare Access check (auth mode cloudflare-access). Node built-ins only.
// Cloudflare signs in the visitor with your identity provider, then adds a signed token (JWT, RS256) to each request it forwards:
// the `Cf-Access-Jwt-Assertion` header, and the `CF_Authorization` cookie. This file checks that token, so a request
// that reached the app without passing Cloudflare (for example on the host's own default address) is refused.
//
// Env (all three required; if any is unset, everyone is refused):
//   CF_ACCESS_TEAM_DOMAIN     the team address, e.g. your-team.cloudflareaccess.com
//   CF_ACCESS_AUD             the Access application's audience tag; several may be given, comma separated
//   CF_ACCESS_ALLOWED_EMAILS  the email addresses let in, comma separated
import { createPublicKey, verify } from 'node:crypto';

const KEY_CACHE_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;
const keyCache = new Map(); // team domain -> { at, keys: Map(kid -> KeyObject) }

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** The settings from env, or null when any is missing (fail closed). */
export function accessConfig(env = process.env) {
  const team = String(env.CF_ACCESS_TEAM_DOMAIN || '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  const auds = list(env.CF_ACCESS_AUD);
  const emails = list(env.CF_ACCESS_ALLOWED_EMAILS);
  if (!team || !auds.length || !emails.length) return null;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) return null;
  return { team, auds, emails };
}

/** Download the team's public signing keys (cached for an hour). */
export async function fetchKeys(team, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const hit = keyCache.get(team);
  if (hit && now - hit.at < KEY_CACHE_MS) return hit.keys;
  const response = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access keys answered HTTP ${response.status}`);
  const body = await response.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
  }
  keyCache.set(team, { at: now, keys });
  return keys;
}

export const clearKeyCache = () => keyCache.clear();

const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/**
 * Check one Access token. Answers { ok: true, email } or { ok: false, reason }.
 * Checks: RS256 signature by a current team key, issuer, audience, expiry, not-before, and the email allowlist.
 */
export async function verifyAccessToken(token, { env = process.env, now = Date.now(), fetchImpl } = {}) {
  const config = accessConfig(env);
  if (!config) return { ok: false, reason: 'Access check is not set up on the server.' };
  if (typeof token !== 'string') return { ok: false, reason: 'No Access token.' };
  const pieces = token.split('.');
  if (pieces.length !== 3) return { ok: false, reason: 'Malformed Access token.' };
  let header, claims;
  try { header = part(pieces[0]); claims = part(pieces[1]); } catch { return { ok: false, reason: 'Malformed Access token.' }; }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'Unexpected token type.' };

  let keys;
  try { keys = await fetchKeys(config.team, { fetchImpl, now }); } catch (error) { return { ok: false, reason: error.message }; }
  const key = keys.get(header.kid);
  if (!key) return { ok: false, reason: 'Unknown signing key.' };
  const signed = Buffer.from(`${pieces[0]}.${pieces[1]}`);
  if (!verify('RSA-SHA256', signed, key, Buffer.from(pieces[2], 'base64url'))) return { ok: false, reason: 'Bad signature.' };

  const nowS = Math.floor(now / 1000);
  if (claims.iss !== `https://${config.team}`) return { ok: false, reason: 'Wrong issuer.' };
  const auds = (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).map((a) => String(a).toLowerCase());
  if (!auds.some((a) => config.auds.includes(a))) return { ok: false, reason: 'Wrong audience.' };
  if (!(Number(claims.exp) + CLOCK_SKEW_S > nowS)) return { ok: false, reason: 'Access token expired.' };
  if (claims.nbf !== undefined && Number(claims.nbf) - CLOCK_SKEW_S > nowS) return { ok: false, reason: 'Access token not valid yet.' };
  const email = String(claims.email || '').toLowerCase();
  if (!email || !config.emails.includes(email)) return { ok: false, reason: 'This account is not allowed.' };
  return { ok: true, email };
}

/** The Access token on a request: the header Cloudflare adds, or the CF_Authorization cookie. */
export function accessToken(request) {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header.trim();
  const cookie = (request.headers.get('cookie') || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('CF_Authorization='));
  return cookie ? cookie.slice('CF_Authorization='.length) : undefined;
}

/** { ok, email | reason } for a request. */
export const checkRequest = (request, options) => verifyAccessToken(accessToken(request), options);
