// Usage dashboard page. Talks only to this site's /api/usage. It never holds a data source key: the server adds it.
// Sign-in depends on the server's auth mode (GET /api/usage?config): with cloudflare-access it happens outside this page;
// with token the page asks for the shared token once and keeps it for this tab only (sessionStorage).
// All text is set with textContent.
import { buildDashboard, buildView, DEFAULT_SETTINGS, formatMoment, formatTokens, formatUsd, formatCount, monthRanges, priorMonths, todayIn, WARN_PCT } from '/usage/view.js';

const TOKEN_KEY = 'meterboard-token';
let settings = { ...DEFAULT_SETTINGS, title: 'AI usage', timeZoneLabel: 'UTC', auth: '', signInText: 'Sign in', signOutUrl: '' };

function storedToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function storeToken(value) {
  try { if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: ask again next time */ }
}

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function setStatus(text) { $('status').textContent = text; }

function show(mode) {
  $('signin').hidden = mode !== 'signin';
  $('dashboard').hidden = mode !== 'dashboard';
  $('actions').hidden = mode !== 'dashboard';
}

async function getUsage(range) {
  const params = new URLSearchParams(range);
  const token = settings.auth === 'token' ? storedToken() : '';
  const response = await fetch(`/api/usage?${params}`, { credentials: 'same-origin', cache: 'no-store', headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (response.status === 401) return { signedOut: true };
  let body;
  try { body = await response.json(); } catch { body = { ok: false, reason: `The server answered HTTP ${response.status}.` }; }
  return body;
}

function ledger(source, lastRangeText) {
  return el('article', { class: `ledger ledger-${source.key}`, 'aria-labelledby': `ledger-${source.key}` },
    el('h3', { id: `ledger-${source.key}`, text: source.label }),
    el('p', { class: 'note', text: source.note }),
    el('p', { class: source.priced ? 'figure' : 'figure none' }, el('span', { class: 'sr', text: 'Spend this month: ' }), source.costText),
    el('p', { class: 'tokens', text: `Tokens: ${source.tokensText}` }),
    el('dl', { class: 'compare' },
      el('dt', { text: lastRangeText ? `Last month (${lastRangeText})` : 'Last month' }),
      el('dd', { text: source.lastText }),
    ),
  );
}

function limitItem(limit) {
  let meter = null;
  if (limit.hasLimit) {
    const fill = el('span', { class: 'fill' }), tick = el('span', { class: 'tick' });
    fill.style.width = `${Math.min(100, Math.max(0, limit.pct))}%`;
    tick.style.left = `${WARN_PCT}%`;
    meter = el('div', { class: 'meter', 'aria-hidden': 'true' }, fill, tick);
  }
  const amount = limit.hasLimit ? `${limit.usedText} of ${limit.totalText}` : `${limit.usedText} used`;
  return el('li', { class: `limit${limit.warn ? ' warn' : ''}${limit.hasLimit ? '' : ' nolimit'}` },
    el('div', { class: 'limit-head' },
      el('h3', { text: limit.label }),
      el('p', { class: 'amount', text: amount }),
    ),
    meter,
    el('p', { class: 'level' },
      limit.warn ? el('span', { class: 'warn-icon', 'aria-hidden': 'true', text: '!' }) : null,
      `${limit.levelText}. ${limit.sourceLabel}, as of ${limit.asOf}.`,
    ),
  );
}

// A table in a keyboard-scrollable frame, or a short note when there are no rows.
// Columns from `numericFrom` on are right-aligned numbers.
function tableOrEmpty(caption, headers, rows, emptyText, numericFrom = 1) {
  if (!rows.length) return el('p', { class: 'empty', text: emptyText });
  const align = (i) => (i >= numericFrom ? 'num' : '');
  const head = el('tr', {}, ...headers.map((h, i) => el('th', { scope: 'col', class: align(i), text: h })));
  const body = rows.map((cells) => el('tr', {}, ...cells.map((c, i) => (i === 0 ? el('th', { scope: 'row', text: c }) : el('td', { class: align(i), text: c })))));
  return el('div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': caption },
    el('table', {}, el('caption', { text: caption }), el('thead', {}, head), el('tbody', {}, ...body)));
}

// Model colors follow the model, not its rank: one fixed order across the page, folded to "Other" past five.
const MODEL_SLOTS = 5;
function modelColors(dash) {
  const names = new Set();
  for (const d of dash.daily) d.models.forEach((m) => names.add(m));
  for (const x of dash.mix) x.models.forEach((m) => names.add(m.model));
  const sorted = [...names].sort();
  return (name) => {
    const i = sorted.indexOf(name);
    return i >= 0 && i < MODEL_SLOTS ? `m${i + 1}` : 'mother';
  };
}

const pct = (v, max) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;

function paceBar(dash) {
  const max = dash.pace.scaleMax;
  const track = $('pace-track');
  const segs = dash.parts.filter((p) => p.value > 0).map((p) => {
    const seg = el('span', { class: `seg seg-${p.key}`, title: `${p.label}: ${p.valueText}` });
    seg.style.width = pct(p.value, max);
    return seg;
  });
  const rest = Math.max(0, dash.projected - dash.spent);
  const ghost = el('span', { class: 'seg seg-rest', title: `Rest of the month, projected: ${formatUsd(rest)}` });
  ghost.style.width = pct(rest, max);
  const marks = [];
  if (dash.usual !== null) {
    const usual = el('span', { class: 'mark mark-usual', title: `A usual month: ${dash.usualText}` });
    usual.style.left = pct(dash.usual, max);
    marks.push(usual);
  }
  track.replaceChildren(el('div', { class: 'pace-fill' }, ...segs, ghost), ...marks);
  track.setAttribute('role', 'img');
  track.setAttribute('aria-label', `${dash.spentText} spent so far, projected ${dash.projectedText} by month end${dash.usual !== null ? `, a usual month is ${dash.usualText}` : ''}.`);
  const zero = el('span', { text: '$0' }), end = el('span', { text: formatUsd(max) });
  $('pace-scale').replaceChildren(zero, end);
  $('pace-legend').replaceChildren(
    ...dash.parts.map((p) => el('li', {}, el('span', { class: `swatch seg-${p.key}`, 'aria-hidden': 'true' }), `${p.label} ${p.valueText}`)),
    el('li', {}, el('span', { class: 'swatch seg-rest', 'aria-hidden': 'true' }), `Projected rest of month ${formatUsd(rest)}`),
    ...(dash.usual !== null ? [el('li', {}, el('span', { class: 'swatch swatch-mark', 'aria-hidden': 'true' }), `A usual month ${dash.usualText}`)] : []),
  );
}

function renderHeadline(dash) {
  $('month-name').textContent = dash.monthName;
  $('spent').textContent = dash.spentText;
  $('per-day').textContent = dash.perDayText;
  $('per-day-note').textContent = `${dash.perDayDetail}.`;
  $('projected').textContent = dash.projectedText;
  $('projected-note').textContent = `Day ${dash.day} of ${dash.daysInMonth}, at this month's daily pace.`;
  const icon = { over: '▲', under: '▼', on: '●', none: '○' }[dash.trend.state];
  $('trend').replaceChildren(el('span', { class: 'trend-icon', 'aria-hidden': 'true', text: icon }), dash.trend.label);
  $('trend-note').textContent = dash.trend.detail;
  $('trend-tile').className = `tile tile-trend trend-${dash.trend.state}`;
  paceBar(dash);
}

function renderUsual(dash) {
  $('usual-basis').textContent = dash.usualBasis;
  const subsChecked = dash.parts.find((p) => p.key === 'subscriptions') || {};
  const items = dash.usualParts.map((p) => el('div', { class: `usual-item usual-${p.key}` },
    el('dt', {}, el('span', { class: `swatch seg-${p.key}`, 'aria-hidden': 'true' }), p.label),
    el('dd', { class: p.value === null ? 'usual-value none' : 'usual-value', text: p.valueText }),
    el('dd', { class: 'tile-note', text: p.note }),
    ...(p.key === 'subscriptions' && subsChecked.checkedText ? [el('dd', { class: subsChecked.stale ? 'tile-note price-stale' : 'tile-note', text: `${subsChecked.checkedText}.` })] : [])));
  items.push(el('div', { class: 'usual-item usual-total' },
    el('dt', { text: 'A usual month in all' }),
    el('dd', { class: dash.usual === null ? 'usual-value none' : 'usual-value', text: dash.usualText }),
    el('dd', { class: 'tile-note', text: dash.usual === null ? 'Needs one full month of bills.' : 'Subscriptions plus average metered spend.' })));
  $('usual').replaceChildren(...items);
}

function renderFlags(dash) {
  const items = dash.flags.map((f) => el('li', { class: `flag flag-${f.level}` },
    el('span', { class: 'flag-icon', 'aria-hidden': 'true', text: f.level === 'warn' ? '!' : 'i' }),
    el('div', {}, el('p', { class: 'flag-title' }, el('span', { class: 'sr', text: f.level === 'warn' ? 'Check: ' : 'Note: ' }), f.title), el('p', { class: 'flag-detail', text: f.detail }))));
  $('flags').replaceChildren(...(items.length ? items : [el('li', { class: 'empty', text: 'Nothing to cut right now.' })]));
}

function dailyChart(d, colorOf) {
  const cols = d.perDay.map((day, i) => {
    const n = i + 1;
    const stack = el('div', { class: 'stack' });
    for (const m of d.models) {
      const v = day.byModel[m] || 0;
      if (!v) continue;
      const seg = el('span', { class: `bar ${colorOf(m)}` });
      seg.style.height = pct(v, d.max);
      stack.append(seg);
    }
    const tip = day.total ? `${n}: ${formatTokens(day.total)} tokens; ${d.models.filter((m) => day.byModel[m]).map((m) => `${m} ${formatTokens(day.byModel[m])}`).join(', ')}` : `${n}: none recorded`;
    return el('div', { class: day.total ? 'col' : 'col empty-day', title: tip, tabindex: day.total ? '0' : '-1', 'aria-label': tip },
      stack, el('span', { class: n === 1 || n % 5 === 0 ? 'day-label' : 'day-label sr', text: String(n) }));
  });
  return el('figure', { class: 'daily-chart' },
    el('figcaption', {}, el('strong', { text: d.label }), ` · busiest day ${formatTokens(d.max)} tokens`),
    el('div', { class: 'cols' }, ...cols),
    el('ul', { class: 'legend' }, ...d.models.map((m) => el('li', {}, el('span', { class: `swatch ${colorOf(m)}`, 'aria-hidden': 'true' }), m))));
}

function mixList(x, colorOf) {
  const rows = x.models.map((m) => {
    const fill = el('span', { class: `bar ${colorOf(m.model)}` });
    fill.style.width = `${Math.max(0.5, m.share)}%`;
    return el('li', { class: 'mix-row' },
      el('div', { class: 'mix-head' },
        el('span', { class: 'mix-name' }, el('span', { class: `swatch ${colorOf(m.model)}`, 'aria-hidden': 'true' }), m.model, el('span', { class: `tier tier-${m.tier.toLowerCase()}`, text: m.tier })),
        el('span', { class: 'mix-share', text: `${formatCount(m.share)}%` })),
      el('div', { class: 'mix-track', 'aria-hidden': 'true' }, fill),
      el('p', { class: 'mix-detail', text: `${formatTokens(m.tokens_in)} in, ${formatTokens(m.tokens_out)} out${m.cost_usd ? `, ${formatUsd(m.cost_usd)}` : ''}` }));
  });
  return el('div', { class: 'card' }, el('h3', { class: `card-h src-${x.key}`, text: x.label }), el('ul', { class: 'mix' }, ...rows));
}

function render(view, dash) {
  $('range').textContent = `${view.rangeText}, ${settings.timeZoneLabel}. Updated ${formatMoment(new Date(), settings.timeZone)}.`;
  renderHeadline(dash);
  renderUsual(dash);
  renderFlags(dash);
  const colorOf = modelColors(dash);
  $('daily').replaceChildren(...(dash.daily.length ? dash.daily.map((d) => dailyChart(d, colorOf)) : [el('p', { class: 'empty', text: 'No tokens recorded this month.' })]));
  $('platforms').replaceChildren(tableOrEmpty('Accounts', ['Platform', 'Plan', 'Kind', 'Monthly fee', 'Price checked', 'Billed this month', 'Worth at API rates', 'Tokens this month'],
    dash.accounts.map((a) => [a.provider, a.plan || 'not set', a.kindText, a.feeText, a.priceText, a.billedText || '', a.apiValue ? `${a.apiValue.rangeText} (${a.apiValue.ratioText} fee)` : '', a.tokensText || (a.used ? 'readings only' : 'no usage recorded')]), 'No accounts yet.', 3));
  $('models').replaceChildren(...(dash.mix.length ? dash.mix.map((x) => mixList(x, colorOf)) : [el('p', { class: 'empty', text: 'No model usage this month.' })]));
  $('agents').replaceChildren(...view.sources.map((s) => tableOrEmpty(s.label, ['Agent', 'Tokens in', 'Tokens out', 'Spend', 'Days used'], s.agentRows, `${s.label}: no agent usage this month.`)));
  $('ledgers').replaceChildren(...view.sources.map((s) => ledger(s, view.lastRangeText)));
  $('limits').replaceChildren(...(view.limits.length ? view.limits.map(limitItem) : [el('li', { class: 'empty', text: 'No limit readings this month.' })]));
}

async function loadSettings() {
  try {
    const token = storedToken();
    const response = await fetch('/api/usage?config', { credentials: 'same-origin', cache: 'no-store', headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (response.ok) settings = { ...settings, ...(await response.json()) };
  } catch { /* keep the defaults */ }
  document.title = settings.title;
  $('title').textContent = settings.title;
  $('signin-link').textContent = settings.signInText;
  $('signin-link-row').hidden = settings.auth === 'token';
  $('token-form').hidden = settings.auth !== 'token';
  $('signout').hidden = !settings.signOutUrl && settings.auth !== 'token';
  if (settings.signOutUrl) $('signout').setAttribute('href', settings.signOutUrl);
}

async function load() {
  setStatus('Loading the figures.');
  const shown = { timeZone: settings.timeZone, limits: settings.limits };
  const today = todayIn(new Date(), settings.timeZone);
  const { thisMonth } = monthRanges(today);
  const prior = priorMonths(today, 3);
  let current, history;
  try {
    [current, ...history] = await Promise.all([getUsage(thisMonth), ...prior.map((r) => getUsage(r).catch(() => ({ ok: false })))]);
  } catch {
    setStatus('Could not reach the server. Check the connection, then choose Refresh.');
    return;
  }
  if (current.signedOut) {
    const refused = settings.auth === 'token' && storedToken();
    if (refused) storeToken('');
    show('signin');
    $('range').textContent = 'Sign in to see the figures.';
    setStatus(refused ? 'That token did not work. Check it and try again.' : '');
    $('main').focus();
    return;
  }
  show('dashboard');
  if (!current.ok) {
    setStatus(`The figures did not load: ${current.reason || 'no reason given'}. Choose Refresh to try again.`);
    return;
  }
  const previous = history[0] || { ok: false };
  render(buildView(current, previous, shown), buildDashboard(current, history, today, shown));
  const notes = [];
  if (!previous.ok) notes.push(`Last month did not load: ${previous.reason || 'no reason given'}.`);
  if (current.rows_cut) notes.push('The data source cut this month\'s rows, so per-day and per-agent figures are incomplete. Totals are whole.');
  setStatus(notes.join(' '));
}

$('refresh').addEventListener('click', load);
$('token-form').addEventListener('submit', (event) => {
  event.preventDefault();
  storeToken($('token').value.trim());
  $('token').value = '';
  loadSettings().then(load);
});
$('signout').addEventListener('click', (event) => {
  if (settings.auth !== 'token') return;
  event.preventDefault();
  storeToken('');
  load();
});

loadSettings().then(load);
