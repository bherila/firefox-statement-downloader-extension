(function initializeImportStore(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader || {};
  const SETTINGS = 'fsd:imports:settings';
  const PAUSED = 'fsd:imports:paused';
  const RECORDS = 'fsd:imports:records';
  const MAX_RECORDS = 2000;
  const MAX_RECEIPT_BYTES = 512 * 1024;

  async function hash(bytes) {
    return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes)))
      .map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  function createImportStore(storage = root.browser.storage.local, client = FSD.importClient.createImportClient()) {
    // All writers, including different tabs and the alarm, share one background
    // queue. Never do content-script storage read/modify/write for the outbox.
    let tail = Promise.resolve();
    let syncing = null;
    let pauseRequested = false;
    let preferenceVersion = 0;
    const serial = (fn) => {
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    };
    async function load() {
      const saved = await storage.get([SETTINGS, RECORDS, PAUSED]);
      const settings = saved[SETTINGS] || { enabled: false, userId: null };
      return { settings: saved[PAUSED] ? { ...settings, enabled: false } : settings, records: saved[RECORDS] || [] };
    }
    const saveRecords = (records) => storage.set({ [RECORDS]: records });

    async function capture(receipt) {
      // Reconstruct an allowlisted payload; never retain DOM/headers/addresses
      // or arbitrary extra fields from a provider message.
      if (!receipt || receipt.schema !== 'amazon.receipt.v1' || receipt.marketplace !== 'amazon.com'
        || receipt.currency !== 'USD' || !/^\d{3}-\d{7}-\d{7}$/.test(receipt.order_id || '')
        || !['standard', 'whole_foods', 'fresh'].includes(receipt.layout)
        || !Array.isArray(receipt.items) || !receipt.items.length || receipt.items.length > 500
        || !Array.isArray(receipt.charges) || !receipt.charges.length || receipt.charges.length > 100) {
        throw new Error('Invalid Amazon receipt.');
      }
      const optionalText = (value, max = 2000) => {
        if (value === null || value === undefined) return null;
        if (typeof value !== 'string' || value.length > max) throw new Error('Invalid receipt text.');
        return value;
      };
      const cents = (value) => {
        if (value === null) return null;
        if (!Number.isSafeInteger(value)) throw new Error('Invalid receipt amount.');
        return value;
      };
      const source = new URL(receipt.source_url);
      if (FSD.providers.amazon.helpers.pageKind(source.href) !== 'detail'
        || source.searchParams.get('orderID') !== receipt.order_id) throw new Error('Invalid receipt source.');
      const data = {
        schema: receipt.schema, marketplace: receipt.marketplace, currency: receipt.currency,
        order_id: receipt.order_id, layout: receipt.layout,
        source_url: `https://www.amazon.com${source.pathname}?orderID=${receipt.order_id}`,
        order_date_text: optionalText(receipt.order_date_text, 300), status_text: optionalText(receipt.status_text, 1000),
        delivery_date_text: optionalText(receipt.delivery_date_text, 300),
        items: receipt.items.map((item) => {
          const title = optionalText(item.title);
          if (!title) throw new Error('Missing receipt item title.');
          if (item.asin !== null && !/^[A-Z0-9]{10}$/.test(item.asin)) throw new Error('Invalid ASIN.');
          if (item.quantity !== null && (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 100000)) throw new Error('Invalid receipt quantity.');
          if (item.quantity_unit !== null && !['each', 'lb', 'oz'].includes(item.quantity_unit)) throw new Error('Invalid receipt quantity unit.');
          return { title, asin: item.asin, product_url: item.asin ? `https://www.amazon.com/dp/${item.asin}` : null,
            quantity: item.quantity, quantity_unit: item.quantity_unit,
            unit_price_cents: cents(item.unit_price_cents), line_total_cents: cents(item.line_total_cents),
            seller: optionalText(item.seller, 1000), condition: optionalText(item.condition, 1000) };
        }),
        charges: receipt.charges.map((charge) => ({ label: optionalText(charge.label, 300), amount_cents: cents(charge.amount_cents) })),
        total_cents: cents(receipt.total_cents),
        warnings: Array.isArray(receipt.warnings) ? receipt.warnings.map((warning) => optionalText(warning, 100)).slice(0, 50) : [],
      };
      const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
      if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('Receipt is too large to save.');
      const id = await hash(bytes);
      return serial(async () => {
        const { settings, records } = await load();
        // Same bytes are a no-op; later changes to an order become a new source
        // revision. The first observation time lives outside the hashed bytes.
        if (!records.some((record) => record.id === id)) {
          if (records.length >= MAX_RECORDS) throw new Error('Receipt storage is full. Export and clear receipts in settings.');
          records.push({ id, kind: 'receipt', provider: 'amazon', data,
            filename: `amazon-${data.order_id}-${id.slice(0, 12)}.json`, contentType: 'application/json',
            createdAt: new Date().toISOString(), userId: settings.userId, status: 'local' });
          await saveRecords(records);
        }
        return { id, count: records.length };
      });
    }

    async function configure(enabled) {
      const version = ++preferenceVersion;
      if (!enabled) {
        // This gate has its own storage key: pausing must be effective and
        // durable even while the record queue awaits an in-flight upload.
        pauseRequested = true;
        await storage.set({ [PAUSED]: true });
        return serial(async () => {
          const { settings } = await load();
          await storage.set({ [SETTINGS]: { ...settings, enabled: false } });
        });
      }
      // Only settings UI can call this. Pin the recipient; a different login
      // never silently takes over previously collected private documents.
      const active = await client.session();
      return serial(async () => {
        if (version !== preferenceVersion) throw new Error('Import preferences changed while connecting.');
        const { records } = await load();
        if (version !== preferenceVersion) throw new Error('Import preferences changed while connecting.');
        for (const record of records) if (record.userId === null) record.userId = active.userId;
        await storage.set({ [SETTINGS]: { enabled: true, userId: active.userId }, [RECORDS]: records, [PAUSED]: false });
        if (version !== preferenceVersion) {
          await storage.set({ [PAUSED]: true });
          throw new Error('Import preferences changed while connecting.');
        }
        pauseRequested = false;
        return { userId: active.userId };
      });
    }

    async function flush() {
      if (syncing) return syncing;
      syncing = serial(async () => {
        const { settings, records } = await load();
        if (pauseRequested || !settings.enabled) return { sent: 0 };
        const pending = records.filter((record) => record.status === 'local' && record.userId === settings.userId && !record.data.warnings.length);
        if (!pending.length || (settings.nextSyncAt || 0) > Date.now()) return { sent: 0 };
        // Ten sources per minute, across capture events, startup, and alarms.
        // Avoid hitting the receiver's rate limit when an archive is first connected.
        await storage.set({ [SETTINGS]: { ...settings, nextSyncAt: Date.now() + 60000 } });
        let active;
        try {
          active = await client.session();
          if (active.userId !== settings.userId) throw new Error('The signed-in account changed. Reconnect in settings.');
        } catch (error) {
          await storage.set({ [SETTINGS]: { ...settings, enabled: false, lastError: error.message } });
          throw error;
        }
        let sent = 0;
        for (const record of pending) {
          if (pauseRequested || sent >= 10) break;
          try {
            const result = await client.upload({ ...record, bytes: new TextEncoder().encode(JSON.stringify(record.data, null, 2)) }, record.userId);
            record.status = 'received';
            record.remoteId = result.remoteId;
            record.error = null;
            sent += 1;
          } catch (error) {
            // Receipt receiver deduplicates by owner+SHA, including when the
            // previous response was lost. Refusals pause this batch; no retry loop.
            record.error = error.message;
            await saveRecords(records);
            await storage.set({ [SETTINGS]: { ...settings, enabled: false, lastError: error.message } });
            throw error;
          }
          await saveRecords(records);
        }
        return { sent };
      }).finally(() => { syncing = null; });
      return syncing;
    }

    return {
      capture, configure, flush,
      snapshot: () => serial(load),
      clear: () => serial(() => saveRecords([])),
    };
  }

  FSD.importStore = { hash, createImportStore };
  root.FinancialStatementDownloader = FSD;
})(globalThis);
