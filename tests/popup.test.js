'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm'); const { parseHTML } = require('linkedom');
async function popup(result) {
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8'));
  const browser = { tabs: { async query() { return [{ id: 1 }]; } }, runtime: {
    async sendMessage(message) { assert.equal(message.action, 'popupSnapshot'); return result; }, async openOptionsPage() {},
  } };
  const scope = vm.createContext({ document, browser, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/runtime.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8'), scope);
  await new Promise(setImmediate); return document;
}
const basic = { ok: true, private: false, current: null, recent: [], queueStatus: { text: 'Paused by you. New receipts save here and wait.' } };

test('popup confirms Saved only from an acknowledged state and identifies partial missing fields', async () => {
  const loading = await popup(basic);
  assert.equal(loading.querySelector('#current').textContent, 'No receipt has been confirmed for this tab.');
  const document = await popup({ ...basic, current: { state: 'partial', orderId: '100-1000000-1000000', kind: 'receipt', warnings: ['order_total_missing'], status: 'local' } });
  assert.match(document.querySelector('#current').textContent, /Saved as partial/);
  assert.equal(document.querySelector('#detail').textContent, "Grand total as printed wasn't found.");
});

test('popup explains a storage refusal without pretending the order was saved', async () => {
  const document = await popup({ ...basic, current: { state: 'storage_refused', orderId: '100-1000000-1000000' } });
  assert.match(document.querySelector('#current').textContent, /wasn't saved/);
  assert.match(document.querySelector('#detail').textContent, /Export what's held here.*free room/);
});

test('popup explains the code privacy rejection without suggesting a storage cleanup', async () => {
  const document = await popup({ ...basic, current: { state: 'storage_refused', reason: 'privacy', orderId: '100-1000000-1000000' } });
  assert.match(document.querySelector('#current').textContent, /wasn't saved/);
  assert.match(document.querySelector('#detail').textContent, /may contain a redeemable code/);
  assert.doesNotMatch(document.querySelector('#detail').textContent, /free room|Export/);
});

test('private popup shows no Recent or queue data', async () => {
  const document = await popup({ ok: true, private: true });
  assert.equal(document.querySelector('#current').textContent, "Private windows aren't collected.");
  assert.equal(document.querySelector('#queue-section').hidden, true);
  assert.equal(document.querySelector('#recent-section').hidden, true);
  assert.equal(document.querySelector('#recent').children.length, 0);
});

test('history counts and unsaved orders are read-only with no order links or open-all control', async () => {
  const document = await popup({ ...basic, current: { state: 'history', totalCount: 10, savedCount: 6, unsavedOrderIds: ['100-1000000-1000000'] } });
  assert.equal(document.querySelector('#history-count').textContent, 'On this page: 6 of 10 orders saved');
  assert.equal(document.querySelectorAll('#history a').length, 0);
  assert.equal(document.querySelector('#unsaved').children.length, 1);
  const unreliable = await popup({ ...basic, current: { state: 'history' } });
  assert.equal(unreliable.querySelector('#history').hidden, true);
});

test('an unchanged acknowledged sent source says it is already on pfifi.com', async () => {
  const document = await popup({ ...basic, current: { state: 'saved', orderId: '100-1000000-1000000', kind: 'receipt', status: 'received', alreadySaved: true } });
  assert.match(document.querySelector('#current').textContent, /already on pfifi.com/);
});
