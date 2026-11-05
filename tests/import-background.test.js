'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  let handler;
  const calls = [];
  const store = {
    async capture(data) { calls.push(['capture', data]); return { id: 'example', count: 1 }; },
    async snapshot() { return { settings: { enabled: true, userId: 1 }, records: [] }; },
    async configure(value) { calls.push(['configure', value]); },
    async flush() { calls.push(['flush']); return { sent: 0 }; },
    async clear() { calls.push(['clear']); },
  };
  const FSD = { importStore: { createImportStore: () => store },
    importClient: { ORIGIN: 'https://pfifi.com', createImportClient: () => ({}) },
    providers: { amazon: { helpers: { pageKind(value) {
      const url = new URL(value);
      return url.origin === 'https://www.amazon.com' && url.pathname === '/your-orders/order-details' ? 'detail' : null;
    } } } } };
  const browser = {
    runtime: { getURL: (value) => `moz-extension://example/${value}`, onMessage: { addListener(fn) { handler = fn; } }, async openOptionsPage() {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    permissions: { async contains() { return true; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../core/import-background.js'), 'utf8'), {
    FinancialStatementDownloader: FSD, browser, URL,
  });
  return { handler, calls, browser };
}

test('untrusted, private, iframe, and mismatched-order messages cannot capture data', async () => {
  const { handler, calls } = harness();
  const message = { action: 'captureAmazonReceipt', receipt: { order_id: '100-1000000-1000000' } };
  const sender = { url: 'https://www.amazon.com/your-orders/order-details?orderID=100-1000000-1000000', frameId: 0, tab: { id: 1 } };
  for (const override of [{ url: 'https://example.test/' }, { frameId: 1 }, { tab: { id: 1, incognito: true } }]) {
    assert.equal(handler(message, { ...sender, ...override }), undefined);
  }
  assert.equal((await handler({ ...message, receipt: { order_id: '200-2000000-2000000' } }, sender)).ok, false);
  assert.equal(calls.filter(([kind]) => kind === 'capture').length, 0);
  assert.equal((await handler(message, sender)).ok, true);
  assert.equal(calls.filter(([kind]) => kind === 'capture').length, 1);
});

test('only the extension settings page may configure imports or enumerate the outbox', async () => {
  const { handler, calls, browser } = harness();
  const sender = { url: 'https://www.amazon.com/your-orders/order-details?orderID=100-1000000-1000000', frameId: 0, tab: { id: 1 } };
  assert.equal(handler({ action: 'configureImports', enabled: true }, sender), undefined);
  assert.equal(handler({ action: 'importSnapshot' }, sender), undefined);
  const options = { url: 'moz-extension://example/options.html' };
  browser.permissions.contains = async () => false;
  assert.equal((await handler({ action: 'configureImports', enabled: true }, options)).ok, false);
  assert.equal(calls.filter(([kind]) => kind === 'configure').length, 0);
  browser.permissions.contains = async () => true;
  assert.equal((await handler({ action: 'configureImports', enabled: true }, options)).ok, true);
  assert.equal(calls.filter(([kind]) => kind === 'configure').length, 1);
});

test('manifest includes passive provider, background dependencies, optional API access, and packaged settings', () => {
  const manifest = require('../manifest.json');
  const scripts = manifest.background.scripts;
  assert.ok(scripts.indexOf('core/import-client.js') < scripts.indexOf('core/import-store.js'));
  assert.ok(scripts.indexOf('core/import-store.js') < scripts.indexOf('core/import-background.js'));
  assert.ok(manifest.optional_permissions.includes('https://pfifi.com/*'));
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.permissions.includes('https://pfifi.com/*'));
  assert.equal(manifest.options_ui.page, 'options.html');
  assert.ok(manifest.content_scripts[0].js.includes('providers/amazon.js'));
  const build = require('../package.json').scripts.build;
  for (const file of ['options.html', 'options.js', 'options.css']) assert.ok(build.includes(file));
});
