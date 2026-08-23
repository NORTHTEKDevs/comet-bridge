const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../relay/store');

test('createJob returns a pending job with id and query', () => {
  store._reset();
  const job = store.createJob({ query: 'hello', mode: 'search' });
  assert.equal(job.status, 'pending');
  assert.equal(job.query, 'hello');
  assert.ok(job.id);
});
test('job ids are UUIDs, not sequential integers', () => {
  store._reset();
  const a = store.createJob({ query: 'a' });
  const b = store.createJob({ query: 'b' });
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(a.id, UUID_RE);
  assert.match(b.id, UUID_RE);
  assert.notEqual(a.id, b.id);
});
test('claimNext flips pending to claimed, then returns null', () => {
  store._reset();
  store.createJob({ query: 'a' });
  const first = store.claimNext();
  assert.equal(first.status, 'claimed');
  assert.equal(store.claimNext(), null);
});
test('setResult marks done and stores result', () => {
  store._reset();
  const j = store.createJob({ query: 'a' });
  store.claimNext();
  store.setResult(j.id, { result: { answer: 'x', sources: [] } });
  assert.equal(store.get(j.id).status, 'done');
  assert.equal(store.get(j.id).result.answer, 'x');
});
test('setResult with error marks error', () => {
  store._reset();
  const j = store.createJob({ query: 'a' });
  store.claimNext();
  store.setResult(j.id, { error: 'selectors_stale' });
  assert.equal(store.get(j.id).status, 'error');
  assert.equal(store.get(j.id).error, 'selectors_stale');
});
test('setResult rejects results for jobs that were never claimed', () => {
  store._reset();
  const j = store.createJob({ query: 'a' });
  assert.equal(store.setResult(j.id, { result: { answer: 'x' } }), null);
  assert.equal(store.get(j.id).status, 'pending');   // untouched
  assert.equal(store.get(j.id).result, null);
});
test('setResult rejects overwriting an already-finished job', () => {
  store._reset();
  const j = store.createJob({ query: 'a' });
  store.claimNext();
  store.setResult(j.id, { result: 'first' });
  assert.equal(store.setResult(j.id, { result: 'second' }), null);
  assert.equal(store.setResult(j.id, { error: 'late' }), null);
  assert.equal(store.get(j.id).status, 'done');      // still done, original result intact
  assert.equal(store.get(j.id).result, 'first');
});
test('claimed jobs older than CLAIM_TTL_MS become claimable again', () => {
  store._reset();
  const j = store.createJob({ query: 'a' });
  store.claimNext(1000);                              // injectable clock for determinism
  assert.equal(store.claimNext(1000 + store.CLAIM_TTL_MS - 1), null); // lease still held
  const again = store.claimNext(1000 + store.CLAIM_TTL_MS + 1);
  assert.ok(again, 'expired claim was not requeued');
  assert.equal(again.id, j.id);
  assert.equal(again.status, 'claimed');
});
test('done jobs beyond DONE_CAP are evicted, newest kept', () => {
  store._reset();
  const ids = [];
  const now = Date.now();
  for (let i = 0; i < 505; i++) {
    const j = store.createJob({ query: 'q' });
    store.claimNext(now);
    store.setResult(j.id, { result: i });
    ids.push(j.id);
  }
  assert.equal(store.get(ids[0]), null);              // oldest done job evicted
  assert.equal(store.get(ids[504]).result, 504);      // newest kept
  assert.equal(store._size(), store.DONE_CAP);
});
