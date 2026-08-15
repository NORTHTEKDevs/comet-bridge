const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { scrapePerplexityAnswer } = require('../extension/scrape');

const html = fs.readFileSync(__dirname + '/fixtures/perplexity-answer.html', 'utf8');
const doc = new JSDOM(html).window.document;

test('extracts a non-empty answer mentioning the queried fact', () => {
  const out = scrapePerplexityAnswer(doc);
  assert.ok(out.answer && out.answer.length > 0, 'answer should be non-empty');
  assert.ok(/Paris/.test(out.answer), 'answer should mention Paris');
});

test('extracts external sources, excluding Perplexity nav links', () => {
  const out = scrapePerplexityAnswer(doc);
  assert.ok(Array.isArray(out.sources) && out.sources.length >= 1, 'at least one source');
  assert.ok(out.sources.every(s => !/perplexity\.ai/.test(s.url)), 'no perplexity nav links');
  assert.ok(out.sources.some(s => /adelphi\.edu/.test(s.url)), 'real source link captured');
  assert.ok(out.sources[0].url.startsWith('http'));
});

test('returns selectors_stale on a doc with no answer container', () => {
  const empty = new JSDOM('<html><body></body></html>').window.document;
  assert.equal(scrapePerplexityAnswer(empty).error, 'selectors_stale');
});
