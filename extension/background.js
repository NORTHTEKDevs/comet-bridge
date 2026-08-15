// Background service worker: polls the relay for jobs, drives a DEDICATED Perplexity tab,
// scrapes the answer, posts the result back. Reuses one tab so normal browsing/history is
// never touched. Acts only on jobs Claude dispatched - no background watching, no auto-capture.

importScripts('config.js');
const C = self.BRIDGE_CONFIG;
let bridgeTabId = null;

function startPolling() {
  chrome.alarms.create('poll', { periodInMinutes: Math.max(C.POLL_SECONDS / 60, 0.1) });
}
chrome.runtime.onInstalled.addListener(startPolling);
chrome.runtime.onStartup.addListener(startPolling);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') poll(); });

async function poll() {
  let res;
  try {
    res = await fetch(`${C.RELAY}/jobs/next`, { headers: { 'x-bridge-token': C.RELAY_TOKEN } });
  } catch { return; }
  if (res.status !== 200) return;
  const job = await res.json();
  await handle(job);
}

async function ensureTab() {
  if (bridgeTabId) {
    try { await chrome.tabs.get(bridgeTabId); return bridgeTabId; }
    catch { bridgeTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: C.PERPLEXITY_URL, active: false });
  bridgeTabId = tab.id;
  await new Promise(r => setTimeout(r, 4000));
  return bridgeTabId;
}

// `read` jobs target the user's ACTIVE tab in the focused normal window - NOT the dedicated
// Perplexity bridge tab `ensureTab()` reuses for query jobs - so the agent reads whatever page
// the user actually has open (e.g. a client portal), not the hidden research tab.
async function handleRead(job) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { error: 'no_active_tab' };
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['reader.js'] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => buildReaderState(document)
  });
  return result;
}

// `navigate` jobs drive the ACTIVE tab with chrome.tabs.update and wait for the load to complete.
//
// This exists because Ghost's address-bar navigation proved unreliable in practice: it types the
// URL into the omnibox, which needs the Comet window to hold OS foreground. Observed live on this
// machine, three separate ways: a dropped leading character ("ttps://..."), a silent no-op that
// still returned {ok:true} in 190ms, and foreground being stolen mid-action by other apps. Driving
// the tab directly needs no focus, no keystrokes and no address bar, so that entire failure class
// disappears. It is also not an anti-bot concern - a tab navigation is indistinguishable from an
// ordinary one; Ghost stays the actor for CLICK/TYPE, where isTrusted input genuinely matters.
//
// Returns the tab's REAL final url so the caller can verify where it actually landed (including
// after any redirect) instead of trusting that the navigation did what it was asked.
async function handleNavigate(job) {
  const url = job.payload && job.payload.url;
  if (!url) return { error: 'no_url' };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { error: 'no_active_tab' };

  await chrome.tabs.update(tab.id, { url });

  const deadline = Date.now() + ((job.payload && job.payload.timeout_ms) || 30000);
  for (;;) {
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    if (!t) return { error: 'tab_closed' };
    if (t.status === 'complete' && t.url && t.url !== 'about:blank') {
      return { url: t.url, title: t.title || '' };
    }
    if (Date.now() > deadline) return { error: 'navigate_timeout', url: t.url || '' };
    await new Promise(r => setTimeout(r, 250));
  }
}

// `inspect` jobs target the user's ACTIVE tab, same tab-selection rule as `read`. Gathers the
// browser-only inputs (fetched script text, performance-resource entries, the console ring buffer
// installed by inspect.js's document_start hook) THEN calls the pure, jsdom-tested
// `buildInspection` so all the redaction/shaping logic stays in one testable place.
async function handleInspect(job) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { error: 'no_active_tab' };
  const payload = job.payload || {};
  const opts = {
    kinds: Array.isArray(payload.kinds) ? payload.kinds : [],
    name: payload.name,
    allowCookies: !!payload.allowCookies,
    noRedact: !!payload.noRedact
  };
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['inspect.js'] });

  if (opts.kinds.includes('scripts')) {
    const [{ result: srcs }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src'))
    });
    opts.scriptTexts = {};
    for (const src of (srcs || [])) {
      try {
        const abs = new URL(src, tab.url).href;
        const res = await fetch(abs);
        opts.scriptTexts[src] = await res.text();
      } catch { /* opaque/unreachable script source - the URL alone is still returned */ }
    }
  }
  if (opts.kinds.includes('resources')) {
    const [{ result: entries }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => performance.getEntriesByType('resource').map(e => ({
        name: e.name, initiatorType: e.initiatorType, duration: e.duration, transferSize: e.transferSize
      }))
    });
    opts.resourceEntries = entries || [];
  }
  if (opts.kinds.includes('console')) {
    const [{ result: entries }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => (window.__cometInspectConsole || [])
    });
    opts.consoleEntries = entries || [];
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: o => buildInspection(document, o),
    args: [opts]
  });
  return result;
}

async function handle(job) {
  let result, error;
  try {
    if (job.kind === 'read') {
      const out = await handleRead(job);
      if (out && out.error) error = out.error; else result = out;
    } else if (job.kind === 'inspect') {
      const out = await handleInspect(job);
      if (out && out.error) error = out.error; else result = out;
    } else if (job.kind === 'navigate') {
      const out = await handleNavigate(job);
      if (out && out.error) error = out.error; else result = out;
    } else {
      const tabId = await ensureTab();
      await chrome.tabs.update(tabId, { url: C.PERPLEXITY_URL });
      await new Promise(r => setTimeout(r, 3000));
      await chrome.scripting.executeScript({ target: { tabId }, files: ['scrape.js', 'inject.js'] });
      const [{ result: out }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (q, t) => runQuery(q, t),
        args: [job.query, C.ANSWER_TIMEOUT_MS]
      });
      if (out && out.error) error = out.error; else result = out;
    }
  } catch (e) {
    error = String((e && e.message) || e);
  }
  await fetch(`${C.RELAY}/jobs/${job.id}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': C.RELAY_TOKEN },
    body: JSON.stringify(error ? { error } : { result })
  });
}