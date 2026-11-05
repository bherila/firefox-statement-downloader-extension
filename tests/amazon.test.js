'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseHTML } = require('linkedom');
require('../core/runtime.js');
require('../providers/amazon.js');
const provider = global.FinancialStatementDownloader.providers.amazon;
const { money, pageKind, parseReceipt } = provider.helpers;
const ORDER = '100-1000000-1000000';
const url = (path = '/your-orders/order-details') => `https://www.amazon.com${path}?orderID=${ORDER}&ref=example`;
const doc = (html) => parseHTML(`<html><body>${html}</body></html>`).document;
const standard = (items = 1) => `
  <div data-component="orderDate">January 2, 2026</div>
  <div data-component="orderId">Order # ${ORDER}</div>
  ${Array.from({ length: items }, (_, i) => `
    <div data-component="purchasedItems">
      <div data-component="itemTitle"><a href="/dp/B00000000${i}?ref=example">EXAMPLE PRODUCT ${i}</a></div>
      <div data-component="quantity">Quantity: 2</div>
      <div data-component="unitPrice"><span class="a-offscreen">$12.34</span><span aria-hidden="true">$12.34</span></div>
      <div data-component="orderedMerchant">Sold by: EXAMPLE MERCHANT</div>
    </div>`).join('')}
  <div id="od-subtotals">
    <div class="od-line-item-row"><div class="od-line-item-row-label">Item(s) Subtotal:</div><div class="od-line-item-row-content">$24.68</div></div>
    <div class="od-line-item-row"><div class="od-line-item-row-label">Promotion Applied:</div><div class="od-line-item-row-content">-$1.00</div></div>
    <div class="od-line-item-row"><div class="od-line-item-row-label">Grand Total:</div><div class="od-line-item-row-content">$23.68</div></div>
  </div>`;

test('claims only supported Amazon US history and detail URLs', () => {
  assert.equal(pageKind('https://www.amazon.com/gp/css/order-history'), 'history');
  assert.equal(pageKind('https://www.amazon.com/your-orders/orders?page=2'), 'history');
  assert.equal(pageKind(url()), 'detail');
  assert.equal(pageKind('https://www.amazon.com.evil.example.test/your-orders/order-details'), null);
  assert.equal(pageKind('https://www.amazon.com/ap/signin'), null);
  assert.equal(pageKind('https://www.amazon.co.uk/your-orders/orders'), null);
});

test('money uses exact signed integer cents and refuses ambiguous or foreign amounts', () => {
  assert.equal(money('$1,234.56'), 123456);
  assert.equal(money('- $0.03'), -3);
  assert.equal(money('$0.00'), 0);
  for (const value of ['$1.2', '$1,23.00', '€1.23', '$1.23 $1.23', '', '1.23']) assert.equal(money(value), null);
});

test('standard receipts keep line items, labeled adjustments, and canonical product/source URLs', () => {
  const receipt = parseReceipt(doc(standard(2)), url());
  assert.equal(receipt.items.length, 2);
  assert.equal(receipt.items[0].unit_price_cents, 1234);
  assert.equal(receipt.items[0].line_total_cents, null);
  assert.equal(receipt.items[0].quantity, 2);
  assert.equal(receipt.items[0].product_url, 'https://www.amazon.com/dp/B000000000');
  assert.equal(receipt.charges[1].amount_cents, -100);
  assert.equal(receipt.total_cents, 2368);
  assert.equal(receipt.order_date_text, 'January 2, 2026');
  assert.equal(receipt.source_url, url().split('&')[0]);
  assert.deepEqual(receipt.warnings, []);
});

test('refuses history summaries, sign-in pages, missing totals sections, and transitioning order identities', () => {
  assert.equal(parseReceipt(doc(standard()), 'https://www.amazon.com/your-orders/orders'), null);
  assert.equal(parseReceipt(doc('<form>Sign in</form>'), url()), null);
  assert.equal(parseReceipt(doc(standard().replace(ORDER, '200-2000000-2000000')), url()), null);
  assert.equal(parseReceipt(doc('<div data-component="purchasedItems">Incomplete</div>'), url()), null);
});

test('missing prices and grand totals produce review warnings rather than invented amounts', () => {
  const receipt = parseReceipt(doc(standard().replace(/<div data-component="unitPrice">.*?<\/div>/, '')
    .replace('Grand Total:', 'Shipping:')), url());
  assert.equal(receipt.total_cents, null);
  assert.deepEqual(receipt.warnings, ['order_total_missing', 'item_price_missing']);
});

test('Whole Foods receipts distinguish unit and line prices and keep purchase/delivery dates separate', () => {
  const receipt = parseReceipt(doc(`
    <h2 id="ufpo-order-status-primary">Purchased at EXAMPLE STORE</h2>
    <span id="ufpo-order-status-secondary">Delivered on January 3, 2026</span>
    <div id="f3_food_ItemList">
      <div class="a-row a-spacing-base"><div><img class="ufpo-itemListWidget-image"></div>
        <a href="/gp/product/B000000000">EXAMPLE GROCERIES</a>
        <div class="a-text-right">$9.00</div><div>Qty: 3 @ $3.00 each</div>
      </div>
    </div>
    <div id="f3_food_WfmInStoreOrderSummary"><table>
      <tr><td id="wfm-subtotal-label">Subtotal</td><td id="wfm-subtotal-amount">$9.00</td></tr>
      <tr><td id="wfm-grand-total-label">Total</td><td id="wfm-grand-total-amount">$9.00</td></tr>
    </table></div>`), url('/fopo/order-details'));
  assert.equal(receipt.layout, 'whole_foods');
  assert.equal(receipt.items[0].quantity, 3);
  assert.equal(receipt.items[0].unit_price_cents, 300);
  assert.equal(receipt.items[0].line_total_cents, 900);
  assert.equal(receipt.total_cents, 900);
  assert.equal(receipt.order_date_text, null);
  assert.equal(receipt.delivery_date_text, 'Delivered on January 3, 2026');
});

test('Fresh reads full preloaded table and excludes carousel duplicates without clicking or fetching', () => {
  const receipt = parseReceipt(doc(`
    <div class="ufpo-carousel-item"><a href="/dp/B000000000">EXAMPLE GROCERIES</a></div>
    <div id="item-list-page" hidden><div id="B000000000-item-grid-row">
      <a href="/dp/B000000000">EXAMPLE GROCERIES</a>
      <div class="a-span1 a-text-center">2</div><span id="B000000000-item-total-price">$6.00</span>
    </div></div>
    <div id="order-summary"><dl class="ufpo-charge-breakdown">
      <div class="a-row"><dt>Item(s) Subtotal:</dt><dd>$6.00</dd></div>
      <div class="a-row"><dt>Grand Total:</dt><dd>$7.00</dd></div>
    </dl></div>`), url('/uff/your-account/order-details'));
  assert.equal(receipt.layout, 'fresh');
  assert.equal(receipt.items.length, 1);
  assert.equal(receipt.items[0].quantity, 2);
  assert.equal(receipt.items[0].unit_price_cents, null);
  assert.equal(receipt.items[0].line_total_cents, 600);
  assert.equal(receipt.total_cents, 700);
});

test('ASIN-less grocery purchases remain line items even when no product link exists', () => {
  const receipt = parseReceipt(doc(`
    <div id="f3_food_ItemList"><div class="a-row a-spacing-base">
      <div><img class="ufpo-itemListWidget-image"></div>
      <div class="a-column a-span10"><span class="a-size-small">EXAMPLE PRODUCE</span></div>
      <div class="a-text-right">$2.50</div><div>Qty: 0.5 lb @ $5.00/lb</div>
    </div></div>
    <div id="f3_food_WfmInStoreOrderSummary"><table>
      <tr><td id="wfm-grand-total-label">Total</td><td id="wfm-grand-total-amount">$2.50</td></tr>
    </table></div>`), url('/fopo/order-details'));
  assert.equal(receipt.items.length, 1);
  assert.equal(receipt.items[0].asin, null);
  assert.equal(receipt.items[0].product_url, null);
  assert.equal(receipt.items[0].quantity, 0.5);
  assert.equal(receipt.items[0].quantity_unit, 'lb');
  assert.equal(receipt.items[0].line_total_cents, 250);
});

test('passive observation saves each stable page once, including after a failed first attempt', async () => {
  const saved = [];
  let fail = true;
  global.document = doc(standard());
  global.location = { href: url() };
  global.browser = { runtime: { async sendMessage(message) {
    if (fail) { fail = false; return { ok: false, error: 'Storage full' }; }
    saved.push(message); return { ok: true };
  } } };
  try {
    await assert.rejects(provider.observePage(), /Storage full/);
    await provider.observePage();
    await provider.observePage();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].action, 'captureAmazonReceipt');
  } finally {
    delete global.document; delete global.location; delete global.browser;
  }
});
