(function initializeOptions(root) {
  'use strict';
  /** @returns {any} */
  const query = (selector) => root.document.querySelector(selector);
  let fileUploadPending = false;
  async function message(action, extra = {}) {
    const result = await root.browser.runtime.sendMessage({ action, ...extra });
    if (!result || !result.ok) throw new Error(result?.error || 'Extension background is unavailable.');
    return result;
  }
  async function refresh() {
    const { settings, records } = await message('importSnapshot');
    query('#connection').textContent = settings.enabled ? `Connected to account ${settings.userId}. Automatic source imports enabled.${settings.retryAt > Date.now() ? ` Rate limited; retrying after ${new Date(settings.retryAt).toLocaleTimeString()}.` : ''}`
      : settings.lastError ? `Imports paused: ${settings.lastError}` : 'Imports paused. Sources stay in this browser.';
    const giftCards = records.filter((record) => record.kind === 'gift-card-snapshot').length;
    query('#counts').textContent = `${records.length - giftCards} receipt revisions · ${giftCards} gift-card pages · ${records.filter((record) => record.status === 'received').length} received by destination · ${records.filter((record) => record.data.warnings.length).length} need review locally`;
    query('#sync').disabled = !settings.enabled;
    query('#connect').disabled = settings.enabled;
    query('#upload').disabled = !settings.enabled || fileUploadPending;
    query('#disconnect').disabled = !settings.enabled;
    query('#receipts').replaceChildren();
    for (const record of [...records].reverse()) {
      const item = root.document.createElement('li');
      const description = record.kind === 'gift-card-snapshot'
        ? `Gift-card balance $${Math.floor(record.data.balance_cents / 100).toLocaleString('en-US')}.${String(record.data.balance_cents % 100).padStart(2, '0')} · ${record.data.activities.length} activity rows · visible page`
        : `${record.data.order_id} · ${record.data.items.length} items`;
      item.textContent = `${description} · ${record.status}${record.remoteId ? ` (document ${record.remoteId})` : ''}${record.userId && record.userId !== settings.userId ? ` · pinned to account ${record.userId}` : ''}${record.data.warnings.length ? ` · ${record.data.warnings.join(', ')}` : ''}${record.error ? ` · ${record.error}` : ''}`;
      query('#receipts').appendChild(item);
    }
  }
  async function run(fn) {
    query('#status').textContent = 'Working…';
    try { query('#status').textContent = await fn() || 'Done.'; }
    catch (error) { query('#status').textContent = error.message; }
    await refresh().catch((error) => { query('#status').textContent = error.message; });
  }
  query('#connect').addEventListener('click', () => {
    // Request immediately in the user gesture, before asynchronous session I/O.
    const permission = root.browser.permissions.request({ origins: ['https://pfifi.com/*'] });
    void run(async () => {
      if (!await permission) throw new Error('Destination access was not granted. Sources remain local.');
      await message('configureImports', { enabled: true });
      return 'Connected. Saved sources will sync automatically.';
    });
  });
  query('#disconnect').addEventListener('click', () => run(async () => { await message('configureImports', { enabled: false }); return 'Imports paused.'; }));
  query('#sync').addEventListener('click', () => run(async () => { const result = await message('syncImports'); return `${result.sent} sources sent.`; }));
  query('#export').addEventListener('click', () => run(async () => {
    const { records } = await message('importSnapshot');
    const data = new TextEncoder().encode(JSON.stringify({ schema: 'fsd.source-archive.v1',
      receipts: records.filter((record) => record.kind !== 'gift-card-snapshot').map(({ data }) => data),
      gift_card_snapshots: records.filter((record) => record.kind === 'gift-card-snapshot').map(({ data }) => data) }, null, 2));
    await message('downloadData', { data: Array.from(data), filename: 'Receipts/amazon-sources.json', contentType: 'application/json' });
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
  void refresh().catch((error) => { query('#status').textContent = error.message; });
  root.browser.runtime.onMessage?.addListener((event) => {
    if (event.event === 'importRateLimited') query('#status').textContent = `Rate limited; retrying automatically after ${new Date(event.retryAt).toLocaleTimeString()}. Pause imports to stop retrying.`;
  });
  root.browser.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((key) => key.startsWith('fsd:imports:'))) {
      void refresh().catch((error) => { query('#status').textContent = error.message; });
    }
  });
})(globalThis);
