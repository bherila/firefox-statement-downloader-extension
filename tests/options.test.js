'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { parseHTML } = require('linkedom');

test('storage refresh cannot permit a second explicit upload while the first is pending', async () => {
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '../options.html'), 'utf8'));
  const uploads = [];
  let storageChanged;
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  Object.defineProperty(document.querySelector('#file'), 'files', { value: [{ name: 'example.pdf', size: 4,
    async arrayBuffer() { return new Uint8Array([37, 80, 68, 70]).buffer; } }] });
  const browser = {
    runtime: { async sendMessage(message) {
      if (message.action === 'uploadImportFile') {
        uploads.push(message); entered(); await held; return { ok: true, remoteId: 1 };
      }
      return { ok: true, settings: { enabled: true, userId: 1 }, records: [] };
    } },
    storage: { onChanged: { addListener(listener) { storageChanged = listener; } } },
  };
  const scope = vm.createContext({ document, browser, TextEncoder, Uint8Array, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/runtime.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/import-status.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/import-list.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../options.js'), 'utf8'), scope);
  await new Promise(setImmediate);
  const button = document.querySelector('#upload');
  button.click();
  await started;
  storageChanged({ 'fsd:imports:records': {} }, 'local');
  await new Promise(setImmediate);
  const disabledDuringRefresh = button.disabled;
  button.click();
  await new Promise(setImmediate);
  const pendingSends = uploads.length;
  release();
  await new Promise(setImmediate);
  assert.equal(disabledDuringRefresh, true);
  assert.equal(pendingSends, 1);
  assert.equal(button.disabled, false);
});

async function settingsPage(settings, response = async () => ({}), records = []) {
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '../options.html'), 'utf8'));
  const calls = [];
  let storageChanged;
  const browser = { storage: { onChanged: { addListener(fn) { storageChanged = fn; } } }, runtime: { async sendMessage(message) {
    calls.push(message);
    if (message.action === 'importSnapshot') return { ok: true, settings, records, queue: {} };
    return { ok: true, ...await response(message) };
  } }, permissions: { async request() { return true; } } };
  const scope = vm.createContext({ document, browser, TextEncoder, Uint8Array, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/runtime.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/import-status.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/import-list.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../options.js'), 'utf8'), scope);
  await new Promise(setImmediate);
  return { document, calls, async refreshUI() { storageChanged({ 'fsd:imports:records': {} }, 'local'); await new Promise(setImmediate); } };
}

test('Waiting disables Sync now, shows the time and preserves the account name', async () => {
  const { document } = await settingsPage({ enabled: true, userId: 100000001, userName: 'EXAMPLE OWNER', retryAt: Date.now() + 60000, retryKind: 'rate_limit' });
  assert.equal(document.querySelector('#sync').disabled, true);
  assert.match(document.querySelector('#connection').textContent, /asked us to slow down.*Nothing's lost/);
  assert.match(document.querySelector('#sync-wait').textContent, /Try again around/);
  assert.match(document.querySelector('#account').textContent, /EXAMPLE OWNER/);
});

test('Resume presents both account names before an explicit new-recipient choice', async () => {
  const settings = { enabled: false, userId: 100000001, userName: 'EXAMPLE ORIGINAL' };
  const { document, calls } = await settingsPage(settings, async (message) => {
    if (message.action === 'configureImports' && !message.useNewAccount) {
      settings.stopReason = 'account_changed';
      settings.accountConflict = { original: { userId: 100000001, userName: 'EXAMPLE ORIGINAL' }, active: { userId: 200000001, userName: 'EXAMPLE NEW' } };
      return { requiresAccountChoice: true, accountConflict: settings.accountConflict };
    }
    if (message.useNewAccount) { settings.userId = 200000001; settings.userName = 'EXAMPLE NEW'; settings.enabled = true; settings.accountConflict = null; settings.stopReason = null; }
    return {};
  });
  document.querySelector('#resume').click();
  await new Promise(setImmediate);
  assert.equal(document.querySelector('#account-choice').hidden, false);
  assert.match(document.querySelector('#account-comparison').textContent, /EXAMPLE ORIGINAL.*EXAMPLE NEW.*Nothing will send/);
  assert.equal(settings.userId, 100000001);
  assert.equal(calls.filter((message) => message.action === 'configureImports').length, 1);
  document.querySelector('#use-new-account').click();
  await new Promise(setImmediate);
  assert.equal(settings.userId, 200000001);
  assert.equal(calls.filter((message) => message.action === 'configureImports')[1].useNewAccount, true);
});

test('balance capture is off by default and changes only through the explicit switch', async () => {
  let enabled = false;
  const { document, calls } = await settingsPage({ enabled: false, userId: null }, async (message) => {
    if (message.action === 'configureCapturePreferences') enabled = message.giftCardsEnabled;
    return { giftCardsEnabled: enabled };
  });
  const checkbox = document.querySelector('#collect-gift-cards');
  assert.equal(checkbox.checked, false);
  assert.equal(calls.some((message) => message.action === 'configureCapturePreferences'), false);
  checkbox.checked = true; checkbox.dispatchEvent(new document.defaultView.Event('change'));
  await new Promise(setImmediate);
  assert.equal(enabled, true);
  assert.equal(calls.filter((message) => message.action === 'configureCapturePreferences').length, 1);
});

test('settings exports held source bytes only, leaving sent metadata out of the archive', async () => {
  const data = { order_id: '100-1000000-1000000', items: [{}], warnings: [] };
  let archive;
  const { document } = await settingsPage({ enabled: false, userId: 100000001 }, async (message) => {
    if (message.action === 'downloadData') archive = JSON.parse(new TextDecoder().decode(new Uint8Array(message.data)));
    return {};
  }, [{ id: 'example-held', kind: 'receipt', userId: 100000001, status: 'local', createdAt: '2026-01-01T00:00:00.000Z', data },
    { id: 'example-sent', kind: 'receipt', userId: 100000001, status: 'received', createdAt: '2026-01-02T00:00:00.000Z', summary: { orderId: '200-2000000-2000000', itemCount: 2, warnings: [] } }]);
  document.querySelector('#export').click(); await new Promise(setImmediate);
  assert.deepEqual(archive.receipts, [data]); assert.deepEqual(archive.gift_card_snapshots, []);
});

test('the rendered settings list shows one row per order and fifty rows per page', async () => {
  const records = Array.from({ length: 120 }, (_, index) => ({ id: `example-${index}`, kind: 'receipt', userId: 100000001, status: 'received',
    createdAt: new Date(1767225600000 + index).toISOString(), summary: { orderId: `100-${String(index).padStart(7, '0')}-1000000`, itemCount: 2, warnings: [] } }));
  const { document } = await settingsPage({ enabled: false, userId: 100000001 }, async () => ({}), records);
  assert.equal(document.querySelector('#receipts').children.length, 50);
  document.querySelector('#next').click(); document.querySelector('#next').click();
  assert.equal(document.querySelector('#receipts').children.length, 20);
  assert.match(document.querySelector('#page').textContent, /Page 3 of 3/);
  const search = document.querySelector('#search'); search.value = '100-0000001-1000000';
  search.dispatchEvent(new document.defaultView.Event('input'));
  assert.equal(document.querySelector('#receipts').children.length, 1);
});

test('polling and an unrelated new capture preserve an expanded refusal explanation', async () => {
  const order = '100-1000000-1000000';
  const records = [{ id: 'example-refused', kind: 'receipt', userId: 100000001, status: 'refused', error: 'EXAMPLE REFUSAL EXPLANATION',
    createdAt: '2026-01-01T00:00:00.000Z', data: { order_id: order, items: [{}], warnings: [] } }];
  const { document, refreshUI } = await settingsPage({ enabled: true, userId: 100000001 }, async () => ({}), records);
  const explanation = document.querySelector('#receipts details'); explanation.setAttribute('open', '');
  await refreshUI();
  assert.ok(document.querySelector('#receipts details') === explanation, 'Unchanged rows keep their DOM and keyboard focus');
  records.push({ id: 'example-other', kind: 'receipt', userId: 100000001, status: 'received', createdAt: '2026-01-02T00:00:00.000Z',
    summary: { orderId: '200-2000000-2000000', itemCount: 2, warnings: [] } });
  await refreshUI();
  const original = [...document.querySelectorAll('#receipts > li')].find((row) => row.textContent.includes(order));
  assert.equal(original.querySelector('details').hasAttribute('open'), true);
  assert.match(original.textContent, /EXAMPLE REFUSAL EXPLANATION/);
});

test('an unchanged empty filtered result still updates its empty-collection explanation', async () => {
  const records = [];
  const { document, refreshUI } = await settingsPage({ enabled: true, userId: 100000001 }, async () => ({}), records);
  const search = document.querySelector('#search'); search.value = 'EXAMPLE NO MATCH';
  search.dispatchEvent(new document.defaultView.Event('input'));
  assert.match(document.querySelector('#receipts').textContent, /Receipts you capture appear here/);
  records.push({ id: 'example-other', kind: 'receipt', userId: 100000001, status: 'received', createdAt: '2026-01-01T00:00:00.000Z',
    summary: { orderId: '100-1000000-1000000', itemCount: 2, warnings: [] } });
  await refreshUI();
  assert.equal(document.querySelector('#receipts').textContent, 'No receipts match these filters.');
});
