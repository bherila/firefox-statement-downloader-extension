'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { amz } = require('../scripts/build.js');

const ORDER = '100-1000000-1000000';
const order = (index) => `100-1000000-${1000000 + index}`;
const detail = (id = ORDER) => `${amz.origin}/your-orders/order-details?orderID=${id}`;
const popup = { url: 'moz-extension://example/popup.html' };
const options = { url: 'moz-extension://example/options.html' };
function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); }, emit(...args) { for (const listener of listeners) listener(...args); } };
}
function record(index = 0, changes = {}) {
  return { id: `source-${index}`, kind: 'receipt', status: 'local', userId: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    data: { order_id: order(index), marketplace: amz.marketplace, warnings: [],
      items: [{ title: 'EXAMPLE PRIVATE ITEM', unit_price_cents: 1234 }], total_cents: 1234 }, ...changes };
}
function harness(initialRecords = []) {
  const state = { settings: { enabled: true, userId: 1 }, records: initialRecords, queue: { phase: 'ready' } };
  const open = new Map([
    [1, { id: 1, incognito: false, url: detail() }],
    [2, { id: 2, incognito: false, url: 'https://example.test/' }],
    [99, { id: 99, incognito: true, url: detail() }],
  ]);
  const storageValues = {};
  const badges = new Map(); const badgeCalls = []; const notifications = []; const forbiddenCalls = [];
  let snapshotReads = 0;
  const store = { async snapshot() { snapshotReads += 1; return structuredClone(state); } };
  const onMessage = event(); const onChanged = event();
  const tabEvents = { onCreated: event(), onUpdated: event(), onRemoved: event() };
  const forbidden = (name) => () => { forbiddenCalls.push(name); throw new Error(`Unexpected ${name}`); };
  const browser = {
    runtime: { getURL: (file) => `moz-extension://example/${file}`, onMessage },
    tabs: { ...tabEvents, async get(id) { if (!open.has(id)) throw new Error('Example closed tab'); return structuredClone(open.get(id)); },
      async query() { return structuredClone([...open.values()]); },
      async sendMessage(id, message) { notifications.push({ id, message }); },
      create: forbidden('tabs.create'), update: forbidden('tabs.update'), executeScript: forbidden('executeScript') },
    browserAction: { async setBadgeText(value) { assert.ok(Number.isInteger(value.tabId)); badgeCalls.push(value); badges.set(value.tabId, value.text); } },
    storage: { onChanged, local: {
      async get(keys) { return Object.fromEntries(keys.filter((key) => Object.hasOwn(storageValues, key)).map((key) => [key, structuredClone(storageValues[key])])); },
      async set(values) { const changes = {}; for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: storageValues[key], newValue: value }; storageValues[key] = structuredClone(value); } onChanged.emit(changes, 'local'); },
    } },
  };
  const scope = { browser, URL, fetch: forbidden('fetch'),
    document: new Proxy({}, { get: forbidden('document access') }) };
  for (const file of ['core/runtime.js', 'providers/amz.js', 'core/import-status.js', 'core/capture-background.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), scope, { filename: file });
  }
  const surface = scope.FinancialStatementDownloader.captureBackground.create(store);
  const message = (body, sender = popup) => {
    for (const listener of onMessage.listeners) {
      const result = listener(body, sender); if (result !== undefined) return result;
    }
    return undefined;
  };
  return { state, open, storageValues, badges, badgeCalls, notifications, forbiddenCalls, browser, surface, message,
    sender(id = 1) { return { url: open.get(id).url, tab: structuredClone(open.get(id)), frameId: 0 }; },
    reads: () => snapshotReads, tabEvents, onChanged, scope };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('source policy trusts only supported top-level pages and disables private and gift-card collection by default', async () => {
  const { surface, message, sender, open } = harness();
  assert.equal((await surface.policy(sender())).enabled, true);
  assert.equal((await message({ action: 'amzCapturePolicy' }, sender(99))).enabled, false);
  open.set(3, { id: 3, incognito: false, url: `${amz.origin}/gc/balance` });
  const giftPolicy = await message({ action: 'amzCapturePolicy' }, sender(3));
  assert.equal(giftPolicy.enabled, false); assert.equal(giftPolicy.generation, 0);
  for (const override of [{ frameId: 1 }, { url: `${amz.origin}.evil.example.test/your-orders/order-details` },
    { url: `${amz.origin}/ap/signin` }, { tab: undefined }]) {
    assert.equal(message({ action: 'amzCapturePolicy' }, { ...sender(), ...override }), undefined);
  }
});

test('a saved indicator requires an acknowledged record and contains no source items or prices', async () => {
  const { surface, message, sender, state, badges } = harness();
  await surface.refresh();
  assert.equal((await message({ action: 'popupSnapshot', tabId: 1 })).current, null);
  await surface.saved(sender(), undefined, { order_id: ORDER }, 'receipt');
  await surface.saved(sender(), { id: 'unacknowledged' }, { order_id: ORDER }, 'receipt');
  assert.equal((await message({ action: 'popupSnapshot', tabId: 1 })).current, null);
  state.records.push(record());
  await surface.saved(sender(), { id: 'source-0', alreadySaved: false }, state.records[0].data, 'receipt');
  const result = await message({ action: 'popupSnapshot', tabId: 1 });
  assert.equal(result.current.state, 'saved'); assert.equal(result.current.status, 'local');
  assert.equal(result.current.id, 'source-0'); assert.equal(badges.get(1), '✓');
  const serialized = JSON.stringify(result);
  for (const excluded of ['EXAMPLE PRIVATE ITEM', 'unit_price_cents', 'total_cents', '1234', 'csrf']) assert.ok(!serialized.includes(excluded));
});

test('middle-clicked captures across thirty tabs yield a full pending count and only the last twenty saves', async () => {
  const { surface, state, open, sender, message, badges } = harness();
  for (let index = 0; index < 30; index += 1) {
    const id = index + 100;
    open.set(id, { id, incognito: false, url: detail(order(index)) });
    state.records.push(record(index, { createdAt: '2026-01-01T00:00:00.000Z' }));
    await surface.saved(sender(id), { id: `source-${index}`, alreadySaved: false }, state.records[index].data, 'receipt');
  }
  const result = await message({ action: 'popupSnapshot', tabId: 2 });
  assert.equal(result.pendingCount, 30); assert.equal(result.recent.length, 20);
  assert.deepEqual(Array.from(result.recent, (item) => item.orderId), Array.from({ length: 20 }, (_, index) => order(29 - index)));
  assert.equal(badges.get(2), '30');
  assert.equal(badges.get(99), '');
});

test('duplicates confirm already saved without duplicating or reordering Recent', async () => {
  const { surface, message, sender, state } = harness([record(0), record(1)]);
  const before = await message({ action: 'popupSnapshot', tabId: 2 });
  await surface.saved(sender(), { id: 'source-0', alreadySaved: true }, state.records[0].data, 'receipt');
  const after = await message({ action: 'popupSnapshot', tabId: 1 });
  assert.equal(after.current.alreadySaved, true);
  assert.deepEqual(plain(after.recent), plain(before.recent));
});

test('partial and unreadable states are local to their tab while refused sources and stops win everywhere except private', async () => {
  const { surface, message, sender, state, badges } = harness([record(0, { data: { order_id: ORDER, warnings: ['item_price_missing'] } })]);
  await surface.saved(sender(), { id: 'source-0' }, state.records[0].data, 'receipt');
  assert.equal(badges.get(1), '~');
  assert.equal((await message({ action: 'popupSnapshot', tabId: 1 })).current.warnings[0], 'item_price_missing');
  await message({ action: 'amzPageStatus', state: 'unreadable' }, sender());
  assert.equal(badges.get(1), '?'); assert.equal(badges.get(2), '1');
  state.records[0].status = 'refused'; await surface.refresh();
  assert.equal(badges.get(1), '!'); assert.equal(badges.get(2), '!'); assert.equal(badges.get(99), '');
  state.records[0].status = 'received'; state.settings.stopReason = 'sign_in'; await surface.refresh();
  assert.equal(badges.get(1), '!'); assert.equal(badges.get(2), '!'); assert.equal(badges.get(99), '');
});

test('storage refusal says the order was not saved and raises global attention without exposing raw errors', async () => {
  const { surface, sender, message, badges } = harness();
  await surface.failed(sender(), ORDER, Object.assign(new Error('EXAMPLE PRIVATE STORAGE MESSAGE'), { name: 'QuotaExceededError' }));
  const snapshot = await message({ action: 'popupSnapshot', tabId: 1 });
  assert.equal(snapshot.current.state, 'storage_refused'); assert.equal(snapshot.current.orderId, ORDER);
  assert.equal(snapshot.current.reason, 'quota'); assert.equal(snapshot.recent.length, 0);
  assert.ok(!JSON.stringify(snapshot).includes('EXAMPLE PRIVATE STORAGE MESSAGE'));
  assert.equal(badges.get(1), '!'); assert.equal(badges.get(2), '!'); assert.equal(badges.get(99), '');
});

test('private popup responses never read or expose the source store, even while global attention is active', async () => {
  const { surface, message, sender, state, reads, badges } = harness([record()]);
  state.settings.stopReason = 'account_changed';
  await surface.failed(sender(), ORDER, new Error('Example failure'));
  const before = reads();
  assert.deepEqual(plain(await message({ action: 'popupSnapshot', tabId: 99 })), { ok: true, private: true });
  assert.equal(reads(), before);
  assert.deepEqual(plain(await message({ action: 'popupSnapshot', tabId: 1 }, { ...popup, tab: { incognito: true } })), { ok: true, private: true });
  assert.equal(reads(), before); assert.equal(badges.get(99), '');
  await surface.saved(sender(99), { id: 'source-0' }, { order_id: ORDER }, 'receipt');
  assert.equal(reads(), before);
});

test('popup access is limited to the exact extension page and independently verifies the requested tab', async () => {
  const { message, sender, browser } = harness([record()]);
  for (const actor of [sender(), options, { url: `${popup.url}?example` }, { url: 'https://example.test/popup.html' }]) {
    assert.equal(message({ action: 'popupSnapshot', tabId: 1 }, actor), undefined);
  }
  assert.equal((await message({ action: 'popupSnapshot', tabId: '1' })).ok, false);
  assert.equal((await message({ action: 'popupSnapshot', tabId: 10000 })).ok, false);
  const original = browser.tabs.get;
  browser.tabs.get = async (id) => ({ ...await original(id), incognito: true });
  assert.deepEqual(plain(await message({ action: 'popupSnapshot', tabId: 1 })), { ok: true, private: true });
});

test('history counts require a reliable validated list and count saved orders across tabs without links', async () => {
  const { open, sender, message } = harness([record(0), record(0, { id: 'revision' }), record(1)]);
  open.set(1, { id: 1, incognito: false, url: `${amz.origin}/your-orders/orders?page=1` });
  await message({ action: 'amzPageStatus', state: 'history', orderIds: [order(0), order(1), order(2)] }, sender());
  let current = (await message({ action: 'popupSnapshot', tabId: 1 })).current;
  assert.equal(current.savedCount, 2); assert.equal(current.totalCount, 3);
  assert.deepEqual(Array.from(current.unsavedOrderIds), [order(2)]);
  for (const orderIds of [undefined, [], [ORDER, 'not-an-order'], [ORDER, ORDER]]) {
    await message({ action: 'amzPageStatus', state: 'history', orderIds }, sender());
    current = (await message({ action: 'popupSnapshot', tabId: 1 })).current;
    assert.equal(current.savedCount, undefined); assert.equal(current.totalCount, undefined);
  }
  assert.equal((await message({ action: 'amzPageStatus', state: 'unreadable' }, sender())).ok, false);
});

test('navigation clears obsolete status and delayed acknowledgements cannot attach to the next order', async () => {
  const { surface, state, sender, open, tabEvents, message, badges } = harness([record()]);
  const old = sender();
  await surface.failed(old, ORDER, new Error('Example storage failure'));
  // A successful new save clears global storage attention, but must still match the open page.
  await surface.saved(old, { id: 'source-0', alreadySaved: false }, state.records[0].data, 'receipt');
  open.set(1, { id: 1, incognito: false, url: detail(order(1)) });
  tabEvents.onUpdated.emit(1, { url: detail(order(1)), status: 'loading' });
  await surface.refresh();
  await surface.saved(old, { id: 'source-0' }, state.records[0].data, 'receipt');
  assert.equal((await message({ action: 'popupSnapshot', tabId: 1 })).current, null);
  assert.equal(badges.get(1), '1');
  tabEvents.onRemoved.emit(1); open.delete(1); await surface.refresh();
});

test('gift-card preferences are default-off, options-only, durable and notify existing supported normal tabs without navigation', async () => {
  const { surface, sender, message, open, notifications, forbiddenCalls, storageValues } = harness();
  open.set(3, { id: 3, incognito: false, url: `${amz.origin}/gc/balance` });
  assert.equal((await message({ action: 'capturePreferences' }, options)).giftCardsEnabled, false);
  for (const actor of [sender(), popup, { ...options, tab: { incognito: true } }]) {
    assert.equal(message({ action: 'configureCapturePreferences', giftCardsEnabled: true }, actor), undefined);
  }
  assert.equal((await message({ action: 'configureCapturePreferences', giftCardsEnabled: 'yes' }, options)).ok, false);
  const first = await message({ action: 'configureCapturePreferences', giftCardsEnabled: true }, options);
  assert.equal(first.generation, 1); assert.equal(first.giftCardsEnabled, true);
  assert.equal((await surface.policy(sender(3))).enabled, true);
  assert.deepEqual(notifications.map((item) => item.id).sort((a, b) => a - b), [1, 3]);
  assert.equal(notifications.every((item) => item.message.event === 'capturePreferencesChanged'), true);
  await message({ action: 'configureCapturePreferences', giftCardsEnabled: true }, options);
  assert.equal(notifications.length, 2);
  const second = await message({ action: 'configureCapturePreferences', giftCardsEnabled: false }, options);
  assert.equal(second.generation, 2);
  assert.equal((await surface.policy(sender(3))).enabled, false);
  assert.equal(Object.values(storageValues)[0].generation, 2);
  assert.deepEqual(forbiddenCalls, []);
});

test('minimal source summaries support sent metadata without retaining receipt contents', async () => {
  const item = record(0, { status: 'received', summary: { orderId: ORDER, marketplace: amz.marketplace, itemCount: 2, warnings: [] } });
  delete item.data;
  const { surface, message, badges } = harness([item]);
  await surface.refresh();
  const result = await message({ action: 'popupSnapshot', tabId: 1 });
  assert.equal(result.current.state, 'saved'); assert.equal(result.current.status, 'received');
  assert.equal(result.recent[0].orderId, ORDER); assert.equal(badges.get(1), '✓');
});

test('other tabs show pending counts before paused and remain empty when idle', async () => {
  const { surface, state, badges } = harness();
  state.settings.enabled = false; await surface.refresh(); assert.equal(badges.get(2), 'II');
  state.records.push(record()); await surface.refresh(); assert.equal(badges.get(2), '1');
  state.records[0].status = 'received'; state.settings.enabled = true; await surface.refresh();
  assert.equal(badges.get(2), ''); assert.equal(badges.get(99), '');
});

test('missing optional browser surfaces do not break policy handling', async () => {
  const { browser, scope } = harness();
  delete browser.browserAction; delete browser.tabs; delete browser.storage.onChanged;
  const surface = scope.FinancialStatementDownloader.captureBackground.create({ async snapshot() { return { settings: {}, records: [] }; } });
  await surface.refresh();
  assert.equal((await surface.policy({ url: detail(), tab: { id: 1 }, frameId: 0 })).enabled, true);
});


test('an unrelated successful save cannot clear global attention for another order that was not saved', async () => {
  const { surface, state, sender, open, badges } = harness();
  open.set(3, { id: 3, incognito: false, url: detail(order(1)) });
  await surface.failed(sender(), ORDER, new Error('Example storage refusal'));
  state.records.push(record(1));
  await surface.saved(sender(3), { id: 'source-1', alreadySaved: false }, state.records[0].data, 'receipt');
  assert.equal(badges.get(1), '!'); assert.equal(badges.get(2), '!'); assert.equal(badges.get(3), '!');
  assert.equal(badges.get(99), '');
  // Saving the previously failed order does resolve that particular attention state.
  state.records.push(record(0));
  await surface.saved(sender(), { id: 'source-0', alreadySaved: false }, state.records[1].data, 'receipt');
  assert.equal(badges.get(1), '✓'); assert.equal(badges.get(2), '2'); assert.equal(badges.get(3), '✓');
});
