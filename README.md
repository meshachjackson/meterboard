# meterboard

See what you spend on AI in one place: subscriptions, metered bills, tokens and limits.

meterboard is a small dashboard and a read-only MCP server. It shows what you have spent so far this month,
where the month is heading, what a usual month costs and where you could cut. Bills (what a provider charged)
and your own token counts are kept apart and never added together.

It is one static page plus two server functions, written with Node built-ins only. There is nothing to install.

## Try it

You need Node 20 or newer.

```sh
npm start
```

Then open http://localhost:8787/usage/. With no settings, meterboard shows invented sample data and asks no one to
sign in. The sample data is safe to show; nothing about you is in it.

Run the tests:

```sh
npm test
```

## Use your own data

meterboard reads usage through a **data source**. Two come with it:

| Source | Set `METERBOARD_SOURCE` to | What it does |
|---|---|---|
| Sample data | `fixture` (the default) | Invented accounts, plans, tokens and limits, dated from today. |
| Your own API | `http` | POSTs each query as JSON to `METERBOARD_HTTP_URL`, with `METERBOARD_HTTP_KEY` in a header, and shows the answer. |

The answer shape is written out in [`lib/sources/index.mjs`](lib/sources/index.mjs). Any API that answers in that
shape works: a small server over your billing exports, a workflow tool's webhook or a database view.

To add a different source, write `lib/sources/<name>.mjs`, register it in `lib/sources/index.mjs` and make it pass
`test/source-contract.test.mjs`.

## Sign-in

Set one mode with `METERBOARD_AUTH`:

| Mode | Who gets in | Use it for |
|---|---|---|
| `cloudflare-access` | People your Cloudflare Access app lets in. meterboard checks the signed token on every request. | A public address. |
| `token` | Anyone who types the shared token (`METERBOARD_TOKEN`) into the page. The page keeps it for that tab only. | Just you, or a small team. |
| `none` | Everyone. | The sample data, or a server only you can reach. |

**Warning:** `none` with real data lets anyone who can reach the server read your usage. meterboard prints a
warning when you run it that way.

meterboard fails closed. If you point it at real data and set no mode, or a mode it does not know, it refuses every
request with a message saying what to set. In `token` mode with no token set, nobody gets in.

`token` mode is a shared secret, not accounts. Anyone who has it sees everything, so make it long and random
(`openssl rand -hex 32`), serve the page over HTTPS only, and change it if it leaks.

## MCP server

`POST /api/mcp` is a read-only MCP server (Streamable HTTP, JSON answers) with two tools:

- `usage_summary`: totals from bills and from your own count, the top accounts, agents and models, and every limit
  at or past 80%, for this month, last month or the last 7 days.
- `usage_query`: the source's answer for any date range, with up to 200 rows.

Clients send `Authorization: Bearer <METERBOARD_MCP_TOKEN>`. With no token set, the server refuses everyone.

## Settings

Every setting is listed, with a placeholder, in [`.env.example`](.env.example). Set them in your host's environment
settings, never in the repository. The most common ones:

| Name | What it does |
|---|---|
| `METERBOARD_SOURCE` | `fixture` or `http`. |
| `METERBOARD_AUTH` | `cloudflare-access`, `token` or `none`. |
| `METERBOARD_TIME_ZONE` | Where "today" and month edges fall, for example `Europe/Berlin`. Default `UTC`. |
| `METERBOARD_LIMITS` | Labels for your limit names, as JSON. Mark a limit `"hosting": true` to count its bill readings as hosting spend. |

## Deploy

meterboard is laid out for Vercel: `vercel.json` serves `public/` and turns `api/` into functions. (The standalone tree has not been deployed on its own yet; the same code runs today inside a private deployment.) Any host that
serves static files and runs fetch-style handlers (`export default { fetch(request) }`) works too; `scripts/dev.mjs`
shows the wiring in about 60 lines.

Before you deploy with real data, set a sign-in mode. Check that `/api/usage` answers 401 when you are signed out.

## Layout

- `public/usage/`: the page. `view.js` turns answers into what the page shows and is shared with the server.
- `api/`: the two server functions.
- `lib/`: settings, sign-in, data sources, the MCP tools.
- `scripts/dev.mjs`: the local server.
- `test/`: the tests, run with `node --test`.

## License

MIT. See [LICENSE](LICENSE).
