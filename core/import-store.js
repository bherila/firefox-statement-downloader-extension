(function initializeImportStore(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader || {};
  const SETTINGS = 'fsd:imports:settings';
  const PAUSED = 'fsd:imports:paused';
  const RECORDS = 'fsd:imports:records';
  const MAX_RECORDS = 2000;
  const MAX_SOURCE_BYTES = 512 * 1024;

  async function hash(bytes) {
    return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes)))
      .map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  function createImportStore(storage = root.browser.storage.local, client = FSD.importClient.createImportClient(), { now = Date.now, random = Math.random } = {}) {
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
      if (!receipt || receipt.schema !== FSD.amz.receiptSchema || receipt.marketplace !== FSD.amz.marketplace
        || receipt.currency !== 'USD' || !/^\d{3}-\d{7}-\d{7}$/.test(receipt.order_id || '')
        || !['standard', 'whole_foods', 'fresh'].includes(receipt.layout)
        || !Array.isArray(receipt.items) || !receipt.items.length || receipt.items.length > 500
        || !Array.isArray(receipt.charges) || !receipt.charges.length || receipt.charges.length > 100) {
        throw new Error('Invalid AMZ receipt.');
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
      if (FSD.providers.amz.helpers.pageKind(source.href) !== 'detail'
        || source.searchParams.get('orderID') !== receipt.order_id) throw new Error('Invalid receipt source.');
      const data = {
        schema: receipt.schema, marketplace: receipt.marketplace, currency: receipt.currency,
        order_id: receipt.order_id, layout: receipt.layout,
        source_url: `${FSD.amz.origin}${source.pathname}?orderID=${receipt.order_id}`,
        order_date_text: optionalText(receipt.order_date_text, 300), status_text: optionalText(receipt.status_text, 1000),
        delivery_date_text: optionalText(receipt.delivery_date_text, 300),
        items: receipt.items.map((item) => {
          const title = optionalText(item.title);
          if (!title) throw new Error('Missing receipt item title.');
          if (item.asin !== null && !/^[A-Z0-9]{10}$/.test(item.asin)) throw new Error('Invalid ASIN.');
          if (item.quantity !== null && (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 100000)) throw new Error('Invalid receipt quantity.');
          if (item.quantity_unit !== null && !['each', 'lb', 'oz'].includes(item.quantity_unit)) throw new Error('Invalid receipt quantity unit.');
          return { title, asin: item.asin, product_url: item.asin ? `${FSD.amz.origin}/dp/${item.asin}` : null,
            quantity: item.quantity, quantity_unit: item.quantity_unit,
            unit_price_cents: cents(item.unit_price_cents), line_total_cents: cents(item.line_total_cents),
            seller: optionalText(item.seller, 1000), condition: optionalText(item.condition, 1000) };
        }),
        charges: receipt.charges.map((charge) => ({ label: optionalText(charge.label, 300), amount_cents: cents(charge.amount_cents) })),
        total_cents: cents(receipt.total_cents),
        warnings: Array.isArray(receipt.warnings) ? receipt.warnings.map((warning) => optionalText(warning, 100)).slice(0, 50) : [],
      };
      return saveSource(data, 'receipt', 'amz');
    }

    async function captureGiftCardSnapshot(snapshot) {
      if (!snapshot || snapshot.schema !== FSD.amz.giftCardSchema || snapshot.marketplace !== FSD.amz.marketplace
        || snapshot.currency !== 'USD' || snapshot.source_url !== `${FSD.amz.origin}/gc/balance`
        || !Number.isSafeInteger(snapshot.balance_cents) || snapshot.balance_cents < 0
        || !Array.isArray(snapshot.activities) || snapshot.activities.length > 1000
        || typeof snapshot.has_previous_page !== 'boolean' || typeof snapshot.has_next_page !== 'boolean'
        || snapshot.coverage !== 'visible_page' || !Array.isArray(snapshot.warnings) || snapshot.warnings.length > 50) {
        throw new Error('Invalid AMZ gift-card snapshot.');
      }
      const data = {
        schema: snapshot.schema, marketplace: snapshot.marketplace, currency: snapshot.currency,
        source_url: snapshot.source_url, balance_cents: snapshot.balance_cents,
        activities: snapshot.activities.map((activity) => {
          if (typeof activity.date_text !== 'string' || !activity.date_text.trim() || activity.date_text.length > 300
            || !['redemption', 'load', 'refund', 'adjustment', 'unknown'].includes(activity.activity_type)
            || !Number.isSafeInteger(activity.amount_cents)
            || (activity.balance_after_cents !== null && (!Number.isSafeInteger(activity.balance_after_cents) || activity.balance_after_cents < 0))
            || !Array.isArray(activity.order_ids) || activity.order_ids.length > 100
            || activity.order_ids.some((orderId) => typeof orderId !== 'string' || !/^\d{3}-\d{7}-\d{7}$/.test(orderId))) {
            throw new Error('Invalid AMZ gift-card activity.');
          }
          // Load descriptions can contain redeemable claim codes. Store only
          // these typed cells and order references, never a raw description.
          return { date_text: activity.date_text, activity_type: activity.activity_type,
            amount_cents: activity.amount_cents, balance_after_cents: activity.balance_after_cents,
            order_ids: [...activity.order_ids] };
        }),
        has_previous_page: snapshot.has_previous_page, has_next_page: snapshot.has_next_page,
        coverage: snapshot.coverage,
        warnings: snapshot.warnings.map((warning) => {
          if (typeof warning !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(warning)) throw new Error('Invalid source warning.');
          return warning;
        }),
      };
      return saveSource(data, 'gift-card-snapshot', 'amz-gift-cards');
    }

    async function saveSource(data, kind, provider) {
      const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
      if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Source is too large to save.');
      const id = await hash(bytes);
      return serial(async () => {
        const { settings, records } = await load();
        // Same bytes are a no-op; later changes to an order become a new source
        // revision. The first observation time lives outside the hashed bytes.
        if (!records.some((record) => record.id === id)) {
          if (records.length >= MAX_RECORDS) throw new Error('Source storage is full. Export and clear sources in settings.');
          const prefix = kind === 'receipt' ? `amz-${data.order_id}` : 'amz-gift-card-balance';
          records.push({ id, kind, provider, data,
            filename: `${prefix}-${id.slice(0, 12)}.json`, contentType: 'application/json',
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
        const { settings: previous, records } = await load();
        if (version !== preferenceVersion) throw new Error('Import preferences changed while connecting.');
        for (const record of records) if (record.userId === null) record.userId = active.userId;
        const throttle = previous.userId === active.userId
          ? { nextSyncAt: previous.nextSyncAt, retryAt: previous.retryAt, retryAttempt: previous.retryAttempt } : {};
        await storage.set({ [SETTINGS]: { enabled: true, userId: active.userId, ...throttle }, [RECORDS]: records, [PAUSED]: false });
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
        if (!pending.length) return { sent: 0 };
        const dueAt = Math.max(settings.nextSyncAt || 0, settings.retryAt || 0);
        if (dueAt > now()) return { sent: 0, nextSyncAt: dueAt };
        const batch = pending.filter((record) => record.kind === pending[0].kind).slice(0, 20);
        try {
          const active = await client.session();
          if (active.userId !== settings.userId) throw new Error('The signed-in account changed. Reconnect in settings.');
          if (pauseRequested) return { sent: 0 };
          const results = await client.uploadBatch(batch.map((record) => ({ ...record,
            bytes: new TextEncoder().encode(JSON.stringify(record.data, null, 2)) })), settings.userId);
          for (const record of batch) {
            const result = results.find((item) => item.id === record.id);
            if (!result) throw new Error('Batch acknowledgement was incomplete.');
            record.status = 'received';
            record.remoteId = result.remoteId;
            record.error = null;
          }
          await saveRecords(records);
          const nextSyncAt = now() + 5000;
          await storage.set({ [SETTINGS]: { ...settings, retryAt: null, retryAttempt: 0, lastError: null, nextSyncAt } });
          return { sent: batch.length, ...(!pauseRequested && pending.length > batch.length ? { nextSyncAt } : {}) };
        } catch (error) {
          for (const record of batch) record.error = error.message;
          await saveRecords(records);
          if (error.status === 429) {
            const retryAttempt = settings.retryAttempt || 0;
            const retryAt = now() + FSD.importClient.retryDelay(error, retryAttempt, random);
            await storage.set({ [SETTINGS]: { ...settings, retryAt, retryAttempt: retryAttempt + 1, lastError: 'Rate limited; waiting to retry automatically.' } });
            return { sent: 0, ...(!pauseRequested ? { nextSyncAt: retryAt } : {}) };
          }
          await storage.set({ [SETTINGS]: { ...settings, enabled: false, lastError: error.message } });
          throw error;
        }
      }).finally(() => { syncing = null; });
      return syncing;
    }

    return {
      capture, captureGiftCardSnapshot, configure, flush,
      snapshot: () => serial(load),
      clear: () => serial(() => saveRecords([])),
    };
  }

  FSD.importStore = { hash, createImportStore };
  root.FinancialStatementDownloader = FSD;
})(globalThis);
