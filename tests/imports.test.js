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

function giftCardSnapshot() {
  return { schema: 'amazon.gift-card-balance.v1', marketplace: 'amazon.com', currency: 'USD',
    source_url: 'https://www.amazon.com/gc/balance', balance_cents: 1250,
    activities: [{ date_text: 'January 2, 2026', activity_type: 'redemption', amount_cents: -750,
      balance_after_cents: 1250, order_ids: ['100-1000000-1000000'] }],
    has_previous_page: false, has_next_page: true, coverage: 'visible_page', warnings: [] };
}

function harness() {
  const saved = {};
  const storage = {
    async get(keys) { return structuredClone(Object.fromEntries(keys.filter((key) => Object.hasOwn(saved, key)).map((key) => [key, saved[key]]))); },
    async set(values) { Object.assign(saved, structuredClone(values)); },
  };
  const uploads = [];
  const batches = [];
  const clock = { value: Date.now() };
  const client = { async session() { return { userId: 1 }; }, async upload(record, owner) {
    uploads.push({ record, owner }); return { remoteId: uploads.length, status: 'received' };
  }, async uploadBatch(records, owner) {
    batches.push(records);
    return Promise.all(records.map(async (record) => ({ id: record.id, ...await this.upload(record, owner) })));
  } };
  return { saved, storage, uploads, batches, clock, client,
    store: importStore.createImportStore(storage, client, { now: () => clock.value, random: () => 0 }) };
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

test('pause stops after the in-flight batch and persists while that upload is still pending', async () => {
  const { store, client, uploads, storage } = harness();
  for (let i = 0; i < 21; i += 1) {
    const data = receipt(); data.order_id = `100-1000000-${1000000 + i}`;
    data.source_url = `https://www.amazon.com/your-orders/order-details?orderID=${data.order_id}`;
    await store.capture(data);
  }
  await store.configure(true);
  let release;
  let started;
  const held = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const upload = client.uploadBatch.bind(client);
  client.uploadBatch = async (...args) => { const result = await upload(...args); started(); await held; return result; };
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
  assert.equal(uploads.length, 20);
  assert.equal((await store.snapshot()).records.filter((record) => record.status === 'local').length, 1);
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

test('archive draining shares bounded batches and spacing across capture and alarm events', async () => {
  const { store, uploads } = harness();
  for (let i = 0; i < 22; i += 1) {
    const data = receipt(); data.order_id = `100-1000000-${1000000 + i}`;
    data.source_url = `https://www.amazon.com/your-orders/order-details?orderID=${data.order_id}`;
    await store.capture(data);
  }
  await store.configure(true); await store.flush(); await store.flush();
  assert.equal(uploads.length, 20);
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
  client.upload = async () => { const error = new Error('HTTP 403'); error.status = 403; throw error; };
  await assert.rejects(store.flush(), /403/);
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

test('429 Retry-After supports delta seconds and HTTP dates without ignoring the server wait', async () => {
  for (const [header, minimum] of [['120', 120000], [new Date(Date.now() + 120000).toUTCString(), 119000], ['invalid', 0]]) {
    const client = importClient.createImportClient(async () => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': header }) }));
    await assert.rejects(client.session(), (error) => error.status === 429 && error.retryAfterMs >= minimum);
  }
});

test('receipt 429 backoff survives restart and retries the identical batch only after its deadline', async () => {
  const { store, client, storage, clock, uploads } = harness();
  const attempts = [];
  const uploadBatch = client.uploadBatch.bind(client);
  client.uploadBatch = async (records, owner) => {
    attempts.push(records.map((record) => ({ id: record.id, bytes: Array.from(record.bytes) })));
    if (attempts.length === 1) { const error = new Error('HTTP 429'); error.status = 429; error.retryAfterMs = 120000; throw error; }
    return uploadBatch(records, owner);
  };
  await store.capture(receipt()); await store.configure(true);
  const start = clock.value;
  assert.equal((await store.flush()).nextSyncAt, start + 120000);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.settings.enabled, true);
  assert.equal(snapshot.records[0].status, 'local');
  const resumed = importStore.createImportStore(storage, client, { now: () => clock.value, random: () => 0 });
  clock.value = start + 119999;
  await resumed.flush();
  assert.equal(attempts.length, 1);
  clock.value = start + 120000;
  await resumed.flush();
  assert.equal(uploads.length, 1);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal((await resumed.snapshot()).settings.retryAttempt, 0);
});

test('repeated 429s increase the delay and pausing/reconnecting cannot bypass Retry-After', async () => {
  const { store, client, clock } = harness();
  let attempts = 0;
  client.uploadBatch = async () => { attempts += 1; const error = new Error('HTTP 429'); error.status = 429; throw error; };
  await store.capture(receipt()); await store.configure(true);
  const start = clock.value;
  assert.equal((await store.flush()).nextSyncAt, start + 30000);
  await store.configure(false); await store.configure(true);
  await store.flush();
  assert.equal(attempts, 1);
  clock.value += 30000;
  assert.equal((await store.flush()).nextSyncAt, start + 90000);
  await store.configure(false);
  clock.value += 60000;
  assert.equal((await store.flush()).nextSyncAt, undefined);
  assert.equal(attempts, 2);
});

test('batch client sends bounded multipart sources and matches acknowledgements by hash, not position', async () => {
  const records = ['a', 'b'].map((letter) => ({ id: letter.repeat(64), filename: `${letter}.json`,
    bytes: new TextEncoder().encode('{}'), contentType: 'application/json' }));
  const requests = [];
  const client = importClient.createImportClient(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, async json() { return url.endsWith('/session') ? { user_id: 1, csrf_token: 'synthetic-csrf' }
      : { results: [{ sha256: records[1].id, document_id: 2, duplicate: false, status: 'received' },
        { sha256: records[0].id, document_id: 1, duplicate: true, status: 'received' }] }; } };
  });
  const result = await client.uploadBatch(records, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://pfifi.com/api/finance/browser-import/receipts/batch');
  assert.equal(requests[1].options.body.getAll('files[]').length, 2);
  assert.deepEqual(requests[1].options.body.getAll('sha256[]'), records.map((record) => record.id));
  assert.deepEqual(result.map((item) => item.remoteId), [1, 2]);
  await assert.rejects(client.uploadBatch(Array(21).fill(records[0]), 1), /1–20/);
});

test('batch client refuses a partial acknowledgement without treating remaining sources as received', async () => {
  const client = importClient.createImportClient(async (url) => ({ ok: true, async json() {
    return url.endsWith('/session') ? { user_id: 1, csrf_token: 'synthetic-csrf' } : { results: [] };
  } }));
  await assert.rejects(client.uploadBatch([{ id: 'a'.repeat(64), filename: 'example.json', contentType: 'application/json', bytes: new Uint8Array([1]) }], 1), /incomplete/);
});

test('explicit-file 429 retry honors backoff and stops on pause without retrying uncertain network errors', async () => {
  let attempts = 0;
  const waits = [];
  const result = await importClient.withRateLimitRetry(async () => {
    attempts += 1;
    if (attempts < 3) { const error = new Error('HTTP 429'); error.status = 429; error.retryAfterMs = attempts === 1 ? 120000 : 0; throw error; }
    return 'received';
  }, { random: () => 0, async wait(ms) { waits.push(ms); } });
  assert.equal(result, 'received');
  assert.deepEqual(waits, [120000, 60000]);
  let enabled = true;
  let sends = 0;
  await assert.rejects(importClient.withRateLimitRetry(async () => { sends += 1; const error = new Error('HTTP 429'); error.status = 429; throw error; },
    { async check() { return enabled; }, async wait() { enabled = false; } }), /paused/);
  assert.equal(sends, 1);
  let uncertainSends = 0;
  await assert.rejects(importClient.withRateLimitRetry(async () => { uncertainSends += 1; throw new Error('Acknowledgement lost'); },
    { async wait() { assert.fail('Uncertain uploads must not automatically retry'); } }), /lost/);
  assert.equal(uncertainSends, 1);
});

test('gift-card sources preserve safe activity cells but discard descriptions, claim codes, and cursors', async () => {
  const { store } = harness();
  const raw = giftCardSnapshot();
  raw.claim_code = 'EXAMPLE-CODE-DO-NOT-STORE';
  raw.next = 'EXAMPLE_CURSOR';
  raw.activities[0].description = 'Claim code: EXAMPLE-CODE-DO-NOT-STORE';
  raw.activities[0].claim_code = 'EXAMPLE-CODE-DO-NOT-STORE';
  await store.captureGiftCardSnapshot(raw);
  await store.captureGiftCardSnapshot(giftCardSnapshot());
  const { records } = await store.snapshot();
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'gift-card-snapshot');
  assert.equal(records[0].data.balance_cents, 1250);
  assert.deepEqual(records[0].data.activities[0].order_ids, ['100-1000000-1000000']);
  assert.equal(JSON.stringify(records).includes('EXAMPLE-CODE'), false);
  assert.equal(JSON.stringify(records).includes('EXAMPLE_CURSOR'), false);
});

test('gift-card revisions preserve repeated rows and validate balance/activity amounts', async () => {
  const { store } = harness();
  const snapshot = giftCardSnapshot();
  snapshot.balance_cents = 0;
  snapshot.activities.push(structuredClone(snapshot.activities[0]));
  await store.captureGiftCardSnapshot(snapshot);
  assert.equal((await store.snapshot()).records[0].data.activities.length, 2);
  for (const change of [{ balance_cents: -1 }, { balance_cents: 1.1 }, { coverage: 'complete_history' }, { has_next_page: 'yes' }]) {
    await assert.rejects(store.captureGiftCardSnapshot({ ...giftCardSnapshot(), ...change }));
  }
  const invalid = giftCardSnapshot(); invalid.activities[0].amount_cents = 1.1;
  await assert.rejects(store.captureGiftCardSnapshot(invalid));
});

test('receipt and gift-card sources drain as separate bounded batches with the same pinned recipient', async () => {
  const { store, clock, batches, uploads } = harness();
  await store.capture(receipt());
  await store.captureGiftCardSnapshot(giftCardSnapshot());
  await store.configure(true);
  const first = await store.flush();
  assert.equal(first.sent, 1);
  assert.equal(batches[0][0].kind, 'receipt');
  clock.value = first.nextSyncAt;
  await store.flush();
  assert.equal(batches[1][0].kind, 'gift-card-snapshot');
  assert.deepEqual(uploads.map((upload) => upload.owner), [1, 1]);
  assert.equal((await store.snapshot()).records.every((record) => record.status === 'received'), true);
});

test('gift-card API batches use their own source endpoint and reject mixed batches before requests', async () => {
  const requests = [];
  const record = { id: 'c'.repeat(64), kind: 'gift-card-snapshot', filename: 'example-gift-card.json',
    contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(giftCardSnapshot())) };
  const client = importClient.createImportClient(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, async json() { return url.endsWith('/session') ? { user_id: 1, csrf_token: 'synthetic-csrf' }
      : { results: [{ sha256: record.id, document_id: 1, status: 'received', duplicate: false }] }; } };
  });
  await client.uploadBatch([record], 1);
  assert.equal(requests[1].url, 'https://pfifi.com/api/finance/browser-import/gift-card-snapshots/batch');
  const previous = requests.length;
  await assert.rejects(client.uploadBatch([record, { ...record, kind: 'receipt' }], 1), /one supported source kind/);
  assert.equal(requests.length, previous);
});
