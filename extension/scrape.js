// Extracts a Perplexity answer + its external sources from a rendered document.
// Runs in the browser content script (pass `document`) AND in Node tests (pass a jsdom document).
//
// Selectors derived from a REAL rendered Perplexity answer (test/fixtures/perplexity-answer.html),
// captured anonymously. The logged-in Comet view may differ slightly - the live proof run is the
// final validation. If `.prose` ever stops matching, scrape returns { error: 'selectors_stale' }
// so the caller knows to re-capture the fixture and re-derive selectors, rather than returning a
// silently-wrong answer.

// Hosts that are Perplexity's own chrome/nav or static assets - never real citation sources.
const SKIP_HOSTS = /(^|\.)(perplexity\.ai|gstatic\.com|googleapis\.com|google\.com|fonts\b|sentry\.|intercom\.|segment\.|cloudflare|cdn\b)/i;

function scrapePerplexityAnswer(doc) {
  const answerEl = doc.querySelector('.prose');
  const answer = answerEl ? answerEl.textContent.trim() : '';
  if (!answer) return { error: 'selectors_stale' };

  const seen = new Set();
  const sources = [];
  for (const a of doc.querySelectorAll('a[href^="http"]')) {
    let host;
    try { host = new URL(a.href).hostname; } catch { continue; }
    if (SKIP_HOSTS.test(host)) continue;
    if (seen.has(a.href)) continue;
    seen.add(a.href);
    sources.push({ title: (a.textContent || '').trim() || host, url: a.href });
  }
  return { answer, sources };
}

if (typeof module !== 'undefined') module.exports = { scrapePerplexityAnswer };
