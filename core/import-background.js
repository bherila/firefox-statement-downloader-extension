(function initializeImportBackground(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader;
  const store = FSD.importStore.createImportStore();
  const client = FSD.importClient.createImportClient();
  const OPTIONS_URL = root.browser.runtime.getURL('options.html');
  const isOptions = (sender) => sender.url === OPTIONS_URL && !sender.tab?.incognito;
  const isAmazon = (sender) => Boolean(sender.tab && !sender.tab.incognito && sender.frameId === 0
    && FSD.providers.amazon.helpers.pageKind(sender.url));
  const safely = (fn) => Promise.resolve().then(fn).then((result) => Object.assign({ ok: true }, result))
    .catch((error) => ({ ok: false, error: error.message || 'Import failed.' }));
  const sync = () => store.flush().catch(() => {});

  root.browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message.action !== 'string') return undefined;
    if (message.action === 'captureAmazonReceipt' && isAmazon(sender)) {
      return safely(async () => {
        const source = new URL(sender.url);
        if (FSD.providers.amazon.helpers.pageKind(sender.url) !== 'detail'
          || source.searchParams.get('orderID') !== message.receipt?.order_id) throw new Error('Receipt does not match the open order.');
        const result = await store.capture(message.receipt);
        // Independent of the content script lifetime, so leaving the page does
        // not cancel a saved receipt or leave an in-progress marker behind.
        void sync();
        return result;
      });
    }
    if (message.action === 'listAmazonReceipts' && isAmazon(sender)) {
      return safely(async () => ({ receipts: (await store.snapshot()).records.map(({ id, data }) => ({ id, data })) }));
    }
    if (message.action === 'openImportOptions' && isAmazon(sender)) {
      return safely(async () => { await root.browser.runtime.openOptionsPage(); });
    }
    if (!isOptions(sender)) return undefined;
    if (message.action === 'importSnapshot') return safely(() => store.snapshot());
    if (message.action === 'configureImports') return safely(async () => {
      if (typeof message.enabled !== 'boolean') throw new Error('Invalid import preference.');
      if (message.enabled && !await root.browser.permissions.contains({ origins: [`${FSD.importClient.ORIGIN}/*`] })) {
        throw new Error('Grant destination access before connecting.');
      }
      await store.configure(message.enabled);
      if (message.enabled) void sync();
    });
    if (message.action === 'syncImports') return safely(() => store.flush());
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
      // No automatic retry: the job endpoint only deduplicates completed jobs.
      // On a lost acknowledgement, users check Import Center before re-upload.
      return client.upload({ kind: 'file', id, bytes, filename: message.filename,
        contentType: message.contentType, jobType: message.jobType }, settings.userId);
    });
    return undefined;
  });

  root.browser.alarms.create('fsd-imports', { periodInMinutes: 1 });
  root.browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'fsd-imports') void sync(); });
  void sync();
})(globalThis);
