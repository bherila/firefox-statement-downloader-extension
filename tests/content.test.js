'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

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

test('content reconciliation automatically observes a supported page without discovery or download', async () => {
  const scheduled = [];
  let observed = 0;
  const provider = { isSupportedPage: () => true, async observePage() { observed += 1; } };
  const context = {
    FinancialStatementDownloader: { providers: { amz: provider }, mountProvider: () => ({ ensureMounted() {} }) },
    document: { documentElement: {} }, setTimeout: (callback) => scheduled.push(callback),
    MutationObserver: class { observe() {} }, addEventListener() {},
  };
  vm.runInNewContext(fs.readFileSync(contentPath, 'utf8'), context);
  scheduled[0]();
  await Promise.resolve();
  assert.equal(observed, 1);
});

test('a text-only receipt mutation schedules a fresh passive observation', async () => {
  const scheduled = [];
  let observeOptions;
  let mutationCallback;
  let observed = 0;
  const provider = { isSupportedPage: () => true, async observePage() { observed += 1; } };
  const context = {
    FinancialStatementDownloader: { providers: { amz: provider }, mountProvider: () => ({ ensureMounted() {} }) },
    document: { documentElement: {} }, setTimeout: (callback) => scheduled.push(callback),
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe(_target, options) { observeOptions = options; }
    }, addEventListener() {},
  };
  vm.runInNewContext(fs.readFileSync(contentPath, 'utf8'), context);
  scheduled.shift()();
  await Promise.resolve();
  assert.equal(observed, 1);
  if (observeOptions.characterData) mutationCallback([{ type: 'characterData' }]);
  if (scheduled.length) scheduled.shift()();
  await Promise.resolve();
  assert.equal(observed, 2);
});
