// Task 36: prove the existing generic `kind`/`payload` job shape (relay/store.js, relay/server.js)
// round-trips a `kind: "inspect"` job exactly like it already does for `read` (see
// relay-read.test.js) - no relay-side special-casing should be needed for a new job kind.
const assert = require('node:assert');
const { test, before, after } = require('node:test');
const store = require('../relay/store');

test('createJob accepts a kind:"inspect" job with the inspect payload shape', () => {
  store._reset();
  const job = store.createJob({
    kind: 'inspect',
    payload: { kinds: ['source', 'console'], name: 'target', allowCookies: false, noRedact: false }
  });
  assert.equal(job.kind, 'inspect');
  assert.deepEqual(job.payload.kinds, ['source', 'console']);
  const next = store.claimNext();
  assert.equal(next.kind, 'inspect');
  assert.equal(next.payload.name, 'target');
  assert.equal(next.payload.allowCookies, false);
});

test('existing read and query jobs still round-trip alongside inspect', () => {
  store._reset();
  const readJob = store.createJob({ kind: 'read', payload: { url: 'https://mail.google.com', target: 'page' } });
  assert.equal(readJob.kind, 'read');
  const queryJob = store.createJob({ query: 'capital of france', mode: 'search' });
  assert.equal(queryJob.kind, 'query');
  const first = store.claimNext();
  assert.equal(first.id, readJob.id);
  const second = store.claimNext();
  assert.equal(second.id, queryJob.id);
});

test('full HTTP lifecycle: dispatch an inspect job, claim it, post a result, read it back', async () => {
  process.env.BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'testtoken';
  process.env.BRIDGE_EXT_ORIGIN = process.env.BRIDGE_EXT_ORIGIN || 'chrome-extension://testid';
  delete require.cache[require.resolve('../relay/server')];
  const { server } = require('../relay/server');
  store._reset();
  let base;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'content-type': 'application/json', 'x-bridge-token': process.env.BRIDGE_TOKEN };
  try {
    let res = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ kind: 'inspect', payload: { kinds: ['source'], allowCookies: false } })
    });
    assert.equal(res.status, 201);
    const { id } = await res.json();

    res = await fetch(`${base}/jobs/next`, { headers: H });
    assert.equal(res.status, 200);
    const claimed = await res.json();
    assert.equal(claimed.id, id);
    assert.equal(claimed.kind, 'inspect');
    assert.deepEqual(claimed.payload.kinds, ['source']);

    res = await fetch(`${base}/jobs/${id}/result`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ result: { source: 'redacted html' } })
    });
    assert.equal(res.status, 200);

    res = await fetch(`${base}/jobs/${id}`, { headers: H });
    const final = await res.json();
    assert.equal(final.status, 'done');
    assert.equal(final.result.source, 'redacted html');
  } finally {
    server.close();
  }
});
