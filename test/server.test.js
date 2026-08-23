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
test('wrong-length token is a plain 401, not a thrown error (timing-safe compare guard)', async () => {
  const res = await fetch(`${base}/jobs/next`, { headers: { 'x-bridge-token': 'x' } });
  assert.equal(res.status, 401);
});
test('equal-length wrong token is still 401', async () => {
  const res = await fetch(`${base}/jobs/next`, { headers: { 'x-bridge-token': 'aaaaaaaaa' } });
  assert.equal(res.status, 401);
});
test('result for unclaimed job is 409, unknown id stays 404', async () => {
  store._reset();
  let res = await fetch(`${base}/jobs`, { method: 'POST', headers: H, body: '{"query":"x"}' });
  const { id } = await res.json();
  res = await fetch(`${base}/jobs/${id}/result`, { method: 'POST', headers: H, body: '{"result":{"a":1}}' });
  assert.equal(res.status, 409);                    // job exists but was never claimed
  res = await fetch(`${base}/jobs/00000000-0000-4000-8000-000000000000/result`, { method: 'POST', headers: H, body: '{"result":{}}' });
  assert.equal(res.status, 404);                    // no such job at all
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

test('oversized POST body is rejected instead of buffered unbounded', async () => {
  store._reset();
  const big = JSON.stringify({ query: 'x'.repeat(1024 * 1024 + 100) });
  let rejected = false;
  let res;
  try { res = await fetch(`${base}/jobs`, { method: 'POST', headers: H, body: big }); }
  catch { rejected = true; }                       // connection destroyed mid-upload is acceptable
  if (!rejected) assert.notEqual(res.status, 201); // and so is any non-201 answer
  const ok = await fetch(`${base}/jobs`, { method: 'POST', headers: H, body: '{"query":"ok"}' });
  assert.equal(ok.status, 201);                    // server still serves normal-sized requests
});
