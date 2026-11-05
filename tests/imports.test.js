'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
require('../core/runtime.js');
require('../providers/amazon.js');
require('../core/import-client.js');
require('../core/import-store.js');
const { importStore, importClient } = global.FinancialStatementDownloader;

function receipt() {
  return { schema: 'amazon.receipt.v1', marketplace: 'amazon.com', currency: 'USD',
    order_id: '100-1000000-1000000', layout: 'standard',
    source_url: 'https://www.amazon.com/your-orders/order-details?orderID=100-1000000-1000000',
    order_date_text: 'January 2, 2026', status_text: 'Delivered', delivery_date_text: null,
    items: [{ title: 'EXAMPLE PRODUCT', asin: 'B000000000', product_url: 'https://www.amazon.com/dp/B000000000',
      quantity: 1, quantity_unit: 'each', unit_price_cents: 1000, line_total_cents: null, seller: null, condition: null }],
    charges: [{ label: 'Grand Total:', amount_cents: 1000 }], total_cents: 1000, warnings: [] };
}

function harness() {
  const saved = {};
  const storage = {
    async get(keys) { return structuredClone(Object.fromEntries(keys.filter((key) => Object.hasOwn(saved, key)).map((key) => [key, saved[key]]))); },
    async set(values) { Object.assign(saved, structuredClone(values)); },
  };
  const uploads = [];
  const client = { async session() { return { userId: 1 }; }, async upload(record, owner) {
    uploads.push({ record, owner }); return { remoteId: uploads.length, status: 'received' };
  } };
  return { saved, storage, uploads, client, store: importStore.createImportStore(storage, client) };
}

test('concurrent tabs deduplicate stable receipt bytes and preserve changed revisions', async () => {
  const { store } = harness();
  await Promise.all([store.capture(receipt()), store.capture(receipt())]);
  const changed = receipt(); changed.status_text = 'Refunded';
  await store.capture(changed);
  const state = await store.snapshot();
  assert.equal(state.records.length, 2);
  assert.notEqual(state.records[0].id, state.records[1].id);
  assert.equal(state.records[0].status, 'local');
  assert.equal(state.settings.enabled, false);
});

test('capture strips unrelated page fields and canonicalizes URLs before hashing', async () => {
  const { store } = harness();
  const raw = { ...receipt(), address: 'EXAMPLE ADDRESS', rawHtml: '<script>example</script>' };
  raw.source_url += '&ref=example'; raw.items[0].product_url += '?tracking=example';
  await store.capture(raw);
  await store.capture(receipt());
  const { records } = await store.snapshot();
  assert.equal(records.length, 1);
  assert.equal(records[0].data.address, undefined);
  assert.equal(records[0].data.rawHtml, undefined);
  assert.equal(records[0].data.source_url, receipt().source_url);
});

test('rejects invalid receipts and unsafe money instead of queuing them', async () => {
  const { store } = harness();
  for (const change of [{ currency: 'GBP' }, { items: [] }, { total_cents: 1.2 }, { source_url: 'https://example.test/' }]) {
    await assert.rejects(store.capture({ ...receipt(), ...change }));
  }
  assert.equal((await store.snapshot()).records.length, 0);
});

test('connect explicitly pins local captures and uploads exactly once across overlapping syncs', async () => {
  const { store, uploads } = harness();
  await store.capture(receipt());
  await store.flush();
  assert.equal(uploads.length, 0);
  await store.configure(true);
  await Promise.all([store.flush(), store.flush()]);
  await store.flush();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].owner, 1);
  assert.equal((await store.snapshot()).records[0].status, 'received');
});

test('review warnings keep a receipt local while complete receipts can sync', async () => {
  const { store, uploads } = harness();
  const raw = receipt(); raw.warnings = ['item_price_missing'];
  await store.capture(raw); await store.configure(true); await store.flush();
  assert.equal(uploads.length, 0);
});

test('pause stops after the in-flight receipt and persists while that upload is still pending', async () => {
  const { store, client, uploads, storage } = harness();
  for (let i = 0; i < 3; i += 1) {
    const data = receipt(); data.order_id = `100-1000000-${1000000 + i}`;
    data.source_url = `https://www.amazon.com/your-orders/order-details?orderID=${data.order_id}`;
    await store.capture(data);
  }
  await store.configure(true);
  let release;
  let started;
  const held = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const upload = client.upload;
  client.upload = async (...args) => { const result = await upload(...args); started(); await held; return result; };
  const syncing = store.flush();
  await entered;
  const pausing = store.configure(false);
  await new Promise(setImmediate);
  const restarted = importStore.createImportStore(storage, client);
  const persisted = await restarted.snapshot();
  release();
  await syncing;
  await pausing;
  assert.equal(persisted.settings.enabled, false);
  assert.equal(uploads.length, 1);
  assert.equal((await store.snapshot()).records.filter((record) => record.status === 'local').length, 2);
});

test('a pause supersedes a connection whose session check has not completed', async () => {
  const { store, client } = harness();
  let release;
  client.session = () => new Promise((resolve) => { release = resolve; });
  const connecting = store.configure(true);
  const superseded = assert.rejects(connecting, /preferences changed/i);
  await store.configure(false);
  release({ userId: 1 });
  await superseded;
  assert.equal((await store.snapshot()).settings.enabled, false);
});

test('archive draining shares a ten-per-minute budget across capture and alarm events', async () => {
  const { store, uploads } = harness();
  for (let i = 0; i < 12; i += 1) {
    const data = receipt(); data.order_id = `100-1000000-${1000000 + i}`;
    data.source_url = `https://www.amazon.com/your-orders/order-details?orderID=${data.order_id}`;
    await store.capture(data);
  }
  await store.configure(true); await store.flush(); await store.flush();
  assert.equal(uploads.length, 10);
  assert.equal((await store.snapshot()).records.filter((record) => record.status === 'local').length, 2);
});

test('an account switch pauses imports and never transfers old pinned records to a new account', async () => {
  const { store, client, uploads } = harness();
  await store.capture(receipt()); await store.configure(true);
  client.session = async () => ({ userId: 2 });
  await assert.rejects(store.flush(), /account changed/);
  assert.equal((await store.snapshot()).settings.enabled, false);
  await store.configure(true); await store.flush();
  assert.equal(uploads.length, 0);
  assert.equal((await store.snapshot()).records[0].userId, 1);
});

test('a refusal preserves records, pauses automatic retries, and permits explicit reconnection', async () => {
  const { store, client, uploads } = harness();
  await store.capture(receipt()); await store.configure(true);
  const normal = client.upload;
  client.upload = async () => { const error = new Error('HTTP 429'); error.status = 429; throw error; };
  await assert.rejects(store.flush(), /429/);
  await store.flush();
  const state = await store.snapshot();
  assert.equal(state.records[0].status, 'local');
  assert.equal(state.settings.enabled, false);
  client.upload = normal;
  await store.configure(true); await store.flush();
  assert.equal(uploads.length, 1);
});

test('background restart resumes pending receipts with original stable IDs', async () => {
  const { store, storage, client, uploads } = harness();
  const first = await store.capture(receipt()); await store.configure(true);
  const resumed = importStore.createImportStore(storage, client);
  await resumed.flush();
  assert.equal(uploads[0].record.id, first.id);
  await resumed.clear(); assert.equal((await resumed.snapshot()).records.length, 0);
});

test('API client uses cookies, in-memory CSRF, expected recipient, and multipart receipt bytes', async () => {
  const requests = [];
  const client = importClient.createImportClient(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, async json() { return url.endsWith('/session') ? { user_id: 1, csrf_token: 'synthetic-csrf' }
      : { document_id: 10, status: 'received', duplicate: true }; } };
  });
  const bytes = new TextEncoder().encode(JSON.stringify(receipt()));
  const result = await client.upload({ kind: 'receipt', bytes, filename: 'example.json', contentType: 'application/json', id: await importStore.hash(bytes) }, 1);
  assert.equal(result.remoteId, 10);
  assert.equal(result.duplicate, true);
  assert.equal(requests[1].url, 'https://pfifi.com/api/finance/browser-import/receipts');
  const options = requests[1].options;
  assert.equal(options.credentials, 'include');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['X-CSRF-TOKEN'], 'synthetic-csrf');
  assert.equal(options.body.get('expected_user_id'), '1');
  assert.equal(await options.body.get('file').text(), new TextDecoder().decode(bytes));
});

test('API client refuses a different session before sending file bytes', async () => {
  const requests = [];
  const client = importClient.createImportClient(async (url) => {
    requests.push(url); return { ok: true, async json() { return { user_id: 2, csrf_token: 'synthetic-csrf' }; } };
  });
  await assert.rejects(client.upload({ kind: 'receipt' }, 1), /account changed/);
  assert.equal(requests.length, 1);
});

test('API client submits other document types to the review queue without applying results', async () => {
  const requests = [];
  const client = importClient.createImportClient(async (url, options) => {
    requests.push({ url, options }); return { ok: true, async json() { return url.endsWith('/session') ? { user_id: 1, csrf_token: 'synthetic-csrf' } : { job_id: 20, status: 'pending' }; } };
  });
  const result = await client.upload({ kind: 'file', bytes: new Uint8Array([1]), filename: 'example.pdf', contentType: 'application/pdf', id: 'example-hash', jobType: 'finance_transactions' }, 1);
  assert.equal(result.remoteId, 20);
  assert.equal(requests[1].url, 'https://pfifi.com/api/genai/import/jobs');
  assert.equal(requests[1].options.body.get('job_type'), 'finance_transactions');
  assert.equal(requests.length, 2);
});

test('API client rejects login failures and malformed acknowledgements', async () => {
  const unauthorized = importClient.createImportClient(async () => ({ ok: false, status: 401 }));
  await assert.rejects(unauthorized.session(), /Sign in/);
  const malformed = importClient.createImportClient(async () => ({ ok: true, async json() { return {}; } }));
  await assert.rejects(malformed.session(), /does not support/);
});
