# Perplexity DOM selectors (observed)

Source: `perplexity-answer.html`, captured 2026-06-13 via Firecrawl rawHtml render of
`https://www.perplexity.ai/search?q=what+is+the+capital+of+france` (ANONYMOUS, not logged in).

## Confirmed via jsdom inspection

| Target | Selector / strategy | Notes |
|---|---|---|
| Answer text | `.prose` | `div.prose dark:prose-invert ...`; textContent = "The capital of France is Paris." Solid, primary. |
| Sources | `a[href^="http"]` minus `SKIP_HOSTS` | The only real external source link was `home.adelphi.edu/...`. All other http anchors were Perplexity nav (`/library`, `/spaces`, `/computer/*`). |
| Completion signal | TBD at proof | Anonymous static capture can't show streaming state. `inject.js` will use a copy/stop-button signal verified against the live logged-in DOM (Task 7 / Task 10). |
| Agent surface | TBD | Decided by Task 0 spike. |

## Caveats

- This is the ANONYMOUS render. The logged-in Comet app view may add/rename source markup and
  show more citations. `.prose` for the answer is expected to be stable; source extraction uses a
  host-exclusion heuristic so it tolerates markup drift.
- Final selector truth = the live proof run (Task 10). On `selectors_stale`, re-capture this fixture
  from the logged-in DOM and re-run the scraper test.
