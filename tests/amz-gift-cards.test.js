'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { amz } = require('../scripts/build.js');
const { parseHTML } = require('linkedom');
require('../core/runtime.js');
require('../core/storage.js');
require('../core/batch.js');
const providerPath = require.resolve('../providers/amz-gift-cards.js');

const URL = `${amz.origin}/gc/balance?ref_=example&next=EXAMPLE_CURSOR`;
const ORDER = '100-1000000-1000000';
const OTHER_ORDER = '200-2000000-2000000';
const row = (description, amount = '-$10.00', balance = '$20.00', date = 'January 2, 2026') =>
  `<tr><td>${date}</td><td>${description}</td><td>${amount}</td><td>${balance}</td></tr>`;
const page = (rows = row(`Gift Card applied to ${amz.marketplace} order <a href="/gp/your-account/order-details?orderID=${ORDER}&ref_=example">${ORDER}</a>`), balance = '$20.00', pagination = '<li><a href="?previous=EXAMPLE_CURSOR">Previous</a></li><li class="a-last"><a href="?next=EXAMPLE_CURSOR">Next</a></li>') => `
  <html><body><h1>Gift Cards</h1>
    <span id="gc-ui-balance-gc-balance-value">${balance}</span>
    <table id="gc-balance-ledger-table"><tr><th>Date</th><th>Description</th><th>Amount</th><th>Closing balance</th></tr>${rows}</table>
    <nav id="gc-balance-ledger-pagination"><ul>${pagination}</ul></nav>
  </body></html>`;
const doc = (html) => parseHTML(html).document;

function loadProvider() {
  delete require.cache[providerPath];
  require(providerPath);
  return global.FinancialStatementDownloader.providers.amzGiftCards;
}

test('claims only the two US gift-card balance paths and excludes adjacent account pages', () => {
  const { pageKind } = loadProvider().helpers;
  assert.equal(pageKind(URL), 'balance');
  assert.equal(pageKind(`${amz.origin}/gp/css/gc/balance?ref_=example`), 'balance');
  for (const value of [`${amz.origin}/gc/balance/reload`, `${amz.origin}/gp/css/gc/payment`,
    `${amz.origin.replace('.com', '.co.uk')}/gc/balance`, `${amz.origin}.evil.example.test/gc/balance`, 'not a URL']) assert.equal(pageKind(value), null);
});

test('captures signed activity and closing balances without pagination cursors or arbitrary descriptions', () => {
  const { parseSnapshot } = loadProvider().helpers;
  const snapshot = parseSnapshot(doc(page()), URL);
  assert.equal(snapshot.schema, amz.giftCardSchema);
  assert.equal(snapshot.balance_cents, 2000);
  assert.equal(snapshot.source_url, `${amz.origin}/gc/balance`);
  assert.deepEqual(snapshot.activities, [{ date_text: 'January 2, 2026', activity_type: 'redemption',
    amount_cents: -1000, balance_after_cents: 2000, order_ids: [ORDER] }]);
  assert.equal(snapshot.has_previous_page, true);
  assert.equal(snapshot.has_next_page, true);
  assert.equal(snapshot.coverage, 'visible_page');
  assert.deepEqual(snapshot.warnings, []);
  assert.ok(!JSON.stringify(snapshot).includes('EXAMPLE_CURSOR'));
});

test('classifies only safe labels and excludes claim codes, page credentials, addresses, and unrelated links', () => {
  const { parseSnapshot } = loadProvider().helpers;
  const html = page(row('Gift Card added Claim code: EXAMPLE-REFUND-CODE', '$25.00', '$25.00')
    + row('Refund applied to Gift Card balance', '$5.00', '$30.00')
    + row('Balance adjusted', '$1.00', '$31.00')
    + row('EXAMPLE UNKNOWN LABEL <a href="https://example.test/?orderID=BAD">Details</a>', '$2.00', '$33.00'))
    .replace('</body>', '<input name="csrf" value="EXAMPLE_CREDENTIAL"><div>EXAMPLE ADDRESS</div></body>');
  const snapshot = parseSnapshot(doc(html), URL);
  assert.deepEqual(snapshot.activities.map((activity) => activity.activity_type), ['load', 'refund', 'adjustment', 'unknown']);
  const serialized = JSON.stringify(snapshot);
  for (const excluded of ['EXAMPLE-REFUND-CODE', 'EXAMPLE_CREDENTIAL', 'EXAMPLE ADDRESS', 'EXAMPLE UNKNOWN LABEL', 'example.test', 'description']) assert.ok(!serialized.includes(excluded));
  assert.deepEqual(snapshot.warnings, []);
});

test('preserves a zero balance, an empty history, and disabled pagination boundaries', () => {
  const { parseSnapshot } = loadProvider().helpers;
  const empty = parseSnapshot(doc(page('', '$0.00', '<li class="a-disabled">Previous</li><li class="a-disabled a-last">Next</li>')), URL);
  assert.equal(empty.balance_cents, 0);
  assert.deepEqual(empty.activities, []);
  assert.equal(empty.has_previous_page, false);
  assert.equal(empty.has_next_page, false);
  const first = parseSnapshot(doc(page(undefined, '$20.00', '<li class="a-disabled">Previous</li><li class="a-last"><a href="?next=EXAMPLE">Next</a></li>')), URL);
  assert.equal(first.has_previous_page, false);
  assert.equal(first.has_next_page, true);
});

test('collects every linked order while preserving indistinguishable repeated activity rows', () => {
  const { parseSnapshot } = loadProvider().helpers;
  const description = `Gift Card applied to order <a href="/your-orders/order-details?orderID=${ORDER}">${ORDER}</a> and <a href="/your-orders/order-details?orderID=${OTHER_ORDER}">${OTHER_ORDER}</a>`;
  const html = page(row(description) + row(description));
  const snapshot = parseSnapshot(doc(html), URL);
  assert.equal(snapshot.activities.length, 2);
  assert.deepEqual(snapshot.activities[0].order_ids, [ORDER, OTHER_ORDER]);
  assert.deepEqual(snapshot.activities[0], snapshot.activities[1]);
});

test('incomplete numeric rows are held for review and wrong layouts do not produce snapshots', () => {
  const { parseSnapshot } = loadProvider().helpers;
  const snapshot = parseSnapshot(doc(page(row('Gift Card added', '$5.00', '$5.00') + row('Gift Card applied', 'loading', '$0.00'))), URL);
  assert.equal(snapshot.activities.length, 1);
  assert.deepEqual(snapshot.warnings, ['unparsed_activity_rows']);
  assert.equal(parseSnapshot(doc(page(undefined, 'loading')), URL), null);
  assert.equal(parseSnapshot(doc(page().replace('Closing balance', 'Unrecognized column')), URL), null);
  assert.equal(parseSnapshot(doc('<html><body>Sign in</body></html>'), URL), null);
});

test('money remains integer cents and rejects foreign, ambiguous, or unsafe amounts', () => {
  const { money } = loadProvider().helpers;
  assert.equal(money('$1,234.56'), 123456);
  assert.equal(money('-$0.03'), -3);
  assert.equal(money('$0.00'), 0);
  for (const value of ['€1.00', '$1,23.00', '$1.00 $1.00', '$1.2', '$999999999999999999.00']) assert.equal(money(value), null);
});

test('passive capture saves the final text after an overlapping storage acknowledgement', async () => {
  const provider = loadProvider();
  const captured = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  global.document = doc(page());
  global.location = { href: URL };
  global.browser = { runtime: { async sendMessage(message) {
    if (message.action === 'amzCapturePolicy') return { ok: true, enabled: true, generation: 0 };
    assert.equal(message.action, 'captureAmzGiftCardSnapshot');
    captured.push(message.snapshot);
    if (captured.length === 1) { entered(); await held; }
    return { ok: true };
  } } };
  try {
    const first = provider.observePage();
    await started;
    global.document.querySelector('#gc-ui-balance-gc-balance-value').textContent = '$30.00';
    await provider.observePage();
    release(); await first;
    await provider.observePage();
    assert.equal(captured.length, 2);
    assert.equal(captured[1].balance_cents, 3000);
  } finally { delete global.document; delete global.location; delete global.browser; }
});

test('a failed save is retried when observation runs again and discover lists only stored snapshots', async () => {
  const provider = loadProvider();
  const snapshot = provider.helpers.parseSnapshot(doc(page()), URL);
  let fail = true;
  let captures = 0;
  global.document = doc(page()); global.location = { href: URL };
  global.browser = { runtime: { async sendMessage(message) {
    if (message.action === 'amzCapturePolicy') return { ok: true, enabled: true, generation: 0 };
    if (message.action === 'captureAmzGiftCardSnapshot') {
      captures += 1;
      if (fail) { fail = false; return { ok: false, error: 'Storage unavailable' }; }
    }
    return { ok: true, snapshots: [{ id: 'example-source-hash', data: snapshot }] };
  } } };
  try {
    await assert.rejects(provider.observePage(), /Storage unavailable/);
    const documents = await provider.discoverDocuments();
    assert.equal(captures, 2);
    assert.equal(documents.length, 1);
    assert.equal(documents[0].provider, 'amz-gift-cards');
    assert.equal(documents[0].metadata.snapshot.balance_cents, 2000);
  } finally { delete global.document; delete global.location; delete global.browser; }
});

test('the shared batch runner downloads snapshot bytes once and marks the source complete', async () => {
  const provider = loadProvider();
  const snapshot = provider.helpers.parseSnapshot(doc(page()), URL);
  let downloads = 0;
  const completed = new Set();
  global.browser = { runtime: { async sendMessage(message) {
    if (message.action === 'amzCapturePolicy') return { ok: true, enabled: true, generation: 0 };
    assert.equal(message.action, 'downloadData'); downloads += 1;
    assert.equal(JSON.parse(new TextDecoder().decode(new Uint8Array(message.data))).schema, snapshot.schema);
    return { ok: true, downloadId: downloads };
  } } };
  try {
    const result = await global.FinancialStatementDownloader.runBatch({ provider, options: {
      documents: [{ id: 'example-snapshot', title: 'Example gift-card snapshot', category: 'gift-card-balance',
        filename: 'GiftCards/AMZ/example.json', metadata: { snapshot } }],
      checkDownloadHistory: false, storage: { async isDone() { return false; }, async markDone(item) { completed.add(item.id); } },
      delayMs: 0, retryDelayMs: 0,
    } });
    assert.equal(downloads, 1);
    assert.equal(result.downloaded, 1);
    assert.equal(result.failed, 0);
    assert.equal(completed.has('example-snapshot'), true);
  } finally { delete global.browser; }
});

test('manifest loads the provider in content and background contexts and matches balance paths', () => {
  const manifest = require('../scripts/build.js').buildManifest();
  assert.ok(manifest.background.scripts.includes('providers/amz-gift-cards.js'));
  assert.ok(manifest.content_scripts[0].js.includes('providers/amz-gift-cards.js'));
  for (const match of [`${amz.origin}/gc/balance*`, `${amz.origin}/gp/css/gc/balance*`]) assert.ok(manifest.content_scripts[0].matches.includes(match));
});

test('disabled balance capture and private windows read no source cells and save nothing', async () => {
  for (const privateWindow of [false, true]) {
    const provider = loadProvider(); let messages = 0;
    global.document = { querySelector() { throw new Error('Source cells must not be read'); } };
    global.location = { href: URL };
    global.browser = { extension: { inIncognitoContext: privateWindow }, runtime: { async sendMessage(message) {
      messages += 1; assert.equal(message.action, 'amzCapturePolicy'); return { ok: true, enabled: false, generation: 0 };
    } } };
    try { await provider.observePage(); assert.equal(messages, privateWindow ? 0 : 1); }
    finally { delete global.document; delete global.location; delete global.browser; }
  }
});
