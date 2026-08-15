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
  store.setResult(j.id, { result: { answer: 'x', sources: [] } });
  assert.equal(store.get(j.id).status, 'done');
  assert.equal(store.get(j.id).result.answer, 'x');
});
test('setResult with error marks error', () => {
  store._reset();
  const j = store.createJob({ query: 'a' });
  store.setResult(j.id, { error: 'selectors_stale' });
  assert.equal(store.get(j.id).status, 'error');
  assert.equal(store.get(j.id).error, 'selectors_stale');
});
