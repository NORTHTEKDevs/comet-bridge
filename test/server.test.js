const { test, before, after } = require('node:test');
const assert = require('node:assert');
process.env.BRIDGE_TOKEN = 'testtoken';
process.env.BRIDGE_EXT_ORIGIN = 'chrome-extension://testid';
const { server } = require('../relay/server');
const store = require('../relay/store');
let base;
before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const H = { 'content-type': 'application/json', 'x-bridge-token': 'testtoken' };
test('rejects missing token with 401', async () => {
  const res = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"x"}' });
  assert.equal(res.status, 401);
});
test('full job lifecycle', async () => {
  store._reset();
  let res = await fetch(`${base}/jobs`, { method: 'POST', headers: H, body: JSON.stringify({ query: 'capital of france', mode: 'search' }) });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  res = await fetch(`${base}/jobs/next`, { headers: H });
  assert.equal(res.status, 200);
  const claimed = await res.json();
  assert.equal(claimed.id, id);
  assert.equal(claimed.query, 'capital of france');
  res = await fetch(`${base}/jobs/${id}/result`, { method: 'POST', headers: H, body: JSON.stringify({ result: { answer: 'Paris', sources: [{ title: 'a', url: 'http://a' }] } }) });
  assert.equal(res.status, 200);
  res = await fetch(`${base}/jobs/${id}`, { headers: H });
  const final = await res.json();
  assert.equal(final.status, 'done');
  assert.equal(final.result.answer, 'Paris');
});
test('next returns 204 when queue empty', async () => {
  store._reset();
  const res = await fetch(`${base}/jobs/next`, { headers: H });
  assert.equal(res.status, 204);
});
