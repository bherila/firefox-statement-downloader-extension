(function initializeOptions(root) {
  'use strict';
  /** @returns {any} */
  const query = (selector) => root.document.querySelector(selector);
  query('#merchant-name').textContent = root.FinancialStatementDownloader.amz.displayName;
  let fileUploadPending = false;
  let refreshing = 0;
  let selectedFilter = 'all';
  let pageNumber = 1;
  let listSignature = null;
  const expandedGroups = new Set();
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
    const { settings } = snapshot;
    const state = root.FinancialStatementDownloader.importStatus.describe(snapshot);
    query('#connection').textContent = state.text;
    query('#account').textContent = state.detail || `Destination: ${state.name}`;
    for (const [selector, visible] of [['#connect', state.connect], ['#resume', state.resume], ['#open-destination', state.open],
      ['#review-accounts', state.review], ['#allow-access', state.allow], ['#disconnect', state.pause]]) query(selector).hidden = !visible;
    query('#sync-wait').textContent = state.waitingUntil ? `Try again around ${state.waitingUntil}.` : '';
    showAccounts(settings.accountConflict);
    query('#keep-copy').checked = settings.keepCopy === true;
    query('#sync').disabled = !state.sync;
    query('#upload').disabled = !settings.enabled || Boolean(settings.stopReason) || fileUploadPending;
    query('#disconnect').disabled = false;
    renderRows();
  }
  function renderRows() {
    if (!latestSnapshot) return;
    const { records, settings } = latestSnapshot;
    const list = root.FinancialStatementDownloader.importList;
    const groups = list.grouped(records, settings.userId);
    const result = list.select(groups, selectedFilter, query('#search').value || '', pageNumber);
    pageNumber = result.page;
    query('#counts').textContent = `${result.total} orders or activity sources · ${records.filter((record) => record.data).length} revisions held here · ${records.filter((record) => record.status === 'received').length} sent records`;
    const labels = { attention: 'Needs attention', waiting: 'Waiting', sent: 'Sent', other: 'Other account', all: 'All' };
    for (const button of root.document.querySelectorAll('[data-filter]')) {
      button.textContent = `${labels[button.getAttribute('data-filter')]} (${result.counts[button.getAttribute('data-filter')]})`;
      button.setAttribute('aria-selected', String(button.getAttribute('data-filter') === selectedFilter));
    }
    query('#page').textContent = ` Page ${result.page} of ${result.pages} `;
    query('#previous').disabled = result.page === 1;
    query('#next').disabled = result.page === result.pages;
    const signature = JSON.stringify([groups.length === 0, ...result.rows.map((group) => ({ key: group.key, merchant: group.merchant,
      attention: group.attention, waiting: group.waiting, sent: group.sent, other: group.other,
      records: group.records.map((record) => ({ id: record.id, status: record.status, held: Boolean(record.data),
        summary: list.summary(record), error: record.error, createdAt: record.createdAt })) }))]);
    if (signature === listSignature) return;
    listSignature = signature;
    for (const item of root.document.querySelectorAll('#receipts > li[data-group-key]')) {
      const key = item.getAttribute('data-group-key');
      if (item.querySelector('details')?.hasAttribute('open')) expandedGroups.add(key);
      else expandedGroups.delete(key);
    }
    query('#receipts').replaceChildren();
    for (const group of result.rows) {
      const item = root.document.createElement('li');
      item.setAttribute('data-group-key', group.key);
      const title = root.document.createElement('strong');
      title.textContent = `${group.merchant} · ${group.orderId || 'Gift-card activity pages'}`;
      const detail = root.document.createElement('p');
      const status = group.other ? `Other account ${group.userId}` : group.attention ? 'Needs attention' : group.waiting ? 'Waiting' : group.sent ? 'Sent' : 'Held here';
      detail.textContent = `${status} · ${group.records.length} revisions · ${group.held} held here${group.kind === 'receipt' ? ` · ${group.summary.itemCount ?? 'Not read'} items` : ''}`;
      item.append(title, detail);
      const held = group.records.filter((record) => record.data || record.status === 'refused');
      if (held.length) {
        const details = root.document.createElement('details');
        if (expandedGroups.has(group.key)) details.setAttribute('open', '');
        const caption = root.document.createElement('summary'); caption.textContent = 'Held revisions and reasons';
        const revisions = root.document.createElement('ul');
        for (const record of held) {
          const row = root.document.createElement('li'); const info = list.summary(record);
          row.textContent = `${new Date(record.createdAt).toLocaleString()} · ${record.status === 'refused' ? 'Refused' : record.status}${info.warnings?.length ? ` · Partial: ${info.warnings.join(', ')}` : ''}${record.error ? ` · ${record.error}` : ''}`;
          revisions.appendChild(row);
        }
        details.append(caption, revisions); item.appendChild(details);
      }
      query('#receipts').appendChild(item);
    }
    if (!result.rows.length) query('#receipts').textContent = groups.length ? 'No receipts match these filters.' : 'Receipts you capture appear here. Their contents stay local until you connect.';
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
  query('#keep-copy').addEventListener('change', () => run(async () => {
    await message('configureRetention', { keepCopy: query('#keep-copy').checked });
    return query('#keep-copy').checked ? 'Future confirmed copies will stay here until their retention deadline.' : 'Confirmed contents are removed here; small sent records stay.';
  }));
  query('#forget-sent').addEventListener('click', () => {
    if (root.confirm('Forget sent records and any copies kept here? Export first if you need them. Reopening an order saves it again; pfifi.com still prevents duplicates.')) void run(async () => {
      await message('forgetSentImports'); return 'Sent history forgotten. Unsent sources are safe here.';
    });
  });
  for (const button of root.document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { selectedFilter = button.getAttribute('data-filter'); pageNumber = 1; renderRows(); });
  query('#search').addEventListener('input', () => { pageNumber = 1; renderRows(); });
  query('#previous').addEventListener('click', () => { pageNumber -= 1; renderRows(); });
  query('#next').addEventListener('click', () => { pageNumber += 1; renderRows(); });
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
      receipts: records.filter((record) => record.kind !== 'gift-card-snapshot' && record.data).map(({ data }) => data),
      gift_card_snapshots: records.filter((record) => record.kind === 'gift-card-snapshot' && record.data).map(({ data }) => data) }, null, 2));
    await message('downloadData', { data: Array.from(data), filename: 'Receipts/amz-sources.json', contentType: 'application/json' });
    return 'Source archive downloaded.';
  }));
  query('#clear').addEventListener('click', () => {
    if (root.confirm('Clear everything held here and all sent history? Export first. This does not delete anything on pfifi.com.')) {
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
