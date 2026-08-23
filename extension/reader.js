// Builds a sanitized, LLM-safe view of a page: interactive elements with opaque refs and
// accessible names, plus bounded text. Raw input VALUES are never included (only value_present);
// content excludes script/style/noscript source and hidden (display:none / aria-hidden) subtrees,
// so nothing the reader emits leaks a field's contents, inline script/style source, or hidden text.
const INTERACTIVE = 'a[href],button,input,select,textarea,[role=button],[role=link],[contenteditable="true"]';
const NON_CONTENT_TAGS = new Set(['script', 'style', 'noscript', 'template']);

function accName(el) {
  return (el.getAttribute && (el.getAttribute('aria-label')
    || el.getAttribute('placeholder')
    || el.getAttribute('name')))
    || (el.textContent || '').trim().slice(0, 120)
    || '';
}

function isHiddenEl(el) {
  if (el.hasAttribute && (el.hasAttribute('hidden'))) return true;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
  const style = el.style;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
  return false;
}

// Collects rendered-text-only content: walks the tree skipping script/style/noscript/template
// elements and anything hidden via the hidden attribute, aria-hidden="true", or inline
// display:none/visibility:hidden. Unlike doc.body.textContent, this never surfaces raw script
// or CSS source, or text that is not actually visible on the page.
function collectVisibleText(node, buf) {
  if (node.nodeType === 3) { // TEXT_NODE
    buf.push(node.nodeValue);
    return;
  }
  if (node.nodeType !== 1) return; // only elements and text nodes contribute
  const tag = node.tagName && node.tagName.toLowerCase();
  if (NON_CONTENT_TAGS.has(tag)) return;
  if (isHiddenEl(node)) return;
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) collectVisibleText(children[i], buf);
}

function buildReaderState(doc, opts) {
  const maxText = (opts && opts.maxText) || 20000;
  // Redaction is applied by the caller-supplied redactor (inspect.js's redactSecrets, injected
  // into the same isolated world by background.js) so this path shares ONE pattern table with
  // the inspect path. Callers MUST redact BEFORE truncating: truncation can slice a token in
  // half at the boundary, leaving an orphaned fragment no detector matches anymore.
  const redact = (opts && typeof opts._redact === 'function') ? opts._redact : (s => s);
  const els = [];
  let ref = 0;
  for (const el of doc.querySelectorAll(INTERACTIVE)) {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute && el.getAttribute('type');
    const e = { ref: ref++, tag, role: el.getAttribute && el.getAttribute('role') || null,
                name: redact(accName(el)), type: type || null };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      e.value_present = !!(el.value && String(el.value).length);   // boolean only, never the value
    }
    // Bounding box for the actor (Ghost clicks by coordinate). getBoundingClientRect exists in the
    // live browser; in jsdom it returns zeros, which is fine for the unit test.
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { x:0,y:0,width:0,height:0 };
    e.box = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    els.push(e);
  }
  const buf = [];
  if (doc.body) collectVisibleText(doc.body, buf);
  const bodyText = redact(buf.join(' ').replace(/\s+/g, ' ').trim()).slice(0, maxText);
  return {
    url: (doc.location && doc.location.href) || (doc.defaultView && doc.defaultView.location.href) || '',
    title: redact(doc.title || ''),
    elements: els,
    content: bodyText
  };
}

if (typeof module !== 'undefined') module.exports = { buildReaderState };