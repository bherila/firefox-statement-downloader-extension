(function initializeImportBackground(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader;
  const store = FSD.importStore.createImportStore();
  const client = FSD.importClient.createImportClient();
  const surface = FSD.captureBackground?.create(store);
  const OPTIONS_URL = root.browser.runtime.getURL('options.html');
  const isOptions = (sender) => sender.url === OPTIONS_URL && !sender.tab?.incognito;
  const isAmz = (sender) => Boolean(sender.tab && !sender.tab.incognito && sender.frameId === 0
    && (FSD.providers.amz.helpers.pageKind(sender.url) || isGiftCardPage(sender.url)));
  function isGiftCardPage(value) {
    try {
      const url = new URL(value);
      return url.origin === FSD.amz.origin && ['/gp/css/gc/balance', '/gc/balance'].includes(url.pathname);
    } catch (error) {
      return false;
    }
  }
  const safely = (fn) => Promise.resolve().then(fn).then((result) => Object.assign({ ok: true }, result))
    .catch((error) => ({ ok: false, error: error.message || 'Import failed.' }));
  let syncTimer = null;
  async function flushAndSchedule() {
    if (!await root.browser.permissions.contains({ origins: [`${FSD.importClient.ORIGIN}/*`] })) {
      const { settings } = await store.snapshot();
      if (settings.userId) await store.stop('access_revoked');
      return { sent: 0 };
    }
    const result = await store.flush();
    if (syncTimer !== null) root.clearTimeout(syncTimer);
    syncTimer = null;
    if (result.nextSyncAt) {
      // Durable due times survive restart; this timer drains a backlog between
      // alarm ticks without making any request before Retry-After has elapsed.
      syncTimer = root.setTimeout(() => { syncTimer = null; void sync(); },
        Math.min(60000, Math.max(1000, result.nextSyncAt - Date.now())));
    }
    return result;
  }
  const sync = () => flushAndSchedule().catch(() => {});

  root.browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message.action !== 'string') return undefined;
    if (message.action === 'captureAmzReceipt' && isAmz(sender)) {
      return safely(async () => {
        const source = new URL(sender.url);
        if (FSD.providers.amz.helpers.pageKind(sender.url) !== 'detail'
          || source.searchParams.get('orderID') !== message.receipt?.order_id) throw new Error('Receipt does not match the open order.');
        let result;
        try {
          result = await store.capture(message.receipt);
        } catch (error) {
          await surface?.failed(sender, message.receipt.order_id, error).catch(() => {});
          throw error;
        }
        await surface?.saved(sender, result, message.receipt, 'receipt').catch(() => {});
        // Independent of the content script lifetime, so leaving the page does
        // not cancel a saved receipt or leave an in-progress marker behind.
        void sync();
        return result;
      });
    }
    if (message.action === 'listAmzReceipts' && isAmz(sender)) {
      return safely(async () => ({ receipts: (await store.snapshot()).records.filter((record) => record.kind === 'receipt').map(({ id, data }) => ({ id, data })) }));
    }
    if (message.action === 'captureAmzGiftCardSnapshot' && isAmz(sender) && isGiftCardPage(sender.url)) {
      return safely(async () => {
        if (surface && !(await surface.policy(sender)).enabled) throw new Error('Balance-page capture is off. Enable it in settings.');
        let result;
        try {
          result = await store.captureGiftCardSnapshot(message.snapshot);
        } catch (error) {
          await surface?.failed(sender, null, error).catch(() => {});
          throw error;
        }
        await surface?.saved(sender, result, message.snapshot, 'gift-card-snapshot').catch(() => {});
        void sync();
        return result;
      });
    }
    if (message.action === 'listAmzGiftCardSnapshots' && isAmz(sender) && isGiftCardPage(sender.url)) {
      return safely(async () => ({ snapshots: (await store.snapshot()).records.filter((record) => record.kind === 'gift-card-snapshot').map(({ id, data }) => ({ id, data })) }));
    }
    if (message.action === 'openImportOptions' && isAmz(sender)) {
      return safely(async () => { await root.browser.runtime.openOptionsPage(); });
    }
    if (!isOptions(sender)) return undefined;
    if (message.action === 'importSnapshot') return safely(() => store.snapshot());
    if (message.action === 'configureImports') return safely(async () => {
      if (typeof message.enabled !== 'boolean') throw new Error('Invalid import preference.');
      if (message.enabled && !await root.browser.permissions.contains({ origins: [`${FSD.importClient.ORIGIN}/*`] })) {
        throw new Error('Grant destination access before connecting.');
      }
      const result = await store.configure(message.enabled, { useNewAccount: message.useNewAccount === true });
      if (message.enabled && !result?.requiresAccountChoice) void sync();
      return result;
    });
    if (message.action === 'syncImports') return safely(flushAndSchedule);
    if (message.action === 'clearImports') return safely(() => store.clear());
    if (message.action === 'uploadImportFile') return safely(async () => {
      const { settings } = await store.snapshot();
      if (!settings.enabled || !settings.userId) throw new Error('Connect your import destination first.');
      if (!Array.isArray(message.data) || message.data.length === 0 || message.data.length > 20 * 1024 * 1024
        || message.data.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
        || typeof message.filename !== 'string' || !/^[^/\\\x00-\x1f]{1,200}$/.test(message.filename)
        || !FSD.importClient.JOB_TYPES.includes(message.jobType)
        || !['application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'text/plain'].includes(message.contentType)) {
        throw new Error('Choose a supported document no larger than 20 MiB.');
      }
      const bytes = new Uint8Array(message.data);
      const id = await FSD.importStore.hash(bytes);
      // Only 429 retries automatically. An uncertain network acknowledgement
      // still needs review because the job endpoint can duplicate pending jobs.
      return FSD.importClient.withRateLimitRetry(() => client.upload({ kind: 'file', id, bytes,
        filename: message.filename, contentType: message.contentType, jobType: message.jobType }, settings.userId), {
        async check() {
          const state = await store.snapshot();
          return state.settings.enabled && state.settings.userId === settings.userId;
        },
        onRetry(milliseconds) {
          void root.browser.runtime.sendMessage({ event: 'importRateLimited', retryAt: Date.now() + milliseconds }).catch(() => {});
        },
      });
    });
    return undefined;
  });

  root.browser.alarms.create('fsd-imports', { periodInMinutes: 1 });
  root.browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'fsd-imports') void sync(); });
  root.browser.permissions.onRemoved?.addListener((removed) => {
    if (removed.origins?.includes(`${FSD.importClient.ORIGIN}/*`)) {
      if (syncTimer !== null) root.clearTimeout(syncTimer);
      syncTimer = null;
      void store.stop('access_revoked');
    }
  });
  void sync();
})(globalThis);
