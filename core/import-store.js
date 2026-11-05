(function initializeImportStore(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader || {};
  const SETTINGS = 'fsd:imports:settings';
  const PAUSED = 'fsd:imports:paused';
  const RECORDS = 'fsd:imports:records';
  const STOPPED = 'fsd:imports:stopped';
  const RETENTION = 'fsd:imports:retention';
  const PARTIAL_WAIT_MS = 60000;
  const MAX_HELD_REVISIONS = 20;
  const REPLACED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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
    let activeBatch = [];
    const serial = (fn) => {
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    };
    async function load() {
      const saved = await storage.get([SETTINGS, RECORDS, PAUSED, STOPPED, RETENTION]);
      const settings = { enabled: false, userId: null, userName: null, keepCopy: false, ...saved[SETTINGS] };
      settings.everConnected = settings.everConnected === true || Boolean(settings.userId);
      if (typeof saved[RETENTION]?.keepCopy === 'boolean') settings.keepCopy = saved[RETENTION].keepCopy;
      const stopped = saved[STOPPED];
      return {
        settings: { ...settings, ...(saved[PAUSED] || stopped ? { enabled: false } : {}),
          ...(stopped ? { stopReason: stopped.reason, lastError: stopped.message, accountConflict: stopped.accountConflict || null } : {}) },
        // This projection is read-only. Serialized writers persist migration;
        // even a popup racing startup cannot export default-discarded contents.
        records: (saved[RECORDS] || []).map((record) => normalizeRecord(record, settings)),
      };
    }
    const saveRecords = (records) => storage.set({ [RECORDS]: records });
    const sourceKind = (record) => record.kind || 'receipt';
    const supportedSource = (record) => ['receipt', 'gift-card-snapshot'].includes(sourceKind(record));
    const held = (record) => supportedSource(record) && Boolean(record.data);
    function sourceSummary(record) {
      const data = record.data;
      const previous = record.summary || {};
      const rawWarnings = data?.warnings ?? previous.warnings ?? [];
      const warnings = Array.isArray(rawWarnings) ? rawWarnings : ['unrecognized_warning'];
      const orderId = data?.order_id || previous.orderId;
      const marketplace = data?.marketplace || previous.marketplace;
      const layout = data?.layout || previous.layout;
      const count = (value, limit) => Number.isSafeInteger(value) && value >= 0 && value <= limit ? value : 0;
      const summary = {
        orderId: sourceKind(record) === 'receipt' && typeof orderId === 'string' && /^\d{3}-\d{7}-\d{7}$/.test(orderId) ? orderId : null,
        marketplace: typeof marketplace === 'string' && /^[a-z0-9.-]{1,100}\.[a-z]{2,}$/.test(marketplace) ? marketplace : null,
        layout: sourceKind(record) === 'receipt' && ['standard', 'whole_foods', 'fresh'].includes(layout) ? layout : null,
        itemCount: sourceKind(record) === 'receipt' ? count(data?.items?.length ?? previous.itemCount, 500) : 0,
        warnings: warnings.slice(0, 50).map((warning) => typeof warning === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(warning) ? warning : 'unrecognized_warning'),
      };
      if (sourceKind(record) === 'gift-card-snapshot') Object.assign(summary, {
        activityCount: count(data?.activities?.length ?? previous.activityCount, 1000),
      });
      return summary;
    }
    function normalizeRecord(record, settings) {
      if (!supportedSource(record)) return record;
      const normalized = { ...record, summary: sourceSummary(record) };
      if (record.status === 'received') {
        normalized.sentAt = record.sentAt || settings.lastSentAt || record.createdAt;
        if (settings.keepCopy !== true) delete normalized.data;
      }
      return normalized;
    }
    function orderKey(record) {
      if (sourceKind(record) !== 'receipt' || !record.summary?.orderId || !record.summary.marketplace) return null;
      return JSON.stringify([record.summary.marketplace, record.summary.orderId, record.userId ?? null]);
    }
    function retainedRecords(records, settings, enforceKey = null) {
      const groups = new Map();
      const removed = new Set();
      for (const record of records) {
        const key = orderKey(record);
        if (key === null) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
      }
      for (const [key, group] of groups) {
        // Insertion order is the capture order, including same-clock captures.
        const heldGroup = group.filter(held);
        const newest = heldGroup[heldGroup.length - 1];
        const complete = [...group].reverse().find((record) => !record.summary.warnings.length);
        const protectedIds = new Set([newest?.id, complete?.id]);
        const mayDelete = (record) => record.status === 'received' || !settings.everConnected;
        for (let index = 0; index < group.length; index += 1) {
          const record = group[index];
          if (!held(record)) continue;
          const replacement = group.slice(index + 1).find((later) => record.summary.warnings.length || !later.summary.warnings.length);
          if (replacement && !record.replacedAt) record.replacedAt = replacement.createdAt;
          if (!protectedIds.has(record.id) && mayDelete(record) && record.replacedAt
            && now() - Date.parse(record.replacedAt) >= REPLACED_RETENTION_MS) removed.add(record.id);
        }
        let remaining = heldGroup.filter((record) => !removed.has(record.id));
        while (remaining.length > MAX_HELD_REVISIONS) {
          const oldest = remaining.find((record) => !protectedIds.has(record.id) && mayDelete(record));
          if (!oldest) {
            if (key === enforceKey) throw new Error('This order already has 20 unsent revisions. Send them or clear held sources in settings before saving another.');
            break; // Legacy overflow must not prevent sending protected evidence.
          }
          removed.add(oldest.id);
          remaining = remaining.filter((record) => record.id !== oldest.id);
        }
      }
      return records.filter((record) => !removed.has(record.id));
    }

    async function capture(receipt) {
      // Reconstruct an allowlisted payload; never retain DOM/headers/addresses
      // or arbitrary extra fields from a provider message.
      if (!receipt || receipt.schema !== FSD.amz.receiptSchema || receipt.marketplace !== FSD.amz.marketplace
        || receipt.currency !== 'USD' || !/^\d{3}-\d{7}-\d{7}$/.test(receipt.order_id || '')
        || !['standard', 'whole_foods', 'fresh'].includes(receipt.layout)
        || !Array.isArray(receipt.items) || !receipt.items.length || receipt.items.length > 500
        || !Array.isArray(receipt.charges) || !receipt.charges.length || receipt.charges.length > 100) {
        throw new Error(`Invalid ${FSD.amz.displayName} receipt.`);
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
        throw new Error(`Invalid ${FSD.amz.displayName} gift-card snapshot.`);
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
            throw new Error(`Invalid ${FSD.amz.displayName} gift-card activity.`);
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

    function identity(value) {
      return { userId: value.userId, userName: value.userName || String(value.userId) };
    }

    function eligibleAt(record) {
      if (!record.summary.warnings.length) return 0;
      return record.eligibleAt || Date.parse(record.createdAt) + PARTIAL_WAIT_MS;
    }

    function sameSource(partial, complete) {
      if (partial.kind !== complete.kind || partial.userId !== complete.userId
        || partial.data.marketplace !== complete.data.marketplace) return false;
      if (partial.kind === 'receipt') return partial.data.order_id === complete.data.order_id;
      // Every activity page has the same canonical URL. Require overlapping row
      // evidence as well so visiting another page cannot suppress this source.
      if (partial.data.source_url !== complete.data.source_url
        || partial.data.balance_cents !== complete.data.balance_cents
        || partial.data.has_previous_page !== complete.data.has_previous_page
        || partial.data.has_next_page !== complete.data.has_next_page
        || !partial.data.activities.length) return false;
      const remaining = complete.data.activities.map((row) => JSON.stringify(row));
      return partial.data.activities.every((row) => {
        const index = remaining.indexOf(JSON.stringify(row));
        if (index === -1) return false;
        remaining.splice(index, 1);
        return true;
      });
    }

    async function saveSource(data, kind, provider) {
      const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
      if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Source is too large to save.');
      const id = await hash(bytes);
      return serial(async () => {
        const { settings, records } = await load();
        let record = records.find((item) => item.id === id);
        const alreadySaved = Boolean(record);
        if (!record) {
          const prefix = kind === 'receipt' ? `amz-${data.order_id}` : 'amz-gift-card-balance';
          record = { id, kind, provider, data,
            filename: `${prefix}-${id.slice(0, 12)}.json`, contentType: 'application/json',
            createdAt: new Date(now()).toISOString(), userId: settings.userId, status: 'local',
            ...(data.warnings.length ? { eligibleAt: now() + PARTIAL_WAIT_MS } : {}) };
          record.summary = sourceSummary(record);
          records.push(record);
        }
        let changed = !alreadySaved;
        if (!data.warnings.length) {
          // A sent marker proves this hash is already safe remotely. Use the
          // incoming data only for comparison; never reattach it to that marker.
          const complete = { ...record, data };
          for (const partial of records) {
            if (partial.status === 'local' && partial.data && partial.summary.warnings.length && now() < eligibleAt(partial)
              && sameSource(partial, complete)) {
              partial.status = 'suppressed'; partial.suppressedBy = id; changed = true;
            }
          }
        }
        if (!changed) return { id, count: records.length, alreadySaved };
        // Validate capacity entirely in memory before committing any migration,
        // replacement timestamp, or suppression from this capture.
        const retained = retainedRecords(records, settings, alreadySaved ? null : orderKey(record));
        await storage.set({ [SETTINGS]: settings, [RECORDS]: retained });
        return { id, count: retained.length, alreadySaved };
      });
    }

    async function persistIfChanged(settings, records) {
      const raw = await storage.get([SETTINGS, RECORDS]);
      const changes = {};
      if (JSON.stringify(raw[SETTINGS]) !== JSON.stringify(settings)) changes[SETTINGS] = settings;
      if (JSON.stringify(raw[RECORDS] || []) !== JSON.stringify(records)) changes[RECORDS] = records;
      if (Object.keys(changes).length) await storage.set(changes);
    }

    async function cleanup() {
      return serial(async () => {
        const { settings, records } = await load();
        const retained = retainedRecords(records, settings);
        await persistIfChanged(settings, retained);
        return { removed: records.length - retained.length };
      });
    }

    async function setRetention(options) {
      if (typeof options?.keepCopy !== 'boolean') throw new Error('Choose whether to keep sent copies.');
      // Persist intent without waiting for the network writer. ACK processing
      // rechecks this key before deciding whether this batch keeps its copies.
      await storage.set({ [RETENTION]: { keepCopy: options.keepCopy } });
      return serial(async () => {
        const { settings, records } = await load();
        const retained = retainedRecords(records, settings);
        await persistIfChanged(settings, retained);
        return { keepCopy: settings.keepCopy };
      });
    }

    async function forgetSentHistory() {
      return serial(async () => {
        const { records } = await load();
        const retained = records.filter((record) => record.status !== 'received' || !supportedSource(record));
        await saveRecords(retained);
        return { forgotten: records.length - retained.length };
      });
    }

    async function stop(reason, details = {}) {
      preferenceVersion += 1;
      const { settings } = await load();
      if (settings.stopReason === 'access_revoked' && reason !== 'access_revoked') return { stopped: true, stopReason: 'access_revoked' };
      const accountConflict = details.activeIdentity ? { original: identity(settings), active: identity(details.activeIdentity) }
        : details.accountConflict || settings.accountConflict || null;
      // Independent of the batch's settings write: an in-flight completion or
      // failure can never undo a permission revocation or an account stop.
      await storage.set({ [STOPPED]: { reason, message: details.message || null, accountConflict } });
      return { stopped: true, stopReason: reason };
    }

    async function configure(enabled, options = {}) {
      const version = ++preferenceVersion;
      if (!enabled) {
        pauseRequested = true;
        await storage.set({ [PAUSED]: true });
        return { paused: true };
      }
      let active;
      try {
        active = identity(await client.session());
      } catch (error) {
        if (version === preferenceVersion && [401, 419, 403, 409].includes(error.status)) {
          await stop(stopReason(error), { message: error.message, activeIdentity: error.activeIdentity });
        }
        throw error;
      }
      return serial(async () => {
        if (version !== preferenceVersion) throw new Error('Import preferences changed while connecting.');
        const { settings: previous, records } = await load();
        if (version !== preferenceVersion) throw new Error('Import preferences changed while connecting.');
        if (previous.userId && previous.userId !== active.userId && !options.useNewAccount) {
          const accountConflict = { original: identity(previous), active };
          await storage.set({ [STOPPED]: { reason: 'account_changed', accountConflict } });
          return { requiresAccountChoice: true, accountConflict };
        }
        // Explicit account choice applies only to future/unpinned observations.
        // Existing evidence never changes its recipient.
        for (const record of records) if (record.userId === null) record.userId = active.userId;
        const throttle = previous.userId === active.userId
          ? { nextSyncAt: previous.nextSyncAt, retryAt: previous.retryAt, retryAttempt: previous.retryAttempt, retryKind: previous.retryKind } : {};
        await storage.set({ [SETTINGS]: { enabled: true, ...active, ...throttle,
          keepCopy: previous.keepCopy === true, everConnected: true,
          lastSentAt: previous.lastSentAt || null, stopReason: null, accountConflict: null, lastError: null },
          [RECORDS]: records, [PAUSED]: false, [STOPPED]: null });
        if (version !== preferenceVersion) {
          await storage.set({ [PAUSED]: true });
          throw new Error('Import preferences changed while connecting.');
        }
        pauseRequested = false;
        return active;
      });
    }

    function stopReason(error) {
      return [401, 419].includes(error.status) ? 'sign_in' : error.status === 409 ? 'account_changed' : 'permission';
    }

    function pendingRecords(records, userId) {
      return records.filter((record) => record.status === 'local' && record.userId === userId && record.data);
    }

    async function snapshot() {
      // A status read must remain available while a batch waits for the network.
      const state = await load();
      const { settings, records } = state;
      const pending = pendingRecords(records, settings.userId);
      const retryAt = settings.retryAt || null;
      const retryKind = settings.retryKind || (retryAt ? 'rate_limit' : null);
      let phase = !settings.userId ? 'not_connected' : !settings.enabled ? 'paused' : pending.length ? 'ready' : 'all_sent';
      if (settings.enabled && activeBatch.length) phase = 'sending';
      if (settings.enabled && retryAt && retryAt > now()) phase = retryKind === 'rate_limit' ? 'waiting' : 'retrying';
      if ((!settings.enabled || pauseRequested) && activeBatch.length) phase = 'pausing';
      if (settings.stopReason) phase = 'stopped';
      return { ...state, queue: {
        phase, stopReason: settings.stopReason || null, retryAt, retryKind,
        pendingCount: pending.length, batchCount: activeBatch.length,
        refusedCount: records.filter((record) => record.status === 'refused').length,
        heldCount: records.filter((record) => record.status === 'local' && record.userId !== settings.userId).length,
        remainingCount: pending.filter((record) => !activeBatch.includes(record.id)).length,
        lastSentAt: settings.lastSentAt || null, accountName: settings.userName || (settings.userId ? String(settings.userId) : null),
        accountConflict: settings.accountConflict || null,
      } };
    }

    async function flush() {
      if (syncing) return syncing;
      syncing = serial(async () => {
        const { settings, records } = await load();
        if (pauseRequested || !settings.enabled) return { sent: 0 };
        const pending = pendingRecords(records, settings.userId);
        if (!pending.length) return { sent: 0 };
        const dueAt = Math.max(settings.nextSyncAt || 0, settings.retryAt || 0);
        if (dueAt > now()) return { sent: 0, nextSyncAt: dueAt };
        const ready = pending.filter((record) => eligibleAt(record) <= now());
        if (!ready.length) return { sent: 0, nextSyncAt: Math.min(...pending.map(eligibleAt)) };
        const batch = ready.filter((record) => record.kind === ready[0].kind).slice(0, 20);
        activeBatch = batch.map((record) => record.id);
        try {
          const active = await client.session();
          if (active.userId !== settings.userId) throw FSD.importClient.accountMismatch(active);
          if (pauseRequested || !(await load()).settings.enabled) return { sent: 0 };
          const results = await client.uploadBatch(batch.map((record) => ({ ...record,
            bytes: new TextEncoder().encode(JSON.stringify(record.data, null, 2)) })), settings.userId);
          // Validate the entire acknowledgement before mutating any record.
          if (!Array.isArray(results) || results.length !== batch.length
            || new Set(results.map((result) => result.id)).size !== batch.length
            || batch.some((record) => !results.some((result) => result.id === record.id
              && Number.isSafeInteger(result.remoteId) && result.remoteId > 0))) {
            throw new Error('Batch acknowledgement was incomplete.');
          }
          settings.keepCopy = (await load()).settings.keepCopy;
          for (const record of batch) {
            const result = results.find((item) => item.id === record.id);
            record.status = 'received'; record.remoteId = result.remoteId; record.error = null;
            record.sentAt = new Date(now()).toISOString();
            if (settings.keepCopy !== true) delete record.data;
          }
          await saveRecords(retainedRecords(records, settings));
          const nextSyncAt = now() + 5000;
          await storage.set({ [SETTINGS]: { ...settings, retryAt: null, retryKind: null, retryAttempt: 0,
            lastError: null, nextSyncAt, lastSentAt: new Date(now()).toISOString() } });
          return { sent: batch.length, ...(!pauseRequested && pending.length > batch.length ? { nextSyncAt } : {}) };
        } catch (error) {
          for (const record of batch) record.error = error.message;
          let refused = 0;
          if (error.status === 422) {
            for (const [index, messages] of Object.entries(error.sourceErrors || {})) {
              const record = batch[Number(index)];
              if (!record || !Array.isArray(messages) || !messages.length) continue;
              record.status = 'refused'; record.error = messages.join(' ').slice(0, 2000); refused += 1;
            }
          }
          await saveRecords(records);
          if ([401, 419, 403, 409].includes(error.status)) {
            await stop(stopReason(error), { message: error.message, activeIdentity: error.activeIdentity });
            throw error;
          }
          if (refused) {
            const nextSyncAt = now() + 5000;
            await storage.set({ [SETTINGS]: { ...settings, nextSyncAt, retryAt: null, retryKind: null,
              retryAttempt: 0, lastError: null } });
            return { sent: 0, refused, ...(!pauseRequested && pending.length > refused ? { nextSyncAt } : {}) };
          }
          // Sources are hash-idempotent, so lost/partial acknowledgements are
          // safe to retry. Explicit document jobs use a separate retry policy.
          const retryAttempt = settings.retryAttempt || 0;
          const retryAt = now() + FSD.importClient.retryDelay(error, retryAttempt, random);
          const retryKind = error.status === 429 ? 'rate_limit' : 'transient';
          await storage.set({ [SETTINGS]: { ...settings, retryAt, retryKind,
            retryAttempt: retryAttempt + 1, lastError: error.message } });
          return { sent: 0, ...(!pauseRequested ? { nextSyncAt: retryAt } : {}) };
        } finally {
          activeBatch = [];
        }
      }).finally(() => { syncing = null; });
      return syncing;
    }

    return {
      capture, captureGiftCardSnapshot, configure, flush, stop, snapshot, setRetention, cleanup, forgetSentHistory,
      clear: () => serial(() => saveRecords([])),
    };
  }

  FSD.importStore = { hash, createImportStore };
  root.FinancialStatementDownloader = FSD;
})(globalThis);
