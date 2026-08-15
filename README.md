# Comet Bridge

Lets Claude Code use the Comet browser as both a research tool and a set of eyes on whatever page
you have open. Three job types run through the same relay:

- **`query` jobs** - call Perplexity as a research tool through your Pro account at $0 marginal
  cost. Claude dispatches a query; a dedicated Perplexity tab answers it, sources included.
- **`read` jobs** - read a sanitized element-map + visible text of your *active* tab (whatever
  site you actually have open), for the comet-mcp Phase 1 control plane's `comet_read` tool.
- **`inspect` jobs** - DevTools-equivalent inspection of your *active* tab (rendered source,
  script/style sources, network resource entries, console output, computed styles, cookies), with
  every string redacted for credential-shaped substrings by default, for the comet-mcp Phase 6
  control plane's `comet_inspect` tool. See "The inspector" below.

## Principles (hard constraints)

- **Pull-only, Claude-initiated.** No background watching. No live mirror of your activity.
- **No auto-capture.** Nothing pulled is saved anywhere (kernel included) unless you explicitly say so.
- **Never touches your existing threads.** Dispatched `query` jobs run in their own dedicated tab.
- **Localhost-only + token + locked CORS.** The relay binds `127.0.0.1`, requires a shared secret,
  and only accepts CORS from the extension origin.

## Architecture

```
Claude --curl--> relay (127.0.0.1:8787) <--poll/post-- Comet extension --drives--> Perplexity tab (query jobs)
   ^                                                          |
   |                                                          +--reads--> active tab (read jobs)
   |                                                          +--inspects--> active tab (inspect jobs)
   +---------------------- answer/element-map (JSON) <--------+
```

- `relay/` - single-file Node HTTP server (built-in `http`, no deps). In-memory job queue
  (`relay/store.js`). A job is `{ id, status, query, mode, kind, payload, result, error }` -
  `kind`/`payload` is the generalized job shape; posting `{ query }` with no `kind` is legacy
  shorthand for `{ kind: "query", query }` (`store.createJob`), so `comet-mcp`'s `read`/`inspect`
  jobs and the existing Perplexity `query` jobs share one queue and one `/jobs`, `/jobs/next`,
  `/jobs/:id/result`, `/jobs/:id` API.
- `extension/` - MV3 extension: `background.js` polls the relay and dispatches by `job.kind`.
  `query` jobs drive the dedicated Perplexity tab (`inject.js` types the query and waits for the
  answer to stabilize, `scrape.js` extracts answer + sources). `read` jobs run `reader.js` against
  the user's currently-focused, active tab - not the hidden Perplexity tab - via
  `chrome.scripting.executeScript`, so the agent reads whatever the user actually has open (e.g. a
  client portal), never the research tab. `inspect` jobs run `inspect.js` the same way, against the
  same active tab - see "The inspector" below.
- `ask.sh` - Claude's call path for `query` jobs (POST a job, poll for the result).

### The reader (`extension/reader.js`)

`buildReaderState(document)` returns a sanitized, LLM-safe view of the page:

- `elements`: every interactive element (`a[href]`, `button`, `input`, `select`, `textarea`,
  `[role=button]`, `[role=link]`, `[contenteditable=true]`), each tagged with an **opaque numeric
  `ref`** (0, 1, 2, ...) plus `tag`, `role`, accessible `name`, `type`, and a bounding `box` for
  Ghost to click by coordinate. Actions reference elements by `ref`, never by a selector or by page
  text, so a page cannot smuggle a click target through its own content.
- `value_present`: for `input`/`textarea`/`select` elements, a **boolean only** - whether the field
  currently holds a value. The raw value itself is never read or emitted, so form contents and
  password fields cannot reach model context through a read.
- `content`: visible text only, walked skipping `script`/`style`/`noscript`/`template` and anything
  hidden via the `hidden` attribute, `aria-hidden="true"`, or inline `display:none`/
  `visibility:hidden` - never raw script/CSS source, never hidden text, capped at `maxText`
  (default 20000 chars).

### The inspector (`extension/inspect.js`) - Phase 6

`buildInspection(doc, opts)` is a pure, jsdom-testable core that returns only the requested `kinds`:
`source` (`documentElement.outerHTML`, truncated), `scripts` (each `<script src>`'s URL plus its
fetched text, truncated - the browser-side caller supplies a pre-fetched map), `styles` (stylesheet
`<link>` URLs plus inline `<style>` text, truncated), `resources`
(`performance.getEntriesByType("resource")` mapped to `{name, initiatorType, duration,
transferSize}` - the browser-side caller supplies the injected array), `computed` (a small allowlist
of computed style properties for one named element), `console` (entries captured by a
`document_start` content script - `world: "MAIN"` in `manifest.json` - that wraps
`console.log/warn/error/info` and keeps a bounded ring buffer on `window.__cometInspectConsole`,
redacted only on read so `noRedact` callers can still see raw entries), and `cookies`
(`document.cookie`, gated separately below).

**Redaction is the load-bearing part, and it lives here, in the extension, at the browser
boundary** - `comet-mcp`'s `RunManager.inspect` never re-redacts, it only gates and shapes what this
module already redacted. Every string field passes through `maybeRedact`, which calls the exported
`redactSecrets(text)` unless `opts.noRedact === true`. `redactSecrets` runs a single exported
`CREDENTIAL_PATTERNS` constant against the text - the same detector families as `comet-mcp`'s
`src/egress.ts` `looksLikeCredential`: known key prefixes (`sk-`, `nvapi-`, `ghp_`, `AKIA`, `xox`,
`-----BEGIN`, ...), `password=`/`api_key=`/`token=`-style assignments, high-entropy candidate
tokens, and numeric/Luhn-valid digit runs - replacing each match with the literal `[REDACTED]`. A
kind the caller did not ask for is never gathered at all; an unrecognized kind fails closed with an
error, never a silent empty result.

**Cookies are a separate opt-in, never covered by requesting other kinds:** `out.cookies` is only
populated when `opts.allowCookies === true` - `comet-mcp` only sets this when the run's
`allow_cookie_inspection` policy flag is set, so a caller cannot get `document.cookie` back just by
listing `"cookies"` in a job's `kinds`.

**`manifest.json`** (bumped to `0.3.0` for this phase) adds a `content_scripts` entry running
`inspect.js` at `document_start` in the page's own `MAIN` world (needed so the console hook wraps
the page's real `console` object before the page's own scripts run) - no new `host_permissions` or
`webNavigation` permission were needed; `<all_urls>` already covered it from the reader.

**No CDP, by design.** `inspect` jobs never open a `chrome.debugger` (Chrome DevTools Protocol)
session - Chromium's own "this browser is being debugged" infobar would make the whole browser
detectable, which the comet-mcp side of this project explicitly rejected as a driver. Everything
above runs through `chrome.scripting.executeScript` and a content script, exactly like `read` jobs.

### Why `host_permissions` is `<all_urls>`

`extension/manifest.json`'s `host_permissions` widened from the P1 query-bridge's
`https://www.perplexity.ai/*` + `https://perplexity.ai/*` to `<all_urls>` when the reader shipped
(commit `feat(extension): read active tab via sanitized reader element-map`). `read` jobs must be
able to run `reader.js` on whatever site the user's active tab happens to be - client portals,
dashboards, email - which cannot be enumerated in advance, so the permission has to be broad. The
127.0.0.1 relay origin is still pinned separately in `host_permissions` and the relay itself still
locks CORS to the extension's own origin; the widened host permission only affects which pages the
extension's content scripts may run on, not who may talk to the relay. `inspect` jobs (Phase 6) run
under this same permission - no widening was needed for them.

## Setup

1. **Generate the shared token** (gitignored):
   ```bash
   node -e "require('fs').writeFileSync('relay/bridge.token', require('crypto').randomBytes(24).toString('hex'))"
   ```
2. **Configure the extension:** copy `extension/config.example.js` to `extension/config.js`
   (gitignored) and paste the token from `relay/bridge.token` into `RELAY_TOKEN`.
3. **Load the extension in Comet:** `chrome://extensions` -> enable Developer mode ->
   Load unpacked -> select the `extension/` folder. Copy the extension ID it shows.
4. **Start the relay** with that ID so CORS is locked to it:
   ```bash
   BRIDGE_EXT_ORIGIN="chrome-extension://<the-id>" npm run relay
   ```

## Use

```bash
./ask.sh "what is the capital of France" search
# -> { "status": "done", "result": { "answer": "...", "sources": [ ... ] } }
```

Modes: `search` (default), `research`, `agent` (gated - see below).

`read` jobs are dispatched by comet-mcp's `comet_read` tool (`POST /jobs` with
`{ "kind": "read", "payload": { "target": "..." } }`), not by `ask.sh`; the result is the
`buildReaderState` output described above. `inspect` jobs are dispatched by comet-mcp's
`comet_inspect` tool (`POST /jobs` with `{ "kind": "inspect", "payload": { "kinds": [...],
"name": "...", "allowCookies": false, "noRedact": false } }`); the result is the `buildInspection`
output described in "The inspector" above, already redacted.

## Tests

```bash
npm test            # relay + scraper + reader + inspect unit tests
bash scripts/smoke.sh   # full relay + ask.sh loop with a simulated extension (no browser)
```

## Maintenance

If a query returns `{"error":"selectors_stale"}`, Perplexity changed its markup. Re-capture a
real answer's HTML into `test/fixtures/perplexity-answer.html`, update `extension/scrape.js`
selectors against it, and re-run `npm test`. See `test/fixtures/SELECTORS.md`.

## Status

- **P1 (query bridge): built.** Relay, scraper (tested vs a real Perplexity fixture), extension,
  and the ask.sh<->relay<->extension plumbing (smoke-tested) are done. Selectors were derived from an
  anonymous render - the logged-in view is confirmed at the live proof run.
- **Comet-agent Phase 1 (read jobs): built.** Generalized `kind`/`payload` job shape, the
  `read` job path in `background.js`, and the sanitized `reader.js` element-map are done and
  unit-tested. Consumed by comet-mcp's `comet_read` tool.
- **Comet-agent Phase 6 (inspect jobs): built.** `inspect.js`'s pure `buildInspection` core, the
  `redactSecrets`/`CREDENTIAL_PATTERNS` redactor, the `document_start` console-capture hook, and the
  `inspect` job path in `background.js` are done and unit-tested (jsdom, pure-function style like
  `reader.js`). Consumed by comet-mcp's `comet_inspect` tool - see "The inspector" above.
- **Pending:** live proof run (load extension + one real query); P0 spike on Comet's agent DOM.
- **P2 (agentic `mode:agent`): gated** on the P0 spike verdict (`docs/plans/2026-06-13-p0-agent-verdict.md`).
- **P3 (MCP wrapper):** optional, only if the curl flow proves valuable.

## Caveat

Scraping rendered DOM is brittle and this automates your own Perplexity account (personal-use,
gray-area vs ToS). Accepted by the owner. `read`/`inspect` jobs run against whatever site the user's
active tab is on, under the same pull-only, Claude-initiated principle above - the extension does not
watch tabs on its own; it only acts when a job is waiting in the relay queue. Redaction in `inspect`
jobs is a heuristic pattern match, not a guarantee - see comet-mcp's README "Phase 6" section for the
full honest-limits discussion of what it can and cannot catch.
