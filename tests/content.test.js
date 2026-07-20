'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const contentPath = require.resolve('../content.js');

test('content router initializes when no provider supports the current page', () => {
  const observed = [];
  global.FinancialStatementDownloader = { providers: {} };
  global.document = { documentElement: {} };
  global.MutationObserver = class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target, options) { observed.push({ target, options }); }
  };
  global.addEventListener = () => {};

  delete require.cache[contentPath];
  assert.doesNotThrow(() => require(contentPath));
  assert.equal(observed.length, 1);

  delete require.cache[contentPath];
  delete global.FinancialStatementDownloader;
  delete global.document;
  delete global.MutationObserver;
  delete global.addEventListener;
});
