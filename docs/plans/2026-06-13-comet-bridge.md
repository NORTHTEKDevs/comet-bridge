# Comet Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Claude Code call Perplexity as a research tool through the Comet browser (answer + full source list), on the user's Pro account at $0 marginal cost, with a gated path to handing agentic tasks to Comet.

**Architecture:** A single-file Node HTTP relay bound to `127.0.0.1` is the rendezvous. Claude POSTs jobs and polls results via `curl`. A vanilla MV3 Comet extension long-polls the relay, drives a dedicated Perplexity tab, scrapes the rendered answer + sources, and POSTs them back. Pull-only, Claude-initiated, nothing persisted.

**Tech Stack:** Node built-in `http` + `node:test` (no framework, no deps for the relay), `jsdom` (dev-only, to test DOM scraping against a saved fixture), vanilla MV3 extension (no build step).

**Hard constraints (carry into every task):** pull-only and Claude-initiated; no background watching; no auto-capture; nothing saved to the kernel or anywhere unless the user explicitly says so; never read existing threads/Spaces (dispatched queries use their own tab); relay is localhost-only + shared-secret token + CORS locked to the extension origin.

---

## Phase 0 - Spike (gates #2; does not block #1)

### Task 0: Verify whether Comet's agent surface is DOM-drivable

**Files:**
- Create: `docs/plans/2026-06-13-p0-agent-verdict.md`

**Step 1:** Attach to the running Comet browser via the Ghost MCP (CDP attach, or UI automation if CDP is unavailable). Read-only inspection - do not act on any real account state.

**Step 2:** Open Comet's assistant / agent surface. Inspect the DOM for: (a) an injectable input element for the agent prompt, (b) a readable container where the agent's output/answer renders, (c) any signal that distinguishes "agent done" from "still working".

**Step 3:** Write the verdict to `docs/plans/2026-06-13-p0-agent-verdict.md` with one of: `DOM-DRIVABLE` (with the selectors found), `NATIVE-SURFACE-USE-GHOST-CDP` (DOM not reachable; #2 must be driven via Ghost), or `SHELVE` (neither workable). Include screenshots/DOM snippets as evidence.

**Step 4: Commit**
```bash
git add docs/plans/2026-06-13-p0-agent-verdict.md
git commit -m "spike: P0 verdict on Comet agent DOM-drivability"
```

**Note:** This is an investigation, not TDD. Its output decides Task 12. Do NOT promise #2 behavior until this verdict exists.

---

## Phase 1 - Query bridge (#1)

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `relay/` , `extension/` , `test/` , `test/fixtures/`

**Step 1:** Write `package.json`:
```json
{
  "name": "comet-bridge",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "node --test",
    "relay": "node relay/server.js"
  },
  "devDependencies": {
    "jsdom": "^24.0.0"
  }
}
```

**Step 2:** Run `npm install`. Expected: jsdom installed, no errors.

**Step 3: Commit**
```bash
git add package.json package-lock.json
git commit -m "chore: scaffold comet-bridge"
```

---

### Task 2: Job store (TDD)

**Files:**
- Create: `relay/store.js`
- Test: `test/store.test.js`

**Step 1: Write the failing test** (`test/store.test.js`):
```js
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
```

**Step 2: Run to verify it fails** - `npm test`. Expected: FAIL, cannot find `../relay/store`.

**Step 3: Implement** (`relay/store.js`):
```js
let seq = 0;
const jobs = new Map();

function createJob({ query, mode }) {
  const id = String(++seq);
  jobs.set(id, { id, query, mode: mode || 'search', status: 'pending', result: null, error: null });
  return jobs.get(id);
}
function claimNext() {
  for (const job of jobs.values()) {
    if (job.status === 'pending') { job.status = 'claimed'; return job; }
  }
  return null;
}
function setResult(id, { result, error }) {
  const job = jobs.get(id);
  if (!job) return null;
  if (error) { job.status = 'error'; job.error = error; }
  else { job.status = 'done'; job.result = result; }
  return job;
}
function get(id) { return jobs.get(id) || null; }
function _reset() { jobs.clear(); seq = 0; }

module.exports = { createJob, claimNext, setResult, get, _reset };
```

**Step 4: Run to verify it passes** - `npm test`. Expected: 4 passing.

**Step 5: Commit**
```bash
git add relay/store.js test/store.test.js
git commit -m "feat: relay job store"
```

---

### Task 3: Relay HTTP server + token auth (TDD)

**Files:**
- Create: `relay/server.js`
- Test: `test/server.test.js`

**Step 1: Write the failing test** (`test/server.test.js`):
```js
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
```

**Step 2: Run to verify it fails** - `npm test`. Expected: FAIL, cannot find `../relay/server`.

**Step 3: Implement** (`relay/server.js`):
```js
const http = require('http');
const store = require('./store');

function loadToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  try { return require('fs').readFileSync(__dirname + '/bridge.token', 'utf8').trim(); } catch { return null; }
}
const TOKEN = loadToken();
const EXT_ORIGIN = process.env.BRIDGE_EXT_ORIGIN || '';

function send(res, code, body, origin) {
  const headers = { 'content-type': 'application/json' };
  if (origin && origin === EXT_ORIGIN) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'content-type, x-bridge-token';
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(code, headers);
  res.end(body == null ? '' : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'OPTIONS') return send(res, 204, null, origin);
  if (!TOKEN || req.headers['x-bridge-token'] !== TOKEN) return send(res, 401, { error: 'bad token' }, origin);

  if (req.method === 'POST' && url.pathname === '/jobs') {
    const body = await readBody(req);
    if (!body.query) return send(res, 400, { error: 'query required' }, origin);
    const job = store.createJob(body);
    return send(res, 201, { id: job.id }, origin);
  }
  if (req.method === 'GET' && url.pathname === '/jobs/next') {
    const job = store.claimNext();
    if (!job) return send(res, 204, null, origin);
    return send(res, 200, { id: job.id, query: job.query, mode: job.mode }, origin);
  }
  let m = url.pathname.match(/^\/jobs\/([^/]+)\/result$/);
  if (req.method === 'POST' && m) {
    const body = await readBody(req);
    const job = store.setResult(m[1], body);
    if (!job) return send(res, 404, { error: 'no job' }, origin);
    return send(res, 200, { ok: true }, origin);
  }
  m = url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const job = store.get(m[1]);
    if (!job) return send(res, 404, { error: 'no job' }, origin);
    return send(res, 200, { status: job.status, result: job.result, error: job.error }, origin);
  }
  return send(res, 404, { error: 'not found' }, origin);
});

if (require.main === module) {
  const port = process.env.BRIDGE_PORT || 8787;
  server.listen(port, '127.0.0.1', () => console.log(`bridge relay on 127.0.0.1:${port}`));
}
module.exports = { server };
```

**Step 4: Run to verify it passes** - `npm test`. Expected: all passing.

**Step 5: Commit**
```bash
git add relay/server.js test/server.test.js
git commit -m "feat: relay http server with token auth + locked CORS"
```

---

### Task 4: Capture a real Perplexity answer fixture

**Files:**
- Create: `test/fixtures/perplexity-answer.html`
- Create: `test/fixtures/SELECTORS.md`

**Why:** The real Perplexity DOM is unknown until observed. Scrape selectors MUST come from a real captured answer, not guessed. This task front-loads that.

**Step 1:** Generate the token file the extension/relay will share:
```bash
node -e "require('fs').writeFileSync('relay/bridge.token', require('crypto').randomBytes(24).toString('hex'))"
```
(`*.token`/`bridge.token` is gitignored - never commit it.)

**Step 2:** In Comet, run one simple Perplexity query (e.g. "capital of France"). After it finishes rendering, capture the answer container's outerHTML. Save it to `test/fixtures/perplexity-answer.html`. Capture via Ghost (`ghost_query`/DOM read) or DevTools "Copy element". Strip nothing.

**Step 3:** In `test/fixtures/SELECTORS.md`, record the exact selectors observed for: answer container, the source/citation list container, each source link (title + href), and the "generation complete" signal (e.g. copy button appears / stop button disappears). These feed Tasks 5 and 7.

**Step 4: Commit**
```bash
git add test/fixtures/perplexity-answer.html test/fixtures/SELECTORS.md
git commit -m "test: real Perplexity answer fixture + observed selectors"
```

---

### Task 5: Scrape parser (TDD against the fixture)

**Files:**
- Create: `extension/scrape.js`
- Test: `test/scrape.test.js`

**Step 1: Write the failing test** (`test/scrape.test.js`) - fill the asserted values from the actual fixture content:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { scrapePerplexityAnswer } = require('../extension/scrape');

const html = fs.readFileSync(__dirname + '/fixtures/perplexity-answer.html', 'utf8');
const doc = new JSDOM(html).window.document;

test('extracts a non-empty answer', () => {
  const out = scrapePerplexityAnswer(doc);
  assert.ok(out.answer && out.answer.length > 0, 'answer should be non-empty');
});

test('extracts at least one source with title + url', () => {
  const out = scrapePerplexityAnswer(doc);
  assert.ok(Array.isArray(out.sources) && out.sources.length >= 1);
  assert.ok(out.sources[0].url.startsWith('http'));
});

test('returns selectors_stale error on empty doc', () => {
  const empty = new JSDOM('<html><body></body></html>').window.document;
  const out = scrapePerplexityAnswer(empty);
  assert.equal(out.error, 'selectors_stale');
});
```

**Step 2: Run to verify it fails** - `npm test`. Expected: FAIL, cannot find `../extension/scrape`.

**Step 3: Implement** (`extension/scrape.js`) - REPLACE the placeholder selectors with the ones recorded in `test/fixtures/SELECTORS.md`:
```js
function scrapePerplexityAnswer(doc) {
  // TODO(Task 5): replace selectors with values from test/fixtures/SELECTORS.md
  const ANSWER_SEL = '[data-testid="answer"]';        // placeholder
  const SOURCE_SEL = '[data-testid="sources"] a[href^="http"]'; // placeholder

  const answerEl = doc.querySelector(ANSWER_SEL);
  const answer = answerEl ? answerEl.textContent.trim() : '';
  const sources = Array.from(doc.querySelectorAll(SOURCE_SEL))
    .map(a => ({ title: (a.textContent || '').trim(), url: a.href }))
    .filter(s => s.url && s.url.startsWith('http'));

  if (!answer) return { error: 'selectors_stale' };
  return { answer, sources };
}
if (typeof module !== 'undefined') module.exports = { scrapePerplexityAnswer };
```

**Step 4: Run to verify it passes** - `npm test`. Expected: all passing. If not, the selectors are wrong - fix them against the fixture, not the test.

**Step 5: Commit**
```bash
git add extension/scrape.js test/scrape.test.js
git commit -m "feat: Perplexity answer scraper (fixture-tested)"
```

---

### Task 6: Extension manifest + config

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/config.example.js`

**Step 1:** Write `extension/manifest.json` (MV3). `host_permissions` covers Perplexity + the localhost relay; `<all_urls>` is deliberately NOT used.
```json
{
  "manifest_version": 3,
  "name": "Comet Bridge",
  "version": "0.1.0",
  "description": "Claude-initiated Perplexity research bridge (pull-only).",
  "permissions": ["tabs", "scripting", "storage", "alarms"],
  "host_permissions": [
    "https://www.perplexity.ai/*",
    "https://perplexity.ai/*",
    "http://127.0.0.1:8787/*"
  ],
  "background": { "service_worker": "background.js" }
}
```

**Step 2:** Write `extension/config.example.js` (copied to `config.js`, which is gitignored, with the real token from `relay/bridge.token`):
```js
// copy to config.js and fill RELAY_TOKEN from relay/bridge.token
self.BRIDGE_CONFIG = {
  RELAY: 'http://127.0.0.1:8787',
  RELAY_TOKEN: 'PASTE_TOKEN_HERE',
  PERPLEXITY_URL: 'https://www.perplexity.ai/',
  POLL_SECONDS: 3,
  ANSWER_TIMEOUT_MS: 60000
};
```

**Step 3:** Add `extension/config.js` to `.gitignore`.

**Step 4: Commit**
```bash
git add extension/manifest.json extension/config.example.js .gitignore
git commit -m "feat: extension manifest + config template"
```

---

### Task 7: Content-script driver (inject query, await completion, scrape)

**Files:**
- Create: `extension/inject.js`

**Note:** Uses the input selector + completion signal from `test/fixtures/SELECTORS.md`. This file runs in the page via `chrome.scripting.executeScript`; `scrape.js` is injected alongside it so `scrapePerplexityAnswer` is in scope. Verified by the live run (Task 10), not unit tests (timing + live DOM).

**Step 1:** Implement `extension/inject.js`:
```js
async function runQuery(query, timeoutMs) {
  // TODO(Task 7): set from test/fixtures/SELECTORS.md
  const INPUT_SEL = 'textarea';                 // placeholder
  const DONE_SEL  = '[data-testid="copy-button"]'; // placeholder: appears when generation completes

  const input = document.querySelector(INPUT_SEL);
  if (!input) return { error: 'selectors_stale', where: 'input' };

  input.focus();
  // React-friendly value set
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, query);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  const start = Date.now();
  await new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (document.querySelector(DONE_SEL)) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timeout')); }
    }, 500);
  }).catch(() => null);

  if (Date.now() - start > timeoutMs) return { error: 'timeout' };
  return scrapePerplexityAnswer(document); // from scrape.js, injected alongside
}
```

**Step 2: Commit**
```bash
git add extension/inject.js
git commit -m "feat: content-script query driver"
```

---

### Task 8: Background worker (poll relay, drive dedicated tab, post result)

**Files:**
- Create: `extension/background.js`

**Step 1:** Implement `extension/background.js`. Imports config + reuses the dedicated tab so normal history is untouched.
```js
importScripts('config.js');
const C = self.BRIDGE_CONFIG;
let bridgeTabId = null;

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('poll', { periodInMinutes: Math.max(C.POLL_SECONDS / 60, 0.1) }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('poll', { periodInMinutes: Math.max(C.POLL_SECONDS / 60, 0.1) }));
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') poll(); });

async function poll() {
  let res;
  try { res = await fetch(`${C.RELAY}/jobs/next`, { headers: { 'x-bridge-token': C.RELAY_TOKEN } }); }
  catch { return; }
  if (res.status !== 200) return;
  const job = await res.json();
  await handle(job);
}

async function ensureTab() {
  if (bridgeTabId) { try { await chrome.tabs.get(bridgeTabId); return bridgeTabId; } catch { bridgeTabId = null; } }
  const tab = await chrome.tabs.create({ url: C.PERPLEXITY_URL, active: false });
  bridgeTabId = tab.id;
  await new Promise(r => setTimeout(r, 4000)); // let app shell load
  return bridgeTabId;
}

async function handle(job) {
  let result, error;
  try {
    const tabId = await ensureTab();
    await chrome.tabs.update(tabId, { url: C.PERPLEXITY_URL });
    await new Promise(r => setTimeout(r, 3000));
    const [{ result: out }] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['scrape.js', 'inject.js']
    }).then(() => chrome.scripting.executeScript({
      target: { tabId },
      func: (q, t) => runQuery(q, t),
      args: [job.query, C.ANSWER_TIMEOUT_MS]
    }));
    if (out && out.error) error = out.error; else result = out;
  } catch (e) { error = String(e && e.message || e); }
  await fetch(`${C.RELAY}/jobs/${job.id}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': C.RELAY_TOKEN },
    body: JSON.stringify(error ? { error } : { result })
  });
}
```

**Step 2: Commit**
```bash
git add extension/background.js
git commit -m "feat: background worker driving a dedicated Perplexity tab"
```

---

### Task 9: Claude curl helper

**Files:**
- Create: `ask.sh`

**Step 1:** Implement `ask.sh` (Claude's call path; reads the shared token):
```bash
#!/usr/bin/env bash
set -euo pipefail
RELAY="${BRIDGE_RELAY:-http://127.0.0.1:8787}"
TOKEN="$(cat "$(dirname "$0")/relay/bridge.token")"
QUERY="$1"; MODE="${2:-search}"
ID=$(curl -s -X POST "$RELAY/jobs" -H "content-type: application/json" -H "x-bridge-token: $TOKEN" \
  -d "{\"query\": $(printf '%s' "$QUERY" | python -c 'import json,sys;print(json.dumps(sys.stdin.read()))'), \"mode\": \"$MODE\"}" | python -c 'import json,sys;print(json.load(sys.stdin)["id"])')
for i in $(seq 1 60); do
  OUT=$(curl -s "$RELAY/jobs/$ID" -H "x-bridge-token: $TOKEN")
  ST=$(printf '%s' "$OUT" | python -c 'import json,sys;print(json.load(sys.stdin)["status"])')
  [ "$ST" = "done" ] && { printf '%s\n' "$OUT"; exit 0; }
  [ "$ST" = "error" ] && { printf '%s\n' "$OUT" >&2; exit 1; }
  sleep 2
done
echo "timeout waiting for job $ID" >&2; exit 1
```

**Step 2:** `chmod +x ask.sh`.

**Step 3: Commit**
```bash
git add ask.sh
git commit -m "feat: Claude curl helper for dispatching queries"
```

---

### Task 10: Live end-to-end proof run (ACCEPTANCE GATE)

**Files:** none (evidence task)

**Step 1:** Start the relay: `BRIDGE_EXT_ORIGIN="chrome-extension://<real-id>" npm run relay` (get the extension id after loading it unpacked in Comet via `chrome://extensions` -> Developer mode -> Load unpacked -> select `extension/`, after copying `config.example.js` to `config.js` and pasting the token).

**Step 2:** Run a real query: `./ask.sh "what is the capital of France" search`.

**Step 3:** Confirm the returned JSON has `status: done`, a non-empty `result.answer` containing "Paris", and `result.sources.length >= 1` with real URLs. Paste the actual command output into a new `docs/plans/2026-06-13-p1-proof.md`. Per the evidence rule, the bridge is NOT done until this real output exists - self-report does not count.

**Step 4: Commit**
```bash
git add docs/plans/2026-06-13-p1-proof.md
git commit -m "proof: live end-to-end Perplexity query via Comet Bridge"
```

---

### Task 11: README + run instructions

**Files:**
- Create: `README.md`

**Step 1:** Document: what it is, the privacy/security model, setup (token gen, load unpacked, config.js, get ext id, start relay), how Claude calls it (`ask.sh`), and the "selectors_stale -> re-capture fixture (Task 4) and re-run Task 5/7" maintenance note.

**Step 2: Commit**
```bash
git add README.md
git commit -m "docs: comet-bridge README"
```

---

## Phase 2 - Agentic handoff (#2) - GATED on Task 0 verdict

### Task 12: Agentic mode

**Precondition:** Read `docs/plans/2026-06-13-p0-agent-verdict.md`.
- If `DOM-DRIVABLE`: add `mode: "agent"` handling in `inject.js` using the agent selectors from the verdict; add a longer timeout; scrape the agent's final output + any actions list. Add a fixture + scrape test as in Tasks 4-5.
- If `NATIVE-SURFACE-USE-GHOST-CDP`: implement the agent path as a relay-side worker that drives Comet via Ghost CDP instead of the extension; the extension handles only #1.
- If `SHELVE`: stop; record the decision in the README and do not build #2.

Build TDD where a parser exists; prove with one real agentic run (acceptance), same evidence rule as Task 10.

---

## Phase 3 - Optional MCP wrapper

### Task 13 (optional): Wrap the relay as an MCP tool

Only if the curl flow proves valuable in real use. Expose one tool `perplexity_via_comet(query, mode)` that does the POST + poll internally so Claude calls it as a native tool. Follow `reference_mcp_server_starter` / mcp-builder. Keep the relay unchanged underneath.

---

## Execution order summary

P0 spike (parallel-safe) -> Tasks 1-3 (relay, fully TDD, no browser needed) -> Task 4 (capture fixture, needs Comet) -> Tasks 5 (TDD) -> 6-9 (extension + helper) -> Task 10 (live proof, GATE) -> Task 11 (docs) -> Task 12 (gated) -> Task 13 (optional).
