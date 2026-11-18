// The two server functions, as fetch handlers (Request in, Response out). Node built-ins only.
// api/usage.mjs and api/mcp.mjs export them with settings from env; a deployment can pass its own settings function.
import { bearerMatches, checkRequest } from './auth.mjs';
import { loadConfig, pageSettings, signInSettings, viewSettings } from './config.mjs';
import { json } from './http.mjs';
import { createSource } from './sources/index.mjs';
import { HANDLERS, toolList } from './usage-tools.mjs';

const QUERY_KEYS = ['from', 'to', 'account_id', 'provider', 'agent_id'];

/**
 * GET /api/usage?from=yyyy-mm-dd&to=yyyy-mm-dd[&account_id=&provider=&agent_id=]
 *   Signed-in only (see lib/auth.mjs). Answers the source's JSON as is (including { ok: false, reason }),
 *   401 when not signed in, 503 when sign-in is not set up, 502 when the source fails.
 * GET /api/usage?config
 *   The page's settings. Signed in: pageSettings (time zone, limit labels). Not signed in: only signInSettings,
 *   what the page needs to show the sign-in step. Neither holds a secret.
 * @param {object} [options]
 * @param {() => object} [options.settings]  returns a config (lib/config.mjs). Called per request.
 */
export function usageHandler({ settings = () => loadConfig() } = {}) {
  return {
    async fetch(request) {
      if (request.method !== 'GET') return json({ ok: false, reason: 'Use GET.' }, 405, { allow: 'GET' });
      const config = settings();
      const params = new URL(request.url).searchParams;
      const access = await checkRequest(request, config);
      if (params.has('config')) return json(access.ok ? pageSettings(config) : signInSettings(config));
      if (!access.ok) {
        if (access.setup) return json({ ok: false, reason: access.reason }, 503);
        return json({ ok: false, reason: `${config.signInText} first.` }, 401);
      }
      const query = {};
      for (const k of QUERY_KEYS) if (params.has(k)) query[k] = params.get(k);
      try {
        return json(await createSource(config).read(query));
      } catch (error) {
        return json({ ok: false, reason: error.message }, 502);
      }
    },
  };
}

// Read-only MCP server, Streamable HTTP, JSON answers only (no SSE, no sessions).
// POST /api/mcp takes one JSON-RPC 2.0 message, behind Authorization: Bearer <METERBOARD_MCP_TOKEN>.
// With no token set, every request is refused. Written by hand with Node built-ins.
// Legacy protocol only (initialize handshake, spec 2025-11-25 and earlier). The 2026-07-28 revision (no handshake,
// server/discover, per-request _meta and headers) is not implemented; its clients fall back to initialize on a 400.
// No Origin check: the bearer token is required first, so a rebinding page cannot call a tool without it.
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 64 * 1024;

const failure = (id, code, message, status = 200) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status);

async function call(message, config) {
  switch (message.method) {
    case 'initialize': {
      const asked = message.params?.protocolVersion;
      return { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: config.mcpName, title: config.title, version: '0.1.0' } };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: toolList(config.timeZoneLabel) };
    case 'tools/call': {
      const handler = Object.hasOwn(HANDLERS, message.params?.name) ? HANDLERS[message.params.name] : null;
      if (!handler) throw Object.assign(new Error(`Unknown tool: ${message.params?.name}`), { code: -32602 });
      const args = message.params.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('arguments must be an object'), { code: -32602 });
      let source;
      try { source = createSource(config); } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
      return handler(args, { read: (q) => source.read(q), settings: viewSettings(config), zoneLabel: config.timeZoneLabel });
    }
    default: throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
  }
}

/** POST /api/mcp. Same options as usageHandler. */
export function mcpHandler({ settings = () => loadConfig() } = {}) {
  return {
    async fetch(request) {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, { allow: 'POST' });
      const config = settings();
      if (!bearerMatches(request, config.mcpToken)) return json({ error: 'Unauthorized.' }, 401, { 'www-authenticate': 'Bearer' });
      const text = await request.text();
      if (text.length > MAX_BODY) return failure(null, -32600, 'Request is too large.', 413);
      let message;
      try { message = JSON.parse(text); } catch { return failure(null, -32700, 'Parse error: the body is not JSON.', 400); }
      if (Array.isArray(message)) return failure(null, -32600, 'Send one message per request, not a batch.', 400);
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return failure(null, -32600, 'Not a JSON-RPC 2.0 message.', 400);
      // An unsupported MCP-Protocol-Version header is a 400 (spec 2025-11-25). initialize negotiates in its body instead.
      const asked = request.headers.get('mcp-protocol-version');
      if (asked && !VERSIONS.includes(asked) && message.method !== 'initialize') return failure(message.id, -32600, `Unsupported MCP-Protocol-Version. Supported: ${VERSIONS.join(', ')}.`, 400);
      // A notification (no id) or a client response (no method): accepted, no body.
      if (message.id === undefined || typeof message.method !== 'string') return new Response(null, { status: 202 });
      try {
        const result = await call(message, config);
        return json({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        const code = error.code === -32601 || error.code === -32602 ? error.code : -32603;
        return failure(message.id, code, code === -32603 ? 'Internal error.' : error.message, 200);
      }
    },
  };
}
