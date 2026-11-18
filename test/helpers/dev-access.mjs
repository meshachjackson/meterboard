// A throwaway stand-in for Cloudflare Access, for tests and the local check server. Never used in production.
// Makes a fresh RSA key pair each run, answers the certs URL with its public key, and signs tokens like Access does.
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

export function makeDevAccess({ team = 'dev-check.cloudflareaccess.com', email = 'someone@example.test' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(8).toString('hex');
  const aud = randomBytes(16).toString('hex');
  const env = { CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: aud, CF_ACCESS_ALLOWED_EMAILS: email };
  const certsUrl = `https://${team}/cdn-cgi/access/certs`;
  const certs = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] };

  /** Sign a token. `claims` overrides the defaults; `key` swaps the signing key (to test a forged token). */
  function sign(claims = {}, { key = privateKey, keyId = kid } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: keyId, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: `https://${team}`, aud: [aud], email, iat: now, nbf: now, exp: now + 3600, sub: 'dev', ...claims })).toString('base64url');
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
    return `${head}.${body}.${signature}`;
  }

  /** A fetch that answers the certs URL and hands everything else to `next`. */
  const wrapFetch = (next) => async (url, init) => (String(url) === certsUrl ? Response.json(certs) : next(url, init));

  return { env, team, aud, email, kid, certsUrl, certs, sign, wrapFetch };
}
