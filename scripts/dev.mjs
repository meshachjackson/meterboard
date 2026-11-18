// Local server for meterboard. Node built-ins only. Never deploys anything.
// Serves public/ (the page is at /usage/) and runs the same handlers as the Vercel functions in api/.
//
//   npm start          then open http://localhost:8787/usage/
//
// With no settings it uses the sample data (METERBOARD_SOURCE=fixture) and no sign-in, which is safe because
// the data is invented. Every setting is in .env.example; this script reads them from the environment only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authMode } from '../lib/auth.mjs';
import { loadConfig } from '../lib/config.mjs';
import { mcpHandler, usageHandler } from '../lib/handlers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

async function toRequest(req, base) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}

// The headers vercel.json sets (CSP and the rest), so the local check runs under the same rules as Vercel.
const vercelHeaders = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8')).headers || [];
const headersFor = (path) => Object.fromEntries(vercelHeaders.filter((h) => new RegExp(`^${h.source}$`).test(path)).flatMap((h) => h.headers.map((x) => [x.key.toLowerCase(), x.value])));

async function send(res, response, path = '') {
  res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...headersFor(path) });
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Start the server. `settings` returns a config (lib/config.mjs); by default it is read from env on each request.
 * Answers on 127.0.0.1 only unless HOST is set.
 */
export async function startServer({ port = Number(process.env.PORT) || 8787, host = process.env.HOST || '127.0.0.1', settings = () => loadConfig() } = {}) {
  const base = `http://localhost:${port}`;
  const handlers = { '/api/usage': usageHandler({ settings }), '/api/mcp': mcpHandler({ settings }) };

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, base).pathname;
      if (handlers[path]) return send(res, await handlers[path].fetch(await toRequest(req, base)), path);
      if (path === '/') return send(res, new Response(null, { status: 302, headers: { location: '/usage/' } }));
      const file = extname(path) ? path : join(path, 'index.html');   // a folder path serves its index.html, like Vercel
      const full = normalize(join(publicDir, file));
      if (!full.startsWith(publicDir + '/')) return send(res, new Response('Not found', { status: 404 }));
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store', ...headersFor(path) });
      res.end(body);
    } catch {
      send(res, new Response('Not found', { status: 404 }));
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const { mode, problem } = authMode(config);
  const port = Number(process.env.PORT) || 8787;
  await startServer({ port });
  console.log(`meterboard on http://localhost:${port}/usage/ (data: ${config.source}, sign-in: ${mode || 'not set up'}).`);
  if (!mode) console.warn(`meterboard: ${problem}`);
  if (mode === 'none' && config.source !== 'fixture') console.warn('meterboard: WARNING: no sign-in with real data. Anyone who can reach this server can read it.');
}
