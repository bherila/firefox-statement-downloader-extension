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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/import-status.js'), 'utf8'), scope);
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

async function settingsPage(settings, response = async () => ({})) {
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '../options.html'), 'utf8'));
  const calls = [];
  const browser = { runtime: { async sendMessage(message) {
    calls.push(message);
    if (message.action === 'importSnapshot') return { ok: true, settings, records: [], queue: {} };
    return { ok: true, ...await response(message) };
  } }, permissions: { async request() { return true; } } };
  const scope = vm.createContext({ document, browser, TextEncoder, Uint8Array, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/import-status.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../options.js'), 'utf8'), scope);
  await new Promise(setImmediate);
  return { document, calls };
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
