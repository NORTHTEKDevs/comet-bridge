const assert = require('node:assert');
const { test } = require('node:test');
const store = require('../relay/store');

test('createJob accepts a non-query read job', () => {
  store._reset();
  const job = store.createJob({ kind: 'read', payload: { url: 'https://mail.google.com', target: 'page' } });
  assert.equal(job.kind, 'read');
  const next = store.claimNext();
  assert.equal(next.kind, 'read');
  assert.equal(next.payload.target, 'page');
});
