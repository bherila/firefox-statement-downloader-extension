(function initializeAmazon(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader || {};
  const DETAIL_PATHS = new Set(['/your-orders/order-details', '/fopo/order-details', '/uff/your-account/order-details']);
  const HISTORY_PATHS = new Set(['/gp/css/order-history', '/your-orders/orders']);
  const component = (name) => `[data-component="${name}"]`;
  const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
  const read = (node, selector) => text(node.querySelector(selector));

  function pageKind(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://www.amazon.com') return null;
      if (DETAIL_PATHS.has(url.pathname)) return 'detail';
      return HISTORY_PATHS.has(url.pathname) ? 'history' : null;
    } catch (error) {
      return null;
    }
  }

  // US receipts only. Keep integer cents and preserve the source labels instead
  // of guessing whether discounts/refunds have already been included in a total.
  function money(value) {
    const match = String(value || '').replace(/\u00a0/g, ' ').trim()
      .match(/^(-)?\s*\$\s*((?:\d{1,3}(?:,\d{3})+|\d+))\.(\d{2})$/);
    if (!match) return null;
    const cents = Number(match[2].replace(/,/g, '')) * 100 + Number(match[3]);
    return Number.isSafeInteger(cents) ? cents * (match[1] ? -1 : 1) : null;
  }

  function amount(node, selector) {
    const el = node.querySelector(selector);
    if (!el) return null;
    return money(read(el, '.a-offscreen') || text(el));
  }

  function product(node, titleSelector) {
    const link = node.querySelector(titleSelector);
    const title = text(link);
    if (!title) return null;
    const href = link.getAttribute('href') || '';
    const asin = (href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/) || [])[1] || null;
    return { title, asin, product_url: asin ? `https://www.amazon.com/dp/${asin}` : null };
  }

  function parseReceipt(doc, value) {
    if (pageKind(value) !== 'detail') return null;
    const url = new URL(value);
    const orderId = url.searchParams.get('orderID');
    if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId || '')) return null;
    // Never attach one order's DOM to another order during a client-side transition.
    const displayedId = read(doc, component('orderId')).match(/\d{3}-\d{7}-\d{7}/);
    if (displayedId && displayedId[0] !== orderId) return null;

    const layout = url.pathname.startsWith('/fopo/') ? 'whole_foods'
      : url.pathname.startsWith('/uff/') ? 'fresh' : 'standard';
    const items = [];
    const charges = [];
    const warnings = [];
    const itemSelector = layout === 'standard' ? component('purchasedItems')
      : layout === 'whole_foods' ? '#f3_food_ItemList .ufpo-itemListWidget-image'
        : '#item-list-page [id$="-item-grid-row"]';
    const expectedItems = doc.querySelectorAll(itemSelector).length;
    if (layout === 'standard') {
      for (const node of doc.querySelectorAll(component('purchasedItems'))) {
        const item = product(node, `${component('itemTitle')} a`);
        if (!item) continue;
        const quantityText = read(node, component('quantity')) || read(node, `${component('itemImage')} .a-badge-text`);
        const quantityMatch = quantityText.match(/(?:^|\b)(\d+)(?:\b|$)/);
        items.push({ ...item, quantity: quantityMatch ? Number(quantityMatch[1]) : 1, quantity_unit: 'each',
          unit_price_cents: amount(node, component('unitPrice')), line_total_cents: null,
          seller: read(node, component('orderedMerchant')) || null,
          condition: read(node, component('itemCondition')) || null });
      }
      for (const row of doc.querySelectorAll('#od-subtotals .od-line-item-row')) {
        const label = read(row, '.od-line-item-row-label');
        const value = money(read(row, '.od-line-item-row-content'));
        if (label && value !== null) charges.push({ label, amount_cents: value });
      }
    } else if (layout === 'whole_foods') {
      for (const image of doc.querySelectorAll('#f3_food_ItemList .ufpo-itemListWidget-image')) {
        const node = image.closest('.a-row.a-spacing-base');
        if (!node) continue;
        const item = product(node, 'a, .a-column.a-span10 > span.a-size-small');
        if (!item) continue;
        const quantity = text(node).match(/Qty:\s*(\d+(?:\.\d+)?)\s*(lb|oz)?\s*@\s*(\$[\d,.]+)\s*(?:each|\/\s*(lb|oz))?/i);
        items.push({ ...item, quantity: quantity ? Number(quantity[1]) : null,
          quantity_unit: quantity ? (quantity[2] || quantity[4] || 'each').toLowerCase() : null,
          unit_price_cents: quantity ? money(quantity[3]) : null,
          line_total_cents: amount(node, '.a-text-right'), seller: 'Whole Foods Market', condition: null });
      }
      for (const row of doc.querySelectorAll('#f3_food_WfmInStoreOrderSummary tr')) {
        const label = read(row, '[id$="-label"]');
        const value = money(read(row, '[id$="-amount"]'));
        if (label && value !== null) charges.push({ label, amount_cents: value });
      }
    } else {
      // Fresh already includes the full item table in the document, even when
      // the UI initially shows a carousel. Reading it needs no click or request.
      for (const node of doc.querySelectorAll('#item-list-page [id$="-item-grid-row"]')) {
        const item = product(node, 'a');
        if (!item) continue;
        const quantity = read(node, '.a-span1.a-text-center');
        items.push({ ...item, quantity: /^\d+$/.test(quantity) ? Number(quantity) : null, quantity_unit: 'each',
          unit_price_cents: null, line_total_cents: amount(node, '[id$="-item-total-price"]'),
          seller: null, condition: null });
      }
      for (const row of doc.querySelectorAll('#order-summary .ufpo-charge-breakdown > .a-row')) {
        const label = read(row, 'dt');
        const value = money(read(row, 'dd'));
        if (label && value !== null) charges.push({ label, amount_cents: value });
      }
    }
    if (!items.length || !charges.length) return null;
    if (items.length !== expectedItems) warnings.push('unparsed_items');
    const total = [...charges].reverse().find((charge) => /grand total|^total:?$/i.test(charge.label));
    if (!total) warnings.push('order_total_missing');
    if (items.some((item) => item.quantity === null)) warnings.push('item_quantity_missing');
    if (items.some((item) => item.unit_price_cents === null && item.line_total_cents === null)) warnings.push('item_price_missing');
    // Keep dates as printed. A purchase/placement date differs from the delivery
    // date on grocery pages, so label those separately and do not infer one.
    const secondaryStatus = read(doc, '#ufpo-order-status-secondary');
    const orderDate = read(doc, component('orderDate')) || (/purchased|ordered|placed/i.test(secondaryStatus) ? secondaryStatus : null);
    const status = read(doc, component('shipmentStatus')) || read(doc, '#ufpo-order-status-primary');
    return {
      schema: 'amazon.receipt.v1', marketplace: 'amazon.com', currency: 'USD', order_id: orderId, layout,
      source_url: `${url.origin}${url.pathname}?orderID=${orderId}`,
      order_date_text: orderDate,
      status_text: [status, secondaryStatus].filter(Boolean).join(' · ') || null,
      delivery_date_text: /deliver|arriv/i.test(secondaryStatus) ? secondaryStatus : null,
      items, charges, total_cents: total ? total.amount_cents : null, warnings,
    };
  }

  async function message(action, extra = {}) {
    const result = await root.browser.runtime.sendMessage({ action, ...extra });
    if (!result || !result.ok) throw new Error(result && result.error || 'Receipt storage is unavailable');
    return result;
  }

  let capturing = false;
  let observationPending = false;
  let lastReceipt = '';
  async function captureCurrentPage() {
    if (capturing) {
      observationPending = true;
      return;
    }
    const receipt = parseReceipt(root.document, root.location.href);
    if (!receipt) return;
    const serialized = JSON.stringify(receipt);
    if (serialized === lastReceipt) return;
    capturing = true;
    try {
      await message('captureAmazonReceipt', { receipt });
      lastReceipt = serialized;
    } finally {
      capturing = false;
    }
    if (observationPending) {
      observationPending = false;
      await captureCurrentPage();
    }
  }

  /** @type {FsdProvider} */
  const provider = {
    id: 'amazon', label: 'Amazon receipts', requiresDateRange: false,
    observePage: captureCurrentPage,
    isSupportedPage: () => Boolean(pageKind(root.location.href)),
    findMountPoint: () => root.document.querySelector(`${component('orderDetailsTitle')}, h1`),
    renderControls(container) {
      const description = root.document.createElement('p');
      description.textContent = 'Receipts are saved automatically when you open an order’s details. Browse normally; no orders or receipt pages are opened for you. Find documents lists your locally collected receipts.';
      const button = root.document.createElement('button');
      button.type = 'button';
      button.textContent = 'Import settings and collected receipts';
      button.addEventListener('click', () => message('openImportOptions').catch(() => {}));
      container.append(description, button);
    },
    async readOptions() { return {}; },
    async discoverDocuments() {
      await captureCurrentPage();
      const result = await message('listAmazonReceipts');
      return result.receipts.map((receipt) => FSD.normalizeDocument('amazon', {
        id: receipt.id, title: `Amazon order ${receipt.data.order_id}`, category: 'receipt',
        filename: `Receipts/Amazon/${receipt.data.order_id}-${receipt.id.slice(0, 12)}.json`,
        metadata: { receipt: receipt.data },
      }));
    },
    async downloadDocument(document) {
      const data = new TextEncoder().encode(JSON.stringify(document.metadata.receipt, null, 2));
      return message('downloadData', { data: Array.from(data), filename: document.filename, contentType: 'application/json' });
    },
    helpers: { pageKind, money, parseReceipt, captureCurrentPage },
  };

  FSD.providers = Object.assign(FSD.providers || {}, { amazon: provider });
  root.FinancialStatementDownloader = FSD;
})(globalThis);
