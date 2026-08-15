// DevTools-equivalent page inspection, extension-based (no CDP, no debug port - a debug port would
// make the whole browser detectable). Every string field is redacted by default before it leaves
// this module; opt out only via `opts.noRedact === true`. Cookies are a separate opt-in
// (`opts.allowCookies`) - never covered by requesting other kinds. Fails closed: an unrecognized
// kind returns `{ error }` for the WHOLE call, never a partial result.
//
// Pure-function core (`buildInspection`) mirrors reader.js's style: it takes pre-fetched/injected
// data (script text map, performance-resource array, console ring buffer) as `opts` so it stays
// jsdom-testable without any chrome.* API calls. The browser-side glue that gathers those inputs
// lives in background.js.

const REDACTED = '[REDACTED]';
const DEFAULT_MAX_LEN = 20000;
const KNOWN_KINDS = new Set(['source', 'scripts', 'styles', 'resources', 'computed', 'console', 'cookies']);
const COMPUTED_STYLE_ALLOWLIST = [
  'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight',
  'display', 'visibility', 'position', 'width', 'height', 'zIndex', 'opacity'
];

// Ported from comet-mcp/src/egress.ts `looksLikeCredential`, kept as ONE exported constant so the
// pattern table is reviewable and testable in isolation. The assignment pattern accepts an OPTIONAL
// compounding prefix (`session_token=`, `authToken=`, `MY_API_KEY=`) with an optional hyphen/
// underscore separator before the keyword, and matches the keyword itself case-insensitively -
// so a joined field name is not silently missed the way Phase 4's literal-only pattern was
// (`delete-account` evading a `delete account` match). A bare "keyword=value" (no prefix) still
// matches because the prefix group is itself optional.
const CREDENTIAL_PATTERNS = {
  // Vendor-specific token prefixes. NO \b anchor: comet-mcp's twin uses `s.includes(prefix)`, so a
  // word-glued occurrence like `mysk-test123` is caught there but was MISSED here - the two copies
  // had drifted apart on exactly the boundary-anchor question that has bitten this codebase before.
  prefixed: /(sk-|nvapi-|ghp_|AKIA|xox)[A-Za-z0-9_-]*/g,
  pem: /-----BEGIN[\s\S]*?-----END[^\n-]*-----/g,
  // The optional-PREFIX-only form still missed the keyword appearing anywhere else in a compound
  // identifier: `tokenSecretValue=`, `my_password_field=` and `apiSecret=` all leaked in full
  // (verified 2026-08-14 against the built comet-mcp twin, which had the same defect). Allow
  // identifier characters on BOTH sides of the keyword and broaden the keyword set - `secret` was
  // missing entirely. Kept byte-for-byte in step with comet-mcp/src/egress.ts's ASSIGNMENT_RE: two
  // copies of a pattern table is exactly how coverage drifts, so change BOTH or neither.
  // Value captures a quoted string in full, or up to 6 whitespace-separated tokens when unquoted -
  // a `\S+` value stopped at the first space, so a multi-word passphrase
  // ("password: correct horse battery staple") leaked all but its first word. Bounded on purpose:
  // capturing to end-of-line would destroy a whole minified JS line in inspect output.
  assignment: /[A-Za-z0-9_.[\]"'-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|credential|authorization|private[_-]?key|access[_-]?key)[A-Za-z0-9_.[\]"'-]*\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;!?]+(?:[ \t]+[^\s,;!?-][^\s,;!?]*){0,5})/gi,
  // Continuous base64/hex-charset run, no whitespace break (mirrors egress.ts CANDIDATE_TOKEN_RE).
  candidateToken: /[A-Za-z0-9+/=_-]{20,}/g,
  // Continuous digit run (mirrors egress.ts DIGIT_RUN_RE).
  digitRun: /\d{13,}/g
};

function isHighEntropyToken(tok) {
  if (tok.length < 20) return false;
  const hasDigit = /[0-9]/.test(tok);
  const hasAlpha = /[A-Za-z]/.test(tok);
  const uniqueChars = new Set(tok).size;
  return hasDigit && hasAlpha && uniqueChars >= 8;
}

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function isNumericSecret(run) {
  if (run.length >= 15) return true;
  return run.length >= 13 && run.length <= 19 && luhnValid(run);
}

// Exported so the pattern table is independently testable, matching egress.ts's own convention.
function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  out = out.replace(CREDENTIAL_PATTERNS.pem, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS.prefixed, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS.assignment, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS.candidateToken, m => (isHighEntropyToken(m) ? REDACTED : m));
  out = out.replace(CREDENTIAL_PATTERNS.digitRun, m => (isNumericSecret(m) ? REDACTED : m));
  return out;
}

function maybeRedact(text, opts) {
  if (text === null || text === undefined) return text;
  const s = String(text);
  return (opts && opts.noRedact) ? s : redactSecrets(s);
}

function truncate(s, opts) {
  if (typeof s !== 'string') return s;
  const maxLen = (opts && typeof opts.maxLen === 'number' && opts.maxLen > 0) ? opts.maxLen : DEFAULT_MAX_LEN;
  return s.length > maxLen ? s.slice(0, maxLen) + '...[truncated]' : s;
}

function buildScripts(doc, opts) {
  const scriptTexts = (opts && opts.scriptTexts) || {};
  const out = [];
  for (const el of doc.querySelectorAll('script[src]')) {
    const src = el.getAttribute('src');
    const entry = { url: maybeRedact(src, opts) };
    if (Object.prototype.hasOwnProperty.call(scriptTexts, src)) {
      entry.text = maybeRedact(truncate(scriptTexts[src], opts), opts);
    }
    out.push(entry);
  }
  return out;
}

function buildStyles(doc, opts) {
  const links = [];
  for (const el of doc.querySelectorAll('link[rel="stylesheet"]')) {
    const href = el.getAttribute('href');
    if (href) links.push(maybeRedact(href, opts));
  }
  const inline = [];
  for (const el of doc.querySelectorAll('style')) {
    inline.push(maybeRedact(truncate(el.textContent || '', opts), opts));
  }
  return { links, inline };
}

function buildResources(entries, opts) {
  const list = Array.isArray(entries) ? entries : [];
  const maxEntries = (opts && opts.maxResourceEntries) || 200;
  return list.slice(0, maxEntries).map(e => ({
    name: maybeRedact(truncate(String((e && e.name) || ''), opts), opts),
    initiatorType: (e && e.initiatorType) || '',
    duration: (e && typeof e.duration === 'number') ? e.duration : 0,
    transferSize: (e && typeof e.transferSize === 'number') ? e.transferSize : 0
  }));
}

function buildComputed(doc, opts) {
  const name = opts && opts.name;
  if (!name) return {};
  const el = doc.getElementById(name) || doc.querySelector(name);
  if (!el) return {};
  const win = doc.defaultView;
  if (!win || typeof win.getComputedStyle !== 'function') return {};
  const cs = win.getComputedStyle(el);
  const out = {};
  for (const prop of COMPUTED_STYLE_ALLOWLIST) {
    const v = cs[prop];
    if (v !== undefined && v !== '') out[prop] = maybeRedact(String(v), opts);
  }
  return out;
}

function buildConsole(entries, opts) {
  const list = Array.isArray(entries) ? entries : [];
  const maxEntries = (opts && opts.maxConsoleEntries) || 200;
  return list.slice(-maxEntries).map(e => maybeRedact(truncate(String(e), opts), opts));
}

function buildInspection(doc, opts) {
  opts = opts || {};
  const kinds = Array.isArray(opts.kinds) ? opts.kinds : [];
  for (const k of kinds) {
    if (!KNOWN_KINDS.has(k)) return { error: `unknown inspection kind: ${k}` };
  }
  const out = {};
  for (const kind of kinds) {
    if (kind === 'source') {
      const html = doc.documentElement ? doc.documentElement.outerHTML : '';
      out.source = maybeRedact(truncate(html, opts), opts);
    } else if (kind === 'scripts') {
      out.scripts = buildScripts(doc, opts);
    } else if (kind === 'styles') {
      out.styles = buildStyles(doc, opts);
    } else if (kind === 'resources') {
      out.resources = buildResources(opts.resourceEntries, opts);
    } else if (kind === 'computed') {
      out.computed = buildComputed(doc, opts);
    } else if (kind === 'console') {
      out.console = buildConsole(opts.consoleEntries, opts);
    } else if (kind === 'cookies') {
      // Cookies are a separate opt-in (session-token theft surface) - absent, not errored, when
      // not explicitly allowed, so a caller that forgets the flag simply gets no cookie data.
      if (opts.allowCookies) out.cookies = maybeRedact(String(doc.cookie || ''), opts);
    }
  }
  return out;
}

// Browser-side console capture: wraps console.{log,warn,error,info} and keeps a bounded ring
// buffer of stringified entries on `window.__cometInspectConsole`, redacted on read (not on
// write, so noRedact callers can still see the raw entries). No-ops outside a real browser window
// (e.g. under node:test / jsdom-via-require), and idempotent so re-injection never double-wraps.
(function installConsoleHook() {
  if (typeof window === 'undefined' || window.__cometInspectHooked) return;
  window.__cometInspectHooked = true;
  window.__cometInspectConsole = [];
  const MAX_ENTRIES = 200;
  for (const method of ['log', 'warn', 'error', 'info']) {
    const orig = console[method];
    if (typeof orig !== 'function') continue;
    console[method] = function (...args) {
      try {
        const line = args.map(a => {
          try { return typeof a === 'string' ? a : JSON.stringify(a); }
          catch { return String(a); }
        }).join(' ');
        window.__cometInspectConsole.push(`[${method}] ${line}`);
        if (window.__cometInspectConsole.length > MAX_ENTRIES) window.__cometInspectConsole.shift();
      } catch { /* the hook must never break real logging */ }
      return orig.apply(console, args);
    };
  }
})();

if (typeof module !== 'undefined') {
  module.exports = { buildInspection, redactSecrets, CREDENTIAL_PATTERNS };
}
