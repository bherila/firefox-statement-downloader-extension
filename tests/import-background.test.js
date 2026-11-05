'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { amz } = require('../scripts/build.js');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  let handler;
  let removed;
  const calls = [];
  const store = {
    async capture(data) { calls.push(['capture', data]); return { id: 'example', count: 1 }; },
    async captureGiftCardSnapshot(data) { calls.push(['captureGiftCard', data]); return { id: 'example-gift-card', count: 1 }; },
    async snapshot() { return { settings: { enabled: true, userId: 1 }, records: [] }; },
    async configure(value) { calls.push(['configure', value]); },
    async flush() { calls.push(['flush']); return { sent: 0 }; },
    async clear() { calls.push(['clear']); },
    async stop(reason) { calls.push(['stop', reason]); },
  };
  const FSD = { amz, importStore: { createImportStore: () => store },
    importClient: { ORIGIN: 'https://pfifi.com', createImportClient: () => ({}) },
    providers: { amz: { helpers: { pageKind(value) {
      const url = new URL(value);
      return url.origin === `${amz.origin}` && url.pathname === '/your-orders/order-details' ? 'detail' : null;
    } } } } };
  const browser = {
    runtime: { getURL: (value) => `moz-extension://example/${value}`, onMessage: { addListener(fn) { handler = fn; } }, async openOptionsPage() {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    permissions: { async contains() { return true; }, onRemoved: { addListener(fn) { removed = fn; } } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../core/import-background.js'), 'utf8'), {
    FinancialStatementDownloader: FSD, browser, URL,
  });
  return { handler, calls, browser, store, removed };
}

test('untrusted, private, iframe, and mismatched-order messages cannot capture data', async () => {
  const { handler, calls } = harness();
  const message = { action: 'captureAmzReceipt', receipt: { order_id: '100-1000000-1000000' } };
  const sender = { url: `${amz.origin}/your-orders/order-details?orderID=100-1000000-1000000`, frameId: 0, tab: { id: 1 } };
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
  const sender = { url: `${amz.origin}/your-orders/order-details?orderID=100-1000000-1000000`, frameId: 0, tab: { id: 1 } };
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
  const manifest = require('../scripts/build.js').buildManifest();
  const scripts = manifest.background.scripts;
  assert.ok(scripts.indexOf('core/import-client.js') < scripts.indexOf('core/import-store.js'));
  assert.ok(scripts.indexOf('core/import-store.js') < scripts.indexOf('core/import-background.js'));
  assert.ok(manifest.optional_permissions.includes('https://pfifi.com/*'));
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.permissions.includes('https://pfifi.com/*'));
  assert.equal(manifest.options_ui.page, 'options.html');
  assert.ok(manifest.content_scripts[0].js.includes('providers/amz.js'));
  const { assets } = require('../scripts/build.js');
  for (const file of ['options.html', 'options.js', 'options.css']) assert.ok(assets.includes(file));
});

test('gift-card source capture accepts only loaded top-level balance pages and lists its own source kind', async () => {
  const { handler, calls, store } = harness();
  const message = { action: 'captureAmzGiftCardSnapshot', snapshot: { schema: amz.giftCardSchema } };
  const sender = { url: `${amz.origin}/gc/balance?next=EXAMPLE`, frameId: 0, tab: { id: 1 } };
  for (const override of [{ url: 'https://example.test/gc/balance' }, { url: `${amz.origin}/your-orders/order-details` },
    { frameId: 1 }, { tab: { id: 1, incognito: true } }]) {
    assert.equal(handler(message, { ...sender, ...override }), undefined);
  }
  assert.equal((await handler(message, sender)).ok, true);
  assert.equal(calls.filter(([kind]) => kind === 'captureGiftCard').length, 1);
  store.snapshot = async () => ({ settings: {}, records: [{ id: 'receipt', kind: 'receipt', data: {} }, { id: 'gift', kind: 'gift-card-snapshot', data: {} }] });
  const gift = await handler({ action: 'listAmzGiftCardSnapshots' }, sender);
  assert.equal(gift.snapshots.length, 1);
  assert.equal(gift.snapshots[0].id, 'gift');
  const receipts = await handler({ action: 'listAmzReceipts' }, sender);
  assert.equal(receipts.receipts.length, 1);
  assert.equal(receipts.receipts[0].id, 'receipt');
});

test('revoked destination access stops sending, including a subsequent manual sync', async () => {
  const { handler, calls, browser, removed } = harness();
  await new Promise(setImmediate);
  const before = calls.filter(([kind]) => kind === 'flush').length;
  browser.permissions.contains = async () => false;
  removed({ origins: ['https://pfifi.com/*'] });
  await new Promise(setImmediate);
  const result = await handler({ action: 'syncImports' }, { url: 'moz-extension://example/options.html' });
  assert.equal(result.ok, true);
  assert.ok(calls.some(([kind, reason]) => kind === 'stop' && reason === 'access_revoked'));
  assert.equal(calls.filter(([kind]) => kind === 'flush').length, before);
});

test('account conflict is returned to settings without starting an automatic send', async () => {
  const { handler, calls, store } = harness();
  await new Promise(setImmediate);
  const before = calls.filter(([kind]) => kind === 'flush').length;
  store.configure = async (enabled, options) => {
    assert.equal(enabled, true); assert.equal(options.useNewAccount, false);
    return { requiresAccountChoice: true, accountConflict: { original: { userId: 1 }, active: { userId: 2 } } };
  };
  const result = await handler({ action: 'configureImports', enabled: true }, { url: 'moz-extension://example/options.html' });
  assert.equal(result.requiresAccountChoice, true);
  await new Promise(setImmediate);
  assert.equal(calls.filter(([kind]) => kind === 'flush').length, before);
});
