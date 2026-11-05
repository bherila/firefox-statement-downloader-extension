'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../core/import-status.js');
const { describe } = global.FinancialStatementDownloader.importStatus;
const state = (settings = {}, queue = {}) => ({ settings: { enabled: true, userId: 100000001, userName: 'EXAMPLE OWNER', ...settings },
  records: [{ userId: 100000001, status: 'local' }], queue });

test('stopped state wins over sending and retries, with the correct next action', () => {
  for (const [reason, action] of [['sign_in', 'resume'], ['account_changed', 'review'], ['permission', 'open'], ['access_revoked', 'allow']]) {
    const view = describe(state({ stopReason: reason, retryAt: 99999 }, { phase: 'sending', batchCount: 20 }), 1000);
    assert.equal(view.phase, 'Stopped'); assert.equal(view[action], true); assert.equal(view.sync, false);
    assert.equal(view.name, 'EXAMPLE OWNER');
  }
});

test('Waiting and Retrying disable Sync now until their durable deadline', () => {
  for (const [kind, phase] of [['rate_limit', 'Waiting'], ['transient', 'Retrying']]) {
    const view = describe(state({ retryAt: 10000, retryKind: kind }), 1000);
    assert.equal(view.phase, phase); assert.equal(view.sync, false); assert.equal(view.pause, true);
    assert.ok(view.waitingUntil); assert.ok(!view.text.includes('0 receipts sent'));
  }
  assert.equal(describe(state({ retryAt: 10000 }), 10001).sync, true);
});

test('pause, partial waiting, and sending use counts rather than percentage', () => {
  assert.equal(describe(state({ enabled: false }, { phase: 'pausing' })).phase, 'Pausing');
  assert.equal(describe(state({ enabled: false })).phase, 'Paused');
  const sending = describe(state({}, { phase: 'sending', batchCount: 20, pendingCount: 143, remainingCount: 123 }));
  assert.equal(sending.text, 'Sending batch of 20. 123 more after this.');
  assert.equal(describe(state({ userName: null })).name, 'Account 100000001');
});

test('a refused source cannot be described as everything sent', () => {
  const snapshot = state(); snapshot.records[0].status = 'refused';
  const view = describe(snapshot);
  assert.equal(view.phase, 'Needs attention');
  assert.match(view.text, /refused receipt stays here/);
  assert.ok(!view.text.includes('Everything is on pfifi.com'));
});
