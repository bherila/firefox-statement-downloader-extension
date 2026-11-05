(function initializeOptions(root) {
  'use strict';
  /** @returns {any} */
  const query = (selector) => root.document.querySelector(selector);
  query('#merchant-name').textContent = root.FinancialStatementDownloader.amz.displayName;
  let fileUploadPending = false;
  let refreshing = 0;
  let latestSnapshot = null;
  function showAccounts(conflict) {
    query('#account-choice').hidden = !conflict;
    if (!conflict) return;
    const name = root.FinancialStatementDownloader.importStatus.accountName;
    query('#account-comparison').textContent = `Receipts are connected to ${name(conflict.original)}. pfifi.com is signed in as ${name(conflict.active)}. Nothing will send until you choose.`;
  }
  async function message(action, extra = {}) {
    const result = await root.browser.runtime.sendMessage({ action, ...extra });
    if (!result || !result.ok) throw new Error(result?.error || 'Extension background is unavailable.');
    return result;
  }
  async function refresh() {
    const version = ++refreshing;
    const [snapshot, preferences] = await Promise.all([message('importSnapshot'), message('capturePreferences')]);
    if (version !== refreshing) return;
    latestSnapshot = snapshot;
    query('#collect-gift-cards').checked = preferences.giftCardsEnabled === true;
    const { settings, records } = snapshot;
    const state = root.FinancialStatementDownloader.importStatus.describe(snapshot);
    query('#connection').textContent = state.text;
    query('#account').textContent = state.detail || `Destination: ${state.name}`;
    for (const [selector, visible] of [['#connect', state.connect], ['#resume', state.resume], ['#open-destination', state.open],
      ['#review-accounts', state.review], ['#allow-access', state.allow], ['#disconnect', state.pause]]) query(selector).hidden = !visible;
    query('#sync-wait').textContent = state.waitingUntil ? `Try again around ${state.waitingUntil}.` : '';
    showAccounts(settings.accountConflict);
    const giftCards = records.filter((record) => record.kind === 'gift-card-snapshot').length;
    query('#counts').textContent = `${records.length - giftCards} receipt revisions · ${giftCards} gift-card pages · ${records.filter((record) => record.status === 'received').length} received by destination · ${records.filter((record) => record.data.warnings.length).length} need review locally`;
    query('#sync').disabled = !state.sync;
    query('#upload').disabled = !settings.enabled || Boolean(settings.stopReason) || fileUploadPending;
    query('#disconnect').disabled = false;
    query('#receipts').replaceChildren();
    for (const record of [...records].reverse()) {
      const item = root.document.createElement('li');
      const description = record.kind === 'gift-card-snapshot'
        ? `Gift-card balance $${Math.floor(record.data.balance_cents / 100).toLocaleString('en-US')}.${String(record.data.balance_cents % 100).padStart(2, '0')} · ${record.data.activities.length} activity rows · visible page`
        : `${record.data.order_id} · ${record.data.items.length} items`;
      const status = record.status === 'refused' ? 'Refused' : record.status;
      item.textContent = `${description} · ${status}${record.remoteId ? ` (document ${record.remoteId})` : ''}${record.userId && record.userId !== settings.userId ? ` · pinned to account ${record.userId}` : ''}${record.data.warnings.length ? ` · Partial: ${record.data.warnings.join(', ')}` : ''}${record.error ? ` · ${record.error}` : ''}`;
      query('#receipts').appendChild(item);
    }
  }
  async function run(fn) {
    query('#status').textContent = 'Working…';
    try { query('#status').textContent = await fn() || 'Done.'; }
    catch (error) { query('#status').textContent = error.message; }
    await refresh().catch((error) => { query('#status').textContent = error.message; });
  }
  function connect(useNewAccount = false) {
    // Request immediately in the user gesture, before asynchronous session I/O.
    const permission = root.browser.permissions.request({ origins: ['https://pfifi.com/*'] });
    void run(async () => {
      if (!await permission) throw new Error('Destination access was not granted. Sources remain local.');
      const result = await message('configureImports', { enabled: true, useNewAccount });
      if (result.requiresAccountChoice) return 'Review accounts before sending. Existing receipts stay with their original account.';
      return 'Connected. Saved receipts will send automatically.';
    });
  }
  query('#connect').addEventListener('click', () => connect());
  query('#resume').addEventListener('click', () => connect());
  query('#allow-access').addEventListener('click', () => connect());
  query('#review-accounts').addEventListener('click', () => run(async () => {
    const result = await message('configureImports', { enabled: true });
    showAccounts(result.accountConflict || latestSnapshot?.settings.accountConflict);
    return result.requiresAccountChoice ? 'Review accounts before sending.' : 'Connected.';
  }));
  query('#use-new-account').addEventListener('click', () => connect(true));
  query('#collect-gift-cards').addEventListener('change', () => run(async () => {
    await message('configureCapturePreferences', { giftCardsEnabled: query('#collect-gift-cards').checked });
    return query('#collect-gift-cards').checked ? 'Balance-page capture is on for pages you visit.' : 'Balance-page capture is off.';
  }));
  query('#disconnect').addEventListener('click', () => run(async () => { await message('configureImports', { enabled: false }); return 'Imports paused.'; }));
  query('#sync').addEventListener('click', () => run(async () => {
    const result = await message('syncImports');
    if (result.sent) return `${result.sent} receipts sent.`;
    return 'Saved receipts are safe here. See the connection status for the next send.';
  }));
  query('#export').addEventListener('click', () => run(async () => {
    const { records } = await message('importSnapshot');
    const data = new TextEncoder().encode(JSON.stringify({ schema: 'fsd.source-archive.v1',
      receipts: records.filter((record) => record.kind !== 'gift-card-snapshot').map(({ data }) => data),
      gift_card_snapshots: records.filter((record) => record.kind === 'gift-card-snapshot').map(({ data }) => data) }, null, 2));
    await message('downloadData', { data: Array.from(data), filename: 'Receipts/amz-sources.json', contentType: 'application/json' });
    return 'Source archive downloaded.';
  }));
  query('#clear').addEventListener('click', () => {
    if (root.confirm('Clear all locally saved sources and upload history? Export an archive first. This does not delete destination documents.')) {
      void run(async () => { await message('clearImports'); return 'Local sources cleared.'; });
    }
  });
  query('#upload').addEventListener('click', async () => {
    if (fileUploadPending) return;
    fileUploadPending = true;
    query('#upload').disabled = true;
    try {
      await run(async () => {
        const file = query('#file').files[0];
        if (!file || file.size > 20 * 1024 * 1024) throw new Error('Choose a file no larger than 20 MiB.');
        const extension = file.name.split('.').pop().toLowerCase();
        const types = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', txt: 'text/plain' };
        if (!types[extension]) throw new Error('Choose a PDF, PNG, JPEG, CSV, or text file.');
        const result = await message('uploadImportFile', { data: Array.from(new Uint8Array(await file.arrayBuffer())),
          filename: file.name, contentType: types[extension], jobType: query('#job-type').value });
        query('#file').value = '';
        return `Upload received as job ${result.remoteId}. Review it in Import Center.`;
      });
    } finally {
      fileUploadPending = false;
      await refresh().catch((error) => { query('#status').textContent = error.message; });
    }
  });
  const update = () => refresh().catch((error) => { query('#status').textContent = error.message; });
  void update();
  if (root.setInterval) root.setInterval(update, 1000);
  root.browser.runtime.onMessage?.addListener((event) => {
    if (event.event === 'importRateLimited') query('#status').textContent = `Rate limited; retrying automatically after ${new Date(event.retryAt).toLocaleTimeString()}. Pause imports to stop retrying.`;
  });
  root.browser.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((key) => key.startsWith('fsd:imports:'))) {
      void refresh().catch((error) => { query('#status').textContent = error.message; });
    }
  });
})(globalThis);
