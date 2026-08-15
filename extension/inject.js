// Runs in the Perplexity page (injected by background.js alongside scrape.js).
// Types the query, waits for the answer to stabilize, then scrapes answer + sources.
// Completion is detected by watching `.prose` stabilize (no exact stop/copy-button selector to
// guess) - robust to markup drift. Validated live in the proof run, not unit-tested (timing + DOM).

async function runQuery(query, timeoutMs) {
  const STABLE_MS = 2000;

  function findInput() {
    return document.querySelector('textarea')
      || document.querySelector('[contenteditable="true"]')
      || document.querySelector('[data-testid*="ask-input"] textarea')
      || null;
  }

  const input = findInput();
  if (!input) return { error: 'selectors_stale', where: 'input' };

  input.focus();
  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    input.textContent = query;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));

  const start = Date.now();
  let lastText = '';
  let lastChange = Date.now();

  return await new Promise((resolve) => {
    const iv = setInterval(() => {
      const el = document.querySelector('.prose');
      const text = el ? el.textContent.trim() : '';
      if (text && text !== lastText) { lastText = text; lastChange = Date.now(); }
      const stable = text && (Date.now() - lastChange > STABLE_MS);
      if (stable) {
        clearInterval(iv);
        resolve(scrapePerplexityAnswer(document));
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve(text ? scrapePerplexityAnswer(document) : { error: 'timeout' });
      }
    }, 400);
  });
}
