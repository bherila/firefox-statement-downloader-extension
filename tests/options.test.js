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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../options.js'), 'utf8'), {
    document, browser, TextEncoder, Uint8Array, Date,
  });
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
