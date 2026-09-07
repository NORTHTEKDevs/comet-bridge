# Comet Bridge - Design

Date: 2026-06-13
Owner: Northtek
Status: APPROVED (design) - ready for build plan

## Purpose

Give Claude Code a pipe into Perplexity's brain through the Comet browser, so Claude can
call Perplexity as a research tool on the operator's own Pro account at $0 marginal cost, and (if
verifiable) hand agentic browsing tasks to Comet's assistant.

This is NOT a generic browser customization. It exists only to do what the existing
`perplexity` MCP (API-based) cannot:

- Ride the Pro subscription at $0 marginal cost instead of metered API calls.
- Reach the full product (Comet's agentic assistant, Spaces, logged-in state), not the API subset.

## Hard constraints (from user)

- **Pull-only, Claude-initiated.** No background watching. No live mirror of activity.
- **No auto-capture.** Nothing pulled is saved anywhere - downstream memory included - unless the
  operator explicitly says "save this." Personal lookups stay personal.
- **Never touch existing browsing/threads.** Dispatched queries run in their own dedicated tab;
  the user's normal history and Spaces are never read or polluted.

## Scope

- IN: #1 Perplexity-as-a-tool query bridge (answer + full source list back to Claude).
- IN (gated): #2 Agentic task handoff to Comet's assistant - only after a Phase-0 spike proves
  the agent surface is DOM-drivable; otherwise fall back to Ghost CDP, or shelve.
- OUT: #3 live thread/context mirror. Explicitly rejected (privacy).
- OUT: auto-persistence to any downstream memory store.

## Architecture

Three parts:

1. **Comet extension (MV3)** - content script scoped to Perplexity + background service worker.
   Acts ONLY on jobs dispatched through the relay. Never scrapes existing threads.
2. **Local relay** - single-file Node HTTP server bound to `127.0.0.1`, in-memory job map,
   no database. It is the rendezvous point: the extension cannot receive inbound HTTP directly,
   so both the extension and Claude meet at the relay.
3. **Claude side** - Claude posts a job and polls for the result via `curl` to the relay (v1).
   If the bridge proves its worth, wrap it as an MCP tool later (not v1).

## Data flow

### Query (#1)

1. Claude `POST /jobs` `{ query, mode: "search" | "research" }` -> relay returns `{ id }`.
2. Extension background worker long-polls `/jobs/next`, claims the job.
3. Content script opens a DEDICATED Perplexity tab, types the query, submits.
4. Waits for render-complete (streaming-done signal in the DOM), with a timeout.
5. Scrapes: answer text, full citation/source list (title + URL), related questions if present.
6. `POST /jobs/:id/result` with structured JSON.
7. Claude polls `GET /jobs/:id` until `done`, receives the JSON, then verifies/deep-reads the
   sources independently (pairs with deep-research + Firecrawl).

### Agentic (#2) - GATED

Same rails, `mode: "agent"`. Built only if Phase-0 confirms Comet's assistant input+output are
in a readable, injectable DOM. If it is a native (non-DOM) surface, fallback is driving via
Ghost CDP; if neither is workable, #2 is shelved and reported as such. No capability is promised
before the spike.

## Security model

- Relay binds to `127.0.0.1` only.
- Shared-secret token required on every relay call (baked into the extension, passed by Claude's
  curl). Prevents any random localhost web page from dispatching jobs.
- CORS locked to the extension origin; reject all others.
- Token stored locally, never committed.

## Error handling

- Stale selectors -> extension returns a clear `selectors_stale` error so we know to re-fix,
  not a silent wrong answer.
- Answer never completes -> timeout error with partial-state note.
- No Perplexity tab / logged out -> detected and reported distinctly.

## Known caveats (named, accepted)

- DOM scraping is brittle; breaks when Perplexity changes markup -> periodic selector fixes.
- Automating one's own account is gray-area vs Perplexity ToS. Personal-use, low-risk; accepted
  by owner.

## Proof / acceptance (evidence rule)

- v1 (#1) is not "done" until ONE real end-to-end query runs against live Perplexity and the
  captured answer + >=1 source are shown returned to Claude. Self-report does not count.
- Relay job lifecycle has unit tests.
- Phase-0 spike produces a written verdict (DOM-drivable: yes/no/fallback) before #2 is built.

## Phasing

- **P0** - Spike: inspect Comet's agent surface, write the #2 verdict.
- **P1** - Query bridge (#1) end-to-end + proof run. Relay + extension + curl flow.
- **P2** - Agentic handoff (#2) per the P0 verdict, or fallback/shelve.
- **P3 (optional)** - Wrap relay as an MCP tool if the curl flow proves valuable.

## Tech choices (boring on purpose)

- Relay: Node built-in `http`, single file, no framework, in-memory state.
- Extension: vanilla MV3, no build step, so selector fixes are a one-file edit.

## Defaults (approved)

- Lives at `~/projects/active/comet-bridge`.
- Claude calls it via curl in v1.
- Dedicated-tab isolation for dispatched queries.
- Zero persistence unless explicitly instructed.
