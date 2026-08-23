const assert = require('node:assert');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { buildReaderState } = require('../extension/reader');
const { redactSecrets } = require('../extension/inspect');

test('maps interactive elements with opaque refs and hides password values', () => {
  const dom = new JSDOM(`<html><body>
    <a href="https://x.com/a">Open X</a>
    <button id="b1">Send</button>
    <input type="text" name="q" value="hello">
    <input type="password" name="pw" value="SECRET">
  </body></html>`, { url: "https://app.example.com/inbox" });
  const s = buildReaderState(dom.window.document);
  assert.equal(s.url, "https://app.example.com/inbox");
  const kinds = s.elements.map(e => e.tag);
  assert.ok(kinds.includes('a') && kinds.includes('button') && kinds.includes('input'));
  const pw = s.elements.find(e => e.type === 'password');
  assert.equal(pw.value_present, true);
  assert.equal('value' in pw, false);           // raw password value NEVER included
  assert.ok(s.elements.every(e => typeof e.ref === 'number')); // opaque numeric refs
  assert.ok(JSON.stringify(s).indexOf('SECRET') === -1); // no secret anywhere in output
});

test('excludes inline script/style source and hidden-element text from content', () => {
  const dom = new JSDOM(`<html><body>
    <script>var apiKey = "SK-LIVE-SECRET-123";</script>
    <style>.x { color: red; } /* CSS-SECRET-TOKEN */</style>
    <div style="display:none">HiddenDisplayNoneSecret</div>
    <div aria-hidden="true">AriaHiddenSecret</div>
    <p>Visible paragraph text</p>
  </body></html>`, { url: "https://app.example.com/inbox" });
  const s = buildReaderState(dom.window.document);
  assert.ok(s.content.indexOf('SK-LIVE-SECRET-123') === -1, 'script source leaked into content');
  assert.ok(s.content.indexOf('CSS-SECRET-TOKEN') === -1, 'style source leaked into content');
  assert.ok(s.content.indexOf('HiddenDisplayNoneSecret') === -1, 'display:none text leaked into content');
  assert.ok(s.content.indexOf('AriaHiddenSecret') === -1, 'aria-hidden text leaked into content');
  assert.ok(s.content.indexOf('Visible paragraph text') !== -1, 'visible text should still be present');
});
test('redacts visible secret-shaped text and element names via the shared redactor', () => {
  const dom = new JSDOM(`<html><body>
    <button aria-label="token sk-live-abcdefghijklmnop123456">Go</button>
    <p>key is sk-live-abcdefghijklmnop123456 in plain sight</p>
  </body></html>`, { url: "https://app.example.com/inbox" });
  const s = buildReaderState(dom.window.document, { _redact: redactSecrets });
  assert.equal(JSON.stringify(s).indexOf('sk-live-abcdefghijklmnop123456'), -1, 'raw token leaked');
  assert.ok(s.content.indexOf('[REDACTED]') !== -1, 'content should carry the redaction marker');
});

test('redacts BEFORE truncation: a token straddling maxText is fully redacted', () => {
  const pad = 'x'.repeat(19980);
  const tok = 'A1b2C3d4E5f6G7h8I9j0K2l3M4n5o6'; // 30 chars, high-entropy shape
  const dom = new JSDOM(`<html><body><p>${pad} ${tok}</p></body></html>`,
    { url: "https://app.example.com/inbox" });
  const s = buildReaderState(dom.window.document, { maxText: 20000, _redact: redactSecrets });
  assert.equal(s.content.indexOf(tok.slice(0, 14)), -1,
    'boundary-sliced fragment leaked; redaction must run before truncation');
});
