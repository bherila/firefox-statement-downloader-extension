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

test('passive merchant providers never mount UI or alter any supported page DOM', async () => {
  const { parseHTML } = require('linkedom');
  const { amz } = require('../scripts/build.js');
  for (const route of ['/your-orders/order-details?orderID=100-1000000-1000000', '/fopo/order-details',
    '/uff/your-account/order-details', '/gp/css/order-history', '/your-orders/orders', '/gc/balance', '/gp/css/gc/balance']) {
    const { document } = parseHTML('<html><body><h1>EXAMPLE PAGE</h1><p>EXAMPLE EXISTING CONTENT</p></body></html>');
    const before = document.documentElement.outerHTML;
    const scheduled = []; let requests = 0; let mounts = 0;
    const scope = vm.createContext({ document, URL, location: { href: `${amz.origin}${route}` },
      setTimeout: (callback) => scheduled.push(callback), MutationObserver: class { observe() {} }, addEventListener() {},
      fetch() { requests += 1; throw new Error('No merchant requests permitted'); },
      browser: { runtime: { async sendMessage(message) { return message.action === 'amzCapturePolicy' ? { ok: true, enabled: true, generation: 0 } : { ok: true }; } } },
    });
    for (const file of ['core/runtime.js', 'providers/amz.js', 'providers/amz-gift-cards.js']) {
      vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), scope);
    }
    scope.FinancialStatementDownloader.mountProvider = () => { mounts += 1; throw new Error('No page UI permitted'); };
    vm.runInContext(fs.readFileSync(contentPath, 'utf8'), scope);
    scheduled.shift()(); await new Promise(setImmediate);
    assert.equal(document.documentElement.outerHTML, before, route);
    assert.equal(mounts, 0, route); assert.equal(requests, 0, route);
  }
});
