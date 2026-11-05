(function initializeAmzGiftCards(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader || {};
  const PATHS = new Set(['/gc/balance', '/gp/css/gc/balance']);
  const ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
  const text = (node) => node ? node.textContent.replace(/\s+/g, ' ').trim() : '';

  function pageKind(value) {
    try {
      const url = new URL(value);
      return url.origin === FSD.amz.origin && PATHS.has(url.pathname) ? 'balance' : null;
    } catch (error) {
      return null;
    }
  }

  function money(value) {
    const match = String(value || '').replace(/\u00a0/g, ' ').trim()
      .match(/^(-)?\s*\$\s*((?:\d{1,3}(?:,\d{3})+|\d+))\.(\d{2})$/);
    if (!match) return null;
    const cents = Number(match[2].replace(/,/g, '')) * 100 + Number(match[3]);
    return Number.isSafeInteger(cents) ? cents * (match[1] ? -1 : 1) : null;
  }

  function activityType(description) {
    // Load descriptions can include redeemable claim codes. Only classify the
    // preceding label; never retain the description or a claim-code suffix.
    const label = description.split(/\bclaim\s*code\b/i, 1)[0].toLowerCase();
    if (/gift card applied|applied to.*order/.test(label)) return 'redemption';
    if (/refund/.test(label)) return 'refund';
    if (/gift card(?: balance)?(?: was)? added|reload/.test(label)) return 'load';
    if (/adjust|expir|removed/.test(label)) return 'adjustment';
    return 'unknown';
  }

  function orderIds(cell) {
    const ids = new Set(text(cell).match(/\b\d{3}-\d{7}-\d{7}\b/g) || []);
    for (const link of cell.querySelectorAll('a[href]')) {
      try {
        const url = new URL(link.getAttribute('href'), FSD.amz.origin);
        const id = url.searchParams.get('orderID');
        if (url.origin === FSD.amz.origin && ORDER_ID.test(id || '')) ids.add(id);
      } catch (error) {
        // An unrelated or malformed link does not identify an order.
      }
    }
    return [...ids];
  }

  function parseSnapshot(doc, value) {
    if (!pageKind(value)) return null;
    const balance = money(text(doc.querySelector('#gc-ui-balance-gc-balance-value')));
    const table = doc.querySelector('#gc-balance-ledger-table');
    if (balance === null || balance < 0 || !table) return null;
    const headings = [...table.querySelectorAll('th')].map((node) => text(node).toLowerCase());
    if (headings.join('|') !== 'date|description|amount|closing balance') return null;
    const activities = [];
    let unparsed = false;
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.children].filter((cell) => cell.tagName === 'TD');
      if (!cells.length) continue;
      if (cells.length !== 4) { unparsed = true; continue; }
      const date = text(cells[0]);
      const amount = money(text(cells[2]));
      const closingBalance = money(text(cells[3]));
      if (!/^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(date)
        || amount === null || closingBalance === null || closingBalance < 0) {
        unparsed = true;
        continue;
      }
      activities.push({ date_text: date, activity_type: activityType(text(cells[1])),
        amount_cents: amount, balance_after_cents: closingBalance, order_ids: orderIds(cells[1]) });
    }
    const pagination = doc.querySelector('#gc-balance-ledger-pagination');
    return {
      schema: FSD.amz.giftCardSchema, marketplace: FSD.amz.marketplace, currency: 'USD',
      source_url: `${FSD.amz.origin}/gc/balance`, balance_cents: balance, activities,
      has_previous_page: Boolean(pagination?.querySelector('li:not(.a-last):not(.a-disabled) a')),
      has_next_page: Boolean(pagination?.querySelector('li.a-last:not(.a-disabled) a')),
      coverage: 'visible_page', warnings: unparsed ? ['unparsed_activity_rows'] : [],
    };
  }

  async function message(action, extra = {}) {
    const result = await root.browser.runtime.sendMessage({ action, ...extra });
    if (!result || !result.ok) throw new Error(result?.error || 'Gift-card snapshot storage is unavailable');
    return result;
  }

  let capturing = false;
  let observationPending = false;
  let lastSnapshot = '';
  let generation = null;
  async function captureCurrentPage() {
    if (root.browser.extension?.inIncognitoContext) return;
    if (capturing) { observationPending = true; return; }
    capturing = true;
    try {
      // Read the preference before touching balance or activity cells.
      const policy = await message('amzCapturePolicy');
      if (!policy.enabled) { lastSnapshot = ''; return; }
      if (generation !== policy.generation) { generation = policy.generation; lastSnapshot = ''; }
      const snapshot = parseSnapshot(root.document, root.location.href);
      if (!snapshot) { lastSnapshot = ''; await message('amzPageStatus', { state: 'unreadable' }); return; }
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSnapshot) return;
      await message('captureAmzGiftCardSnapshot', { snapshot });
      lastSnapshot = serialized;
    } finally {
      capturing = false;
      if (observationPending) {
        observationPending = false;
        await captureCurrentPage();
      }
    }
  }

  /** @type {FsdProvider} */
  const provider = {
    id: 'amz-gift-cards', label: `${FSD.amz.displayName} gift-card balance and activity`, requiresDateRange: false, passive: true,
    observePage: captureCurrentPage,
    isSupportedPage: () => Boolean(pageKind(root.location.href)),
    findMountPoint: () => root.document.querySelector('#gc-balance-table h1, h1'),
    renderControls() {},
    async readOptions() { return {}; },
    async discoverDocuments() {
      await captureCurrentPage();
      const result = await message('listAmzGiftCardSnapshots');
      return result.snapshots.map((snapshot) => FSD.normalizeDocument('amz-gift-cards', {
        id: snapshot.id, title: `${FSD.amz.displayName} gift-card activity (${snapshot.data.activities.length} rows)`,
        category: 'gift-card-balance', filename: `GiftCards/AMZ/${snapshot.id.slice(0, 12)}.json`,
        metadata: { snapshot: snapshot.data },
      }));
    },
    async downloadDocument(document) {
      const data = new TextEncoder().encode(JSON.stringify(document.metadata.snapshot, null, 2));
      return { data: Array.from(data), filename: document.filename, contentType: 'application/json' };
    },
    helpers: { pageKind, money, activityType, parseSnapshot, captureCurrentPage },
  };

  FSD.providers = Object.assign(FSD.providers || {}, { amzGiftCards: provider });
  root.FinancialStatementDownloader = FSD;
})(globalThis);
