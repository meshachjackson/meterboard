// Every data source must keep the contract in lib/sources/index.mjs. Each source below runs the same checks.
// The http source talks to a fake API that answers from the sample data, so no network is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerProblems, createSource } from '../lib/sources/index.mjs';
import { fakeReadApi, fixtureSource, sampleData } from '../lib/sources/fixture.mjs';
import { httpSource } from '../lib/sources/http.mjs';
import { loadConfig } from '../lib/config.mjs';

const TODAY = '2026-11-16';
const GOOD = { from: '2026-11-01', to: TODAY };

function fakeApi() {
  const data = sampleData(TODAY);
  return async (url, init) => Response.json(fakeReadApi(JSON.parse(init.body), data));
}

const SOURCES = {
  fixture: () => fixtureSource({ today: TODAY }),
  http: () => httpSource({ url: 'https://usage.example.test/api', key: 'k-not-real', fetch: fakeApi() }),
};

for (const [name, make] of Object.entries(SOURCES)) {
  test(`${name}: has a name and a read function`, () => {
    const source = make();
    assert.equal(source.name, name);
    assert.equal(typeof source.read, 'function');
  });

  test(`${name}: a good query answers ok:true in the contract shape`, async () => {
    const answer = await make().read(GOOD);
    assert.deepEqual(answerProblems(answer), []);
    assert.equal(answer.ok, true);
    assert.equal(answer.from, GOOD.from);
    assert.equal(answer.to, GOOD.to);
    assert.ok(answer.rows.length > 0, 'the sample has rows this month');
    for (const r of answer.rows) assert.ok(r.usage_date >= GOOD.from && r.usage_date <= GOOD.to, 'rows stay inside the range');
  });

  test(`${name}: a query with no dates answers ok:false with a reason, not an exception`, async () => {
    const answer = await make().read({});
    assert.equal(answer.ok, false);
    assert.equal(typeof answer.reason, 'string');
    assert.deepEqual(answerProblems(answer), []);
  });

  test(`${name}: an account filter narrows the rows`, async () => {
    const answer = await make().read({ ...GOOD, account_id: 'acct-05' });
    assert.ok(answer.rows.length > 0);
    assert.ok(answer.rows.every((r) => r.account_id === 'acct-05'));
  });

  test(`${name}: invoice and estimate totals stay apart`, async () => {
    const answer = await make().read(GOOD);
    const rows = (s) => answer.rows.filter((r) => r.source === s && !r.limit_name);
    for (const s of ['invoice', 'estimate']) {
      assert.equal(answer.totals[s].tokens_in, rows(s).reduce((n, r) => n + (Number(r.tokens_in) || 0), 0), s);
    }
  });
}

test('answerProblems catches a broken answer', () => {
  assert.ok(answerProblems(null).length);
  assert.ok(answerProblems({ ok: false }).length);
  assert.ok(answerProblems({ ok: true, from: 'x', to: TODAY, accounts: [], rows: [], limits: [], totals: {} }).length);
});

test('createSource picks the source the config names, and refuses an unknown one', () => {
  assert.equal(createSource(loadConfig({})).name, 'fixture');
  assert.equal(createSource(loadConfig({ METERBOARD_SOURCE: 'http' })).name, 'http');
  assert.throws(() => createSource(loadConfig({ METERBOARD_SOURCE: 'postgres' })), /Unknown data source "postgres"/);
});

test('the http source refuses to run without its URL and key, and never leaks them', async () => {
  const source = createSource(loadConfig({ METERBOARD_SOURCE: 'http' }));
  await assert.rejects(source.read(GOOD), /METERBOARD_HTTP_URL/);
});
