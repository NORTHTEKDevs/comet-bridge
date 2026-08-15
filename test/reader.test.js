const assert = require('node:assert');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { buildReaderState } = require('../extension/reader');

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