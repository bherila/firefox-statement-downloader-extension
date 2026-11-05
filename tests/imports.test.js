'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { amz } = require('../scripts/build.js');
require('../core/runtime.js');
require('../providers/amz.js');
require('../core/import-client.js');
require('../core/import-store.js');
const { importStore, importClient } = global.FinancialStatementDownloader;

function receipt() {
  return { schema: amz.receiptSchema, marketplace: amz.marketplace, currency: 'USD',
    order_id: '100-1000000-1000000', layout: 'standard',
    source_url: `${amz.origin}/your-orders/order-details?orderID=100-1000000-1000000`,
    order_date_text: 'January 2, 2026', status_text: 'Delivered', delivery_date_text: null,
    items: [{ title: 'EXAMPLE PRODUCT', asin: 'B000000000', product_url: `${amz.origin}/dp/B000000000`,
      quantity: 1, quantity_unit: 'each', unit_price_cents: 1000, line_total_cents: null, seller: null, condition: null }],
    charges: [{ label: 'Grand Total:', amount_cents: 1000 }], total_cents: 1000, warnings: [] };
}

function giftCardSnapshot() {
  return { schema: amz.giftCardSchema, marketplace: amz.marketplace, currency: 'USD',
    source_url: `${amz.origin}/gc/balance`, balance_cents: 1250,
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

test('code-shaped receipt text never reaches local storage, export, or upload', async () => {
  // Deliberately synthetic examples, never redeemable codes from a page.
  const codes = ['ABCD-123456-EFGH', 'ABCD-123456-EFGH5', 'abcd123456efgh', 'ABCD123456EFGH5',
    'Example—ABCD-123456-EFGH', 'ABCD-123456-EFGH-example', 'Example-abcd123456efgh-word',
    'Example—ABCD–123456–EFGH—word'];
  for (const field of ['title', 'status_text', 'seller', 'condition', 'label', 'order_date_text', 'delivery_date_text']) {
    for (const code of codes) {
      const { store, saved, uploads } = harness();
      const raw = receipt();
      if (['title', 'seller', 'condition'].includes(field)) raw.items[0][field] = `Example ${code}`;
      else if (field === 'label') raw.charges[0].label = `Example ${code}`;
      else raw[field] = `Example ${code}`;
      await assert.rejects(store.capture(raw), { message: 'Receipt text may contain a redeemable code. Nothing was saved.' });
      assert.equal(JSON.stringify(saved).includes(code), false);
      assert.equal((await store.snapshot()).records.length, 0);
      await store.configure(true); await store.flush();
      assert.equal(uploads.length, 0);
    }
  }
});

test('ordinary receipt titles, identifiers, dates, and amounts remain as printed', async () => {
  const { store } = harness();
  const raw = receipt();
  raw.items[0].title = 'EXAMPLE PRODUCT B000000000, 14 inches';
  raw.items[0].seller = 'Example seller';
  raw.items[0].condition = 'New';
  await store.capture(raw);
  assert.deepEqual((await store.snapshot()).records[0].data, raw);
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

test('review warnings keep a newly captured receipt local during its settling window', async () => {
  const { store, uploads } = harness();
  const raw = receipt(); raw.warnings = ['item_price_missing'];
  await store.capture(raw); await store.configure(true); await store.flush();
  assert.equal(uploads.length, 0);
});

test('pause stops after the in-flight batch and persists while that upload is still pending', async () => {
  const { store, client, uploads, storage } = harness();
  for (let i = 0; i < 21; i += 1) {
    const data = receipt(); data.order_id = `100-1000000-${1000000 + i}`;
    data.source_url = `${amz.origin}/your-orders/order-details?orderID=${data.order_id}`;
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
    data.source_url = `${amz.origin}/your-orders/order-details?orderID=${data.order_id}`;
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

test('provider naming preserves the existing wire bytes and stable source identities', async () => {
  const { store } = harness();
  const savedReceipt = await store.capture(receipt());
  const savedBalance = await store.captureGiftCardSnapshot(giftCardSnapshot());
  // These digests predate the codename change and cover schema, origins, and field order.
  assert.equal(savedReceipt.id, 'd2c52b0d4c332082fb4549571c9298b626b454daba42c02b4117ffb850d01cd8');
  assert.equal(savedBalance.id, '17153ee1f6c78bf276d3b6af856f2b97b04c6c1046d90482f2991329cc578fa6');
});

function distinctReceipt(index) {
  const data = receipt();
  data.order_id = `100-1000000-${1000000 + index}`;
  data.source_url = `${amz.origin}/your-orders/order-details?orderID=${data.order_id}`;
  return data;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('session names fall back to account numbers and mismatches expose identity with HTTP409 semantics', async () => {
  for (const [name, expected] of [['  Example Owner  ', 'Example Owner'], ['', '2'], [undefined, '2']]) {
    const client = importClient.createImportClient(async () => ({ ok: true, async json() {
      return { user_id: 2, user_name: name, csrf_token: 'synthetic-csrf' };
    } }));
    assert.equal((await client.session()).userName, expected);
    await assert.rejects(client.uploadBatch([{ id: 'a'.repeat(64), kind: 'receipt' }], 1),
      (error) => error.status === 409 && error.activeIdentity.userId === 2 && error.activeIdentity.userName === expected);
  }
});

test('client preserves 422 validation bodies and distinguishes indexed refusals from request errors', async () => {
  const body = { message: 'Example validation failure', errors: {
    'sources.3.items.0.title': ['Example title required'], 'sources.3.total_cents': ['Example total invalid'],
    'files.1': ['Example file invalid'], expected_user_id: ['Example owner required'],
  } };
  const client = importClient.createImportClient(async (url) => ({ ok: url.endsWith('/session'), status: 422, async json() {
    return url.endsWith('/session') ? { user_id: 1, csrf_token: 'synthetic-csrf' } : body;
  } }));
  await assert.rejects(client.uploadBatch([{ kind: 'receipt', id: 'a'.repeat(64), filename: 'example.json',
    bytes: new Uint8Array([1]), contentType: 'application/json' }], 1), (error) => {
    assert.equal(error.status, 422); assert.deepEqual(error.body, body);
    assert.deepEqual(error.sourceErrors, { 3: ['Example title required', 'Example total invalid'] });
    assert.deepEqual(error.requestErrors, { 'files.1': ['Example file invalid'], expected_user_id: ['Example owner required'] });
    return true;
  });
});

test('one indexed refusal is quarantined with its reason while the other nineteen send on the next batch', async () => {
  const { store, client, clock } = harness();
  for (let index = 0; index < 20; index += 1) await store.capture(distinctReceipt(index));
  let posts = 0;
  const received = [];
  const realClient = importClient.createImportClient(async (url, options) => {
    if (url.endsWith('/session')) return { ok: true, async json() { return { user_id: 1, csrf_token: 'synthetic-csrf' }; } };
    posts += 1;
    const ids = options.body.getAll('sha256[]');
    if (posts === 1) return { ok: false, status: 422, async json() {
      return { errors: { 'sources.3.items.0.title': ['Example source could not be read.'] } };
    } };
    received.push(...ids);
    return { ok: true, async json() { return { results: ids.map((id, index) => ({ sha256: id, document_id: index + 1, status: 'received' })) }; } };
  });
  client.uploadBatch = realClient.uploadBatch;
  await store.configure(true);
  const first = await store.flush();
  assert.equal(first.refused, 1);
  let state = await store.snapshot();
  assert.equal(state.settings.enabled, true);
  assert.equal(state.records[3].status, 'refused');
  assert.equal(state.records[3].error, 'Example source could not be read.');
  assert.equal(state.records.filter((record) => record.status === 'local').length, 19);
  clock.value = first.nextSyncAt;
  assert.equal((await store.flush()).sent, 19);
  state = await store.snapshot();
  assert.equal(received.length, 19);
  assert.ok(!received.includes(state.records[3].id));
  assert.equal(state.records.filter((record) => record.status === 'received').length, 19);
});

test('request-level validation failures retry without accusing or discarding individual sources', async () => {
  const { store, client, clock } = harness();
  await store.capture(receipt()); await store.configure(true);
  client.uploadBatch = async () => { throw Object.assign(new Error('Example request invalid'), {
    status: 422, sourceErrors: {}, requestErrors: { expected_user_id: ['Example request invalid'] },
  }); };
  const result = await store.flush();
  const state = await store.snapshot();
  assert.equal(result.nextSyncAt, clock.value + 30000);
  assert.equal(state.records[0].status, 'local');
  assert.equal(state.settings.enabled, true);
  assert.equal(state.queue.phase, 'retrying');
  assert.equal(state.settings.lastError, 'Example request invalid');
});

test('network, timeout and server errors retry durably without reconnecting or changing source identities', async () => {
  for (const failure of [new TypeError('Example network unavailable'), Object.assign(new Error('Example timeout'), { name: 'AbortError' }),
    Object.assign(new Error('Example server unavailable'), { status: 500 }), Object.assign(new Error('Example gateway unavailable'), { status: 503 })]) {
    const { store, client, storage, clock, uploads } = harness();
    const captured = await store.capture(receipt()); await store.configure(true);
    const normal = client.uploadBatch.bind(client);
    let attempts = 0;
    client.uploadBatch = async (...args) => { attempts += 1; if (attempts === 1) throw failure; return normal(...args); };
    const first = await store.flush();
    const state = await store.snapshot();
    assert.equal(state.settings.enabled, true);
    assert.equal(state.queue.phase, 'retrying');
    assert.equal(state.queue.retryKind, 'transient');
    assert.equal(state.queue.retryAt, clock.value + 30000);
    const restarted = importStore.createImportStore(storage, client, { now: () => clock.value, random: () => 0 });
    clock.value = first.nextSyncAt - 1;
    await restarted.flush(); assert.equal(attempts, 1);
    clock.value += 1; await restarted.flush();
    assert.equal(uploads[0].record.id, captured.id);
    assert.equal((await restarted.snapshot()).queue.phase, 'all_sent');
    assert.equal((await restarted.snapshot()).queue.lastSentAt, new Date(clock.value).toISOString());
  }
});

test('pause acknowledges during an in-flight failure and stays paused across retry deadlines and restart', async () => {
  for (const status of [429, 503, undefined]) {
    const { store, storage, client, clock } = harness();
    await store.capture(receipt()); await store.configure(true);
    const started = deferred(); const held = deferred(); let sends = 0;
    client.uploadBatch = async () => { sends += 1; started.resolve(); await held.promise;
      throw Object.assign(new Error('Example temporary failure'), { status }); };
    const sending = store.flush(); await started.promise;
    assert.equal((await store.snapshot()).queue.phase, 'sending');
    await store.configure(false);
    assert.equal((await store.snapshot()).queue.phase, 'pausing');
    const restarted = importStore.createImportStore(storage, client, { now: () => clock.value, random: () => 0 });
    assert.equal((await restarted.snapshot()).queue.phase, 'paused');
    held.resolve(); await sending;
    clock.value += 3600000;
    await restarted.flush(); await store.flush();
    assert.equal(sends, 1);
    assert.equal((await store.snapshot()).queue.phase, 'paused');
  }
});

test('revoked access remains a durable stop even if the in-flight batch succeeds or fails', async () => {
  for (const failure of [false, true]) {
    const { store, storage, client } = harness();
    await store.capture(receipt()); await store.configure(true);
    const started = deferred(); const held = deferred(); const normal = client.uploadBatch.bind(client);
    client.uploadBatch = async (...args) => { started.resolve(); await held.promise;
      if (failure) throw Object.assign(new Error('Example permission response'), { status: 403 });
      return normal(...args);
    };
    const sending = store.flush(); await started.promise;
    await store.stop('access_revoked');
    assert.equal((await store.snapshot()).queue.stopReason, 'access_revoked');
    held.resolve();
    if (failure) await assert.rejects(sending); else await sending;
    const restarted = importStore.createImportStore(storage, client);
    const state = await restarted.snapshot();
    assert.equal(state.queue.phase, 'stopped');
    assert.equal(state.queue.stopReason, 'access_revoked');
    assert.equal(state.settings.enabled, false);
  }
});

test('lost or partial source acknowledgements retry idempotently without marking a subset received', async () => {
  const { store, client, clock } = harness();
  await store.capture(distinctReceipt(0)); await store.capture(distinctReceipt(1)); await store.configure(true);
  const attempts = [];
  client.uploadBatch = async (records) => {
    attempts.push(records.map((record) => ({ id: record.id, bytes: Array.from(record.bytes) })));
    return records.slice(0, attempts.length === 1 ? 1 : 2).map((record, index) => ({ id: record.id, remoteId: index + 1 }));
  };
  const retry = await store.flush();
  assert.equal((await store.snapshot()).records.every((record) => record.status === 'local'), true);
  clock.value = retry.nextSyncAt;
  assert.equal((await store.flush()).sent, 2);
  assert.deepEqual(attempts[0], attempts[1]);
});

test('Resume requires an explicit account choice and switching never re-pins existing evidence', async () => {
  const { store, client, uploads, clock } = harness();
  client.session = async () => ({ userId: 1, userName: 'Example Original Owner' });
  await store.capture(receipt()); await store.configure(true); await store.configure(false);
  client.session = async () => ({ userId: 2, userName: 'Example New Owner' });
  const conflict = await store.configure(true);
  assert.equal(conflict.requiresAccountChoice, true);
  assert.deepEqual(conflict.accountConflict, { original: { userId: 1, userName: 'Example Original Owner' }, active: { userId: 2, userName: 'Example New Owner' } });
  await store.flush(); assert.equal(uploads.length, 0);
  assert.equal((await store.snapshot()).queue.phase, 'stopped');
  await store.configure(true, { useNewAccount: true });
  await store.capture(distinctReceipt(1)); await store.flush();
  let state = await store.snapshot();
  assert.equal(state.records[0].userId, 1); assert.equal(state.records[0].status, 'local');
  assert.equal(state.records[1].userId, 2); assert.equal(uploads[0].owner, 2);
  client.session = async () => ({ userId: 1, userName: 'Example Original Owner' });
  assert.equal((await store.configure(true)).requiresAccountChoice, true);
  await store.configure(true, { useNewAccount: true }); clock.value += 5000; await store.flush();
  state = await store.snapshot();
  assert.equal(state.records[0].userId, 1); assert.equal(state.records[0].status, 'received');
  assert.deepEqual(uploads.map((upload) => upload.owner), [2, 1]);
});

test('partial sources upload flagged after exactly one minute using the injected capture clock', async () => {
  for (const kind of ['receipt', 'gift-card-snapshot']) {
    const { store, clock, uploads } = harness();
    const source = kind === 'receipt' ? receipt() : giftCardSnapshot();
    source.warnings = ['unparsed_items'];
    const started = clock.value;
    if (kind === 'receipt') await store.capture(source); else await store.captureGiftCardSnapshot(source);
    await store.configure(true);
    const state = await store.snapshot();
    assert.equal(state.records[0].createdAt, new Date(started).toISOString());
    assert.equal((await store.flush()).nextSyncAt, started + 60000);
    clock.value += 59999; await store.flush(); assert.equal(uploads.length, 0);
    clock.value += 1; await store.flush();
    assert.deepEqual(uploads[0].record.data.warnings, ['unparsed_items']);
    assert.equal((await store.snapshot()).records[0].status, 'received');
  }
});

test('a receipt that finishes before the deadline suppresses only its matching partial revision without deleting it', async () => {
  const { store, clock, uploads } = harness();
  const partial = receipt(); partial.warnings = ['item_price_missing'];
  await store.capture(partial);
  const unrelated = distinctReceipt(1); unrelated.warnings = ['item_price_missing']; await store.capture(unrelated);
  await store.configure(true); await store.flush(); clock.value += 59000;
  const complete = await store.capture(receipt()); await store.flush();
  const state = await store.snapshot();
  assert.equal(state.records.length, 3);
  assert.equal(state.records[0].status, 'suppressed');
  assert.equal(state.records[0].suppressedBy, complete.id);
  assert.deepEqual(state.records[0].data.warnings, ['item_price_missing']);
  assert.equal(state.records[1].status, 'local');
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].record.data.warnings, []);
});

test('a complete read after a partial was sent is a distinct revision and never erases evidence', async () => {
  const { store, clock, uploads } = harness();
  const partial = receipt(); partial.warnings = ['item_price_missing'];
  await store.capture(partial); await store.configure(true); clock.value += 60000; await store.flush();
  await store.capture(receipt()); clock.value += 5000; await store.flush();
  assert.equal(uploads.length, 2);
  assert.equal((await store.snapshot()).records.every((record) => record.status === 'received'), true);
});

test('snapshot suppression requires matching activity-page evidence, multiplicities and recipient', async () => {
  const { store, clock, client } = harness();
  const partial = giftCardSnapshot(); partial.warnings = ['unparsed_activity_rows'];
  await store.captureGiftCardSnapshot(partial); await store.configure(true);
  clock.value += 1000;
  const otherPage = giftCardSnapshot(); otherPage.activities[0].date_text = 'January 1, 2026';
  await store.captureGiftCardSnapshot(otherPage);
  assert.equal((await store.snapshot()).records[0].status, 'local');
  await store.captureGiftCardSnapshot(giftCardSnapshot());
  assert.equal((await store.snapshot()).records[0].status, 'suppressed');
  const repeatedPartial = giftCardSnapshot(); repeatedPartial.warnings = ['unparsed_activity_rows'];
  repeatedPartial.activities.push(structuredClone(repeatedPartial.activities[0]));
  await store.captureGiftCardSnapshot(repeatedPartial);
  await store.captureGiftCardSnapshot(giftCardSnapshot());
  assert.equal((await store.snapshot()).records[3].status, 'local');
  const repeatedComplete = structuredClone(repeatedPartial); repeatedComplete.warnings = [];
  await store.captureGiftCardSnapshot(repeatedComplete);
  assert.equal((await store.snapshot()).records[3].status, 'suppressed');
  const otherOwner = receipt(); otherOwner.warnings = ['item_price_missing']; await store.capture(otherOwner);
  client.session = async () => ({ userId: 2 });
  await store.configure(true, { useNewAccount: true });
  await store.capture(receipt());
  const state = await store.snapshot();
  assert.equal(state.records.find((record) => record.data.warnings.includes('item_price_missing')).status, 'local');
});

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const settingsKey = 'fsd:imports:settings';
const recordsKey = 'fsd:imports:records';
function revision(index, partial = false) {
  const data = receipt(); data.status_text = `Example revision ${index}`;
  if (partial) data.warnings = ['item_price_missing'];
  return data;
}

test('verified acknowledgements drop source contents by default and retain only safe summaries and sent metadata', async () => {
  const { store, clock, saved } = harness();
  await store.capture(receipt()); await store.captureGiftCardSnapshot(giftCardSnapshot());
  await store.configure(true);
  await store.flush(); clock.value += 5000; await store.flush();
  const { records } = await store.snapshot();
  for (const record of records) {
    assert.equal(record.status, 'received'); assert.equal(Object.hasOwn(record, 'data'), false);
    assert.ok(record.sentAt); assert.ok(record.remoteId); assert.ok(record.id);
    for (const forbidden of ['items', 'charges', 'total_cents', 'source_url', 'balance_cents', 'balanceCents', 'activities']) assert.equal(Object.hasOwn(record.summary, forbidden), false);
    assert.ok(!JSON.stringify(record.summary).includes('EXAMPLE PRODUCT'));
    assert.ok(!JSON.stringify(record.summary).includes('1250'));
  }
  assert.deepEqual(records[0].summary, { orderId: receipt().order_id, marketplace: amz.marketplace,
    layout: 'standard', itemCount: 1, warnings: [] });
  assert.equal(records[1].summary.activityCount, 1);
  assert.equal(saved[recordsKey].every((record) => !Object.hasOwn(record, 'data')), true);
});

test('contents not covered by a verified batch acknowledgement remain held, including other source kinds', async () => {
  const { store, client, clock } = harness();
  await store.capture(receipt()); await store.captureGiftCardSnapshot(giftCardSnapshot()); await store.configure(true);
  client.uploadBatch = async () => [];
  const retry = await store.flush();
  assert.equal((await store.snapshot()).records.every((record) => Object.hasOwn(record, 'data')), true);
  client.uploadBatch = async (records) => records.map((record) => ({ id: record.id, remoteId: 1, status: 'received' }));
  clock.value = retry.nextSyncAt;
  await store.flush();
  const records = (await store.snapshot()).records;
  assert.equal(records[0].status, 'received'); assert.equal(Object.hasOwn(records[0], 'data'), false);
  assert.equal(records[1].status, 'local'); assert.ok(records[1].data);
});

test('unchanged sent hashes write and send nothing while a changed order becomes a new dropped revision', async () => {
  const { store, storage, uploads, clock } = harness();
  await store.capture(receipt()); await store.configure(true); await store.flush();
  const before = JSON.stringify(await store.snapshot());
  const original = storage.set; let writes = 0;
  storage.set = async (...args) => { writes += 1; return original(...args); };
  assert.equal((await store.capture(receipt())).alreadySaved, true);
  await store.flush();
  assert.equal(writes, 0); assert.equal(uploads.length, 1);
  assert.equal(JSON.stringify(await store.snapshot()), before);
  assert.equal((await store.capture(revision(1))).alreadySaved, false);
  clock.value += 5000; await store.flush();
  const state = await store.snapshot();
  assert.equal(uploads.length, 2); assert.equal(state.records.length, 2);
  assert.equal(state.records.every((record) => record.status === 'received' && !record.data), true);
});

test('forgetting sent history permits a revisit while preserving every unsent local/refused/suppressed source', async () => {
  const { store, storage, uploads, clock } = harness();
  await store.setRetention({ keepCopy: true });
  await store.capture(receipt()); await store.configure(true); await store.flush();
  await store.configure(false);
  const waiting = await store.capture(distinctReceipt(1));
  const partial = revision(2, true); partial.order_id = distinctReceipt(2).order_id; partial.source_url = distinctReceipt(2).source_url;
  await store.capture(partial); await store.capture(distinctReceipt(2));
  const raw = (await storage.get([recordsKey]))[recordsKey];
  raw.find((record) => record.id === waiting.id).status = 'refused'; await storage.set({ [recordsKey]: raw });
  assert.equal((await store.forgetSentHistory()).forgotten, 1);
  const remaining = (await store.snapshot()).records;
  assert.equal(remaining.length, 3);
  assert.equal(remaining.every((record) => record.status !== 'received' && record.data), true);
  assert.ok(remaining.some((record) => record.status === 'suppressed'));
  assert.ok(remaining.some((record) => record.status === 'refused'));
  assert.equal((await store.capture(receipt())).alreadySaved, false);
  // The same stable hash is submitted again; remote hash deduplication remains applicable.
  await store.configure(true); clock.value += 5000; await store.flush();
  assert.equal(uploads.filter((item) => item.record.id === uploads[0].record.id).length, 2);
});

test('turning keep-copy off discards confirmed copies and turning it back on cannot restore them', async () => {
  const { store, saved } = harness();
  await store.setRetention({ keepCopy: true }); await store.capture(receipt());
  await store.configure(true); await store.flush();
  assert.ok((await store.snapshot()).records[0].data);
  await store.capture(distinctReceipt(1));
  await store.setRetention({ keepCopy: false });
  let records = (await store.snapshot()).records;
  assert.equal(Object.hasOwn(records[0], 'data'), false); assert.ok(records[1].data);
  assert.equal(Object.hasOwn(saved[recordsKey][0], 'data'), false);
  await store.setRetention({ keepCopy: true });
  records = (await store.snapshot()).records;
  assert.equal(Object.hasOwn(records[0], 'data'), false); assert.ok(records[1].data);
  assert.equal((await store.snapshot()).settings.keepCopy, true);
});

test('legacy reads hide default-discarded contents without writing and serialized cleanup persists migration', async () => {
  const { store, storage, saved, clock } = harness();
  await store.capture(receipt());
  const legacy = saved[recordsKey];
  delete legacy[0].summary; legacy[0].status = 'received'; legacy[0].remoteId = 1;
  await storage.set({ [recordsKey]: legacy, [settingsKey]: { enabled: false, userId: 1 } });
  const original = storage.set; let writes = 0;
  storage.set = async (...args) => { writes += 1; return original(...args); };
  const viewed = await store.snapshot();
  assert.equal(writes, 0); assert.equal(Object.hasOwn(viewed.records[0], 'data'), false);
  assert.equal(viewed.records[0].summary.itemCount, 1); assert.equal(viewed.settings.everConnected, true);
  assert.ok(saved[recordsKey][0].data);
  await store.cleanup();
  assert.equal(Object.hasOwn(saved[recordsKey][0], 'data'), false);
  assert.equal(saved[recordsKey][0].sentAt, new Date(clock.value).toISOString());
  assert.equal(saved[settingsKey].everConnected, true);
});

test('legacy keep-copy preference is honored during migration and summary extras are removed', async () => {
  const { store, storage, saved } = harness();
  await store.capture(receipt());
  const records = saved[recordsKey]; records[0].status = 'received'; records[0].remoteId = 1;
  records[0].summary = { items: ['EXAMPLE PRIVATE ITEM'], total_cents: 1000, source_url: 'https://example.test/private' };
  await storage.set({ [recordsKey]: records, [settingsKey]: { enabled: false, userId: 1, keepCopy: true } });
  await store.cleanup();
  assert.ok(saved[recordsKey][0].data);
  assert.equal(Object.hasOwn(saved[recordsKey][0].summary, 'items'), false);
  assert.equal(Object.hasOwn(saved[recordsKey][0].summary, 'total_cents'), false);
  assert.equal(Object.hasOwn(saved[recordsKey][0].summary, 'source_url'), false);
});

test('seven-day cleanup deletes replaced sent copies while preserving the newest and first replacement time', async () => {
  const { store, clock } = harness();
  await store.setRetention({ keepCopy: true }); await store.configure(true);
  await store.capture(revision(0)); await store.flush();
  clock.value += 5000; const replacedAt = clock.value;
  await store.capture(revision(1)); await store.flush();
  clock.value += 5000; await store.capture(revision(2)); await store.flush();
  let records = (await store.snapshot()).records;
  assert.equal(records[0].replacedAt, new Date(replacedAt).toISOString());
  clock.value = replacedAt + SEVEN_DAYS - 1; await store.cleanup(); assert.equal((await store.snapshot()).records.length, 3);
  clock.value += 1; await store.cleanup();
  records = (await store.snapshot()).records;
  assert.equal(records.length, 2); assert.equal(records[0].data.status_text, 'Example revision 1');
  clock.value += 5000; await store.cleanup();
  records = (await store.snapshot()).records;
  assert.equal(records.length, 1); assert.equal(records[0].data.status_text, 'Example revision 2');
});

test('an unsent replaced revision survives seven days after connection even while paused and suppressed', async () => {
  const { store, clock } = harness();
  await store.configure(true); await store.configure(false);
  await store.capture(revision(0, true)); clock.value += 1000; await store.capture(revision(1));
  assert.equal((await store.snapshot()).records[0].status, 'suppressed');
  clock.value += SEVEN_DAYS; await store.cleanup();
  const records = (await store.snapshot()).records;
  assert.equal(records.length, 2); assert.equal(records.every((record) => record.data), true);
});

test('never-connected replacements age out after seven days while the newest remains', async () => {
  const { store, clock } = harness();
  await store.capture(revision(0)); clock.value += 1000; await store.capture(revision(1));
  clock.value += SEVEN_DAYS; await store.cleanup();
  const state = await store.snapshot();
  assert.equal(state.settings.everConnected, false); assert.equal(state.records.length, 1);
  assert.equal(state.records[0].data.status_text, 'Example revision 1');
});

test('at twenty held revisions a new revision evicts the oldest sent copy before seven days', async () => {
  const { store, clock } = harness();
  await store.setRetention({ keepCopy: true }); await store.configure(true);
  for (let index = 0; index < 20; index += 1) {
    await store.capture(revision(index)); await store.flush(); clock.value += 5000;
  }
  await store.capture(revision(20));
  const records = (await store.snapshot()).records;
  assert.equal(records.length, 20); assert.equal(records[0].data.status_text, 'Example revision 1');
  assert.equal(records[19].data.status_text, 'Example revision 20');
});

test('twenty connected unsent revisions refuse another save without mutating or deleting any evidence', async () => {
  const { store, clock, saved } = harness();
  await store.configure(true); await store.configure(false);
  for (let index = 0; index < 20; index += 1) { await store.capture(revision(index)); clock.value += 1000; }
  const before = JSON.stringify(saved);
  await assert.rejects(store.capture(revision(20)), /20 unsent revisions/);
  assert.equal(JSON.stringify(saved), before);
  assert.equal((await store.snapshot()).records.length, 20);
  // A different order remains independent of this order's capacity.
  await store.capture(distinctReceipt(1)); assert.equal((await store.snapshot()).records.length, 21);
});

test('never-connected capacity evicts the oldest but partial revisions cannot evict the latest complete source', async () => {
  const { store, clock } = harness();
  await store.capture(revision(0));
  for (let index = 1; index <= 20; index += 1) { clock.value += 1000; await store.capture(revision(index, true)); }
  const records = (await store.snapshot()).records;
  assert.equal(records.length, 20);
  assert.equal(records[0].data.status_text, 'Example revision 0');
  assert.equal(records[1].data.status_text, 'Example revision 2');
  assert.equal(records[19].data.status_text, 'Example revision 20');
  clock.value += SEVEN_DAYS; await store.cleanup();
  assert.deepEqual((await store.snapshot()).records.map((record) => record.data.status_text), ['Example revision 0', 'Example revision 20']);
});

test('sent thin markers do not count toward held capacity or age out', async () => {
  const { store, clock } = harness(); await store.configure(true);
  for (let index = 0; index < 25; index += 1) { await store.capture(revision(index)); await store.flush(); clock.value += 5000; }
  clock.value += SEVEN_DAYS; await store.cleanup();
  const records = (await store.snapshot()).records;
  assert.equal(records.length, 25); assert.equal(records.every((record) => !record.data), true);
});

test('gift-card activity pages neither replace each other nor enter receipt per-order limits', async () => {
  const { store, clock } = harness(); await store.setRetention({ keepCopy: true });
  for (let index = 0; index < 25; index += 1) {
    const source = giftCardSnapshot(); source.balance_cents += index;
    await store.captureGiftCardSnapshot(source); clock.value += 1000;
  }
  clock.value += SEVEN_DAYS; await store.cleanup();
  const records = (await store.snapshot()).records;
  assert.equal(records.length, 25); assert.equal(records.every((record) => record.data && !record.replacedAt), true);
  assert.equal(records.every((record) => !Object.hasOwn(record.summary, 'balanceCents')), true);
});

test('retention changes and cleanup serialize with acknowledgement while snapshot stays available', async () => {
  const { store, client, clock } = harness();
  await store.setRetention({ keepCopy: true }); await store.capture(revision(0)); await store.configure(true);
  const started = deferred(); const held = deferred(); const normal = client.uploadBatch.bind(client);
  client.uploadBatch = async (...args) => { started.resolve(); await held.promise; return normal(...args); };
  const sending = store.flush(); await started.promise;
  const change = store.setRetention({ keepCopy: false });
  const cleanup = store.cleanup();
  const capture = store.capture(revision(1));
  assert.equal((await store.snapshot()).queue.phase, 'sending');
  assert.ok((await store.snapshot()).records[0].data);
  clock.value += 1000; held.resolve();
  await Promise.all([sending, change, cleanup, capture]);
  const state = await store.snapshot();
  assert.equal(state.records.length, 2); assert.equal(state.settings.keepCopy, false);
  assert.equal(Object.hasOwn(state.records[0], 'data'), false); assert.ok(state.records[1].data);
});


test('per-order capacity and replacement are isolated by account pin and marketplace', async () => {
  const { store, storage, saved, client, clock } = harness();
  await store.configure(true); await store.configure(false);
  for (let index = 0; index < 20; index += 1) { await store.capture(revision(index)); clock.value += 1000; }
  const oldIds = (await store.snapshot()).records.map((record) => record.id);
  client.session = async () => ({ userId: 2 });
  await store.configure(true, { useNewAccount: true }); await store.configure(false);
  await store.capture(revision(20));
  assert.equal((await store.snapshot()).records.length, 21);
  assert.deepEqual((await store.snapshot()).records.filter((record) => record.userId === 1).map((record) => record.id), oldIds);
  // Imported legacy observations from another marketplace must never collide.
  const records = saved[recordsKey];
  const otherMarket = structuredClone(records[0]); otherMarket.id = 'example-other-market'; otherMarket.userId = 2;
  otherMarket.data.marketplace = 'merchant.example.test'; otherMarket.summary.marketplace = 'merchant.example.test';
  delete otherMarket.replacedAt;
  records.push(otherMarket); await storage.set({ [recordsKey]: records });
  clock.value += SEVEN_DAYS; await store.cleanup();
  const state = await store.snapshot();
  assert.ok(state.records.some((record) => record.id === 'example-other-market' && !record.replacedAt));
  assert.equal(state.records.filter((record) => record.userId === 1).length, 20);
});

test('cleanup preserves connected refused sources and unrelated document records regardless of receipt replacement age', async () => {
  const { store, storage, saved, clock } = harness();
  await store.configure(true); await store.configure(false);
  await store.capture(revision(0)); clock.value += 1000; await store.capture(revision(1));
  const records = saved[recordsKey]; records[0].status = 'refused';
  records.push({ id: 'example-unrelated-document', kind: 'file', status: 'local', userId: 1,
    createdAt: records[0].createdAt, data: { order_id: receipt().order_id, marketplace: amz.marketplace, contents: 'EXAMPLE DOCUMENT' } });
  await storage.set({ [recordsKey]: records }); clock.value += SEVEN_DAYS; await store.cleanup();
  const state = await store.snapshot();
  assert.equal(state.records[0].status, 'refused'); assert.ok(state.records[0].data);
  assert.ok(state.records.find((record) => record.id === 'example-unrelated-document').data);
  assert.equal(state.records.length, 3);
});

test('keep-copy intent changed during an in-flight batch controls that batch before acknowledgement', async () => {
  for (const keepCopy of [true, false]) {
    const { store, client, saved } = harness();
    await store.setRetention({ keepCopy: !keepCopy }); await store.capture(receipt()); await store.configure(true);
    const started = deferred(); const held = deferred(); const normal = client.uploadBatch.bind(client);
    client.uploadBatch = async (...args) => { started.resolve(); await held.promise; return normal(...args); };
    const sending = store.flush(); await started.promise;
    const changing = store.setRetention({ keepCopy });
    await new Promise(setImmediate);
    assert.equal((await store.snapshot()).settings.keepCopy, keepCopy);
    assert.equal(saved['fsd:imports:retention'].keepCopy, keepCopy);
    held.resolve(); await Promise.all([sending, changing]);
    assert.equal(Boolean(saved[recordsKey][0].data), keepCopy);
    assert.equal(Boolean((await store.snapshot()).records[0].data), keepCopy);
  }
});

test('routine cleanup and a duplicate sent capture perform no storage writes after migration is complete', async () => {
  const { store, storage } = harness();
  await store.capture(receipt()); await store.configure(true); await store.flush();
  const original = storage.set; let writes = 0;
  storage.set = async (...args) => { writes += 1; return original(...args); };
  await store.capture(receipt()); await store.cleanup(); await store.flush(); await store.cleanup();
  assert.equal(writes, 0);
});


test('legacy thin-summary migration cannot retain nested source figures or arbitrary free text', async () => {
  const { store, storage, saved, clock } = harness();
  await storage.set({ [settingsKey]: { userId: 1, enabled: false }, [recordsKey]: [{
    id: 'example-legacy-marker', kind: 'receipt', status: 'received', userId: 1,
    createdAt: new Date(clock.value).toISOString(), remoteId: 1,
    summary: { orderId: receipt().order_id, marketplace: { total_cents: 1234 }, layout: { items: ['EXAMPLE PRIVATE ITEM'] },
      itemCount: ['EXAMPLE PRIVATE ITEM'], warnings: 'EXAMPLE PRIVATE FREE TEXT', source_url: 'https://example.test/private' },
  }] });
  await store.cleanup();
  const summary = saved[recordsKey][0].summary;
  assert.deepEqual(summary, { orderId: receipt().order_id, marketplace: null, layout: null, itemCount: 0, warnings: ['unrecognized_warning'] });
  assert.ok(!JSON.stringify(summary).includes('EXAMPLE PRIVATE'));
});
