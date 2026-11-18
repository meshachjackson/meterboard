// Settings for meterboard, read from environment variables. Node built-ins only.
// Every name is listed, with a placeholder, in .env.example. A deployment can also pass `defaults`
// (for example from its own instance file); an environment variable that is set always wins.
import { FIXTURE_LIMITS } from './sources/fixture.mjs';

export const AUTH_MODES = ['cloudflare-access', 'token', 'none'];
export const SOURCE_NAMES = ['fixture', 'http'];

let warnedLimits = false;
function parseLimits(text) {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    if (!warnedLimits) console.warn('meterboard: METERBOARD_LIMITS is not valid JSON; it is ignored.');
    warnedLimits = true;
    return {};
  }
}

/**
 * The settings, from env first, then `defaults`, then the built-in default.
 * @param {object} [env]       process.env by default
 * @param {object} [defaults]  same keys as the result (http settings as httpUrl, httpKey, httpKeyHeader)
 */
export function loadConfig(env = process.env, defaults = {}) {
  const pick = (name, key, fallback = '') => {
    const v = env[name];
    if (v !== undefined && v !== '') return String(v).trim();
    const d = defaults[key];
    return d !== undefined && d !== null && d !== '' ? d : fallback;
  };
  const source = String(pick('METERBOARD_SOURCE', 'source', 'fixture')).toLowerCase();
  const auth = String(pick('METERBOARD_AUTH', 'auth', '')).toLowerCase();
  const timeZone = pick('METERBOARD_TIME_ZONE', 'timeZone', 'UTC');
  return {
    source,
    auth,
    token: pick('METERBOARD_TOKEN', 'token'),
    mcpToken: pick('METERBOARD_MCP_TOKEN', 'mcpToken'),
    http: {
      url: pick('METERBOARD_HTTP_URL', 'httpUrl'),
      key: pick('METERBOARD_HTTP_KEY', 'httpKey'),
      header: pick('METERBOARD_HTTP_KEY_HEADER', 'httpKeyHeader', 'x-meterboard-key'),
    },
    fixture: pick('METERBOARD_FIXTURE', 'fixture', 'full'),
    timeZone,
    timeZoneLabel: pick('METERBOARD_TIME_ZONE_LABEL', 'timeZoneLabel', timeZone),
    title: pick('METERBOARD_TITLE', 'title', 'AI usage'),
    mcpName: pick('METERBOARD_MCP_NAME', 'mcpName', 'meterboard'),
    signInText: pick('METERBOARD_SIGN_IN_TEXT', 'signInText', 'Sign in'),
    signOutUrl: pick('METERBOARD_SIGN_OUT_URL', 'signOutUrl', auth === 'cloudflare-access' ? '/cdn-cgi/access/logout' : ''),
    limits: parseLimits(env.METERBOARD_LIMITS) ?? defaults.limits ?? (source === 'fixture' ? FIXTURE_LIMITS : {}),
  };
}

/** What the page needs to sign someone in. Answered to anyone, so it holds nothing about the data. */
export function signInSettings(config) {
  return {
    title: config.title,
    auth: config.auth || (config.source === 'fixture' ? 'none' : ''),
    signInText: config.signInText,
    signOutUrl: config.signOutUrl,
  };
}

/** What the page may know once signed in. Never holds a URL, key, token, team, audience or email. */
export function pageSettings(config) {
  return { ...signInSettings(config), timeZone: config.timeZone, timeZoneLabel: config.timeZoneLabel, limits: config.limits };
}

/** The settings the shared view code (public/usage/view.js) takes. */
export const viewSettings = (config) => ({ timeZone: config.timeZone, limits: config.limits });
