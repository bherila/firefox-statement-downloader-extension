(function initializePopup(root) {
  'use strict';
  const query = (selector) => root.document.querySelector(selector);
  const merchant = root.FinancialStatementDownloader.amz.displayName;
  query('#title').textContent = `${merchant} receipts`;
  const missing = {
    unparsed_items: "Some items couldn't be read.", order_total_missing: "Grand total as printed wasn't found.",
    item_quantity_missing: "Some quantities couldn't be read.", item_price_missing: "Some item prices couldn't be read.",
    unparsed_activity_rows: "Some activity rows couldn't be read.",
  };
  let rendering = 0;
  async function refresh() {
    const version = ++rendering;
    const tabs = await root.browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) throw new Error('This tab is unavailable. Open settings to review saved receipts.');
    const result = await root.browser.runtime.sendMessage({ action: 'popupSnapshot', tabId: tabs[0].id });
    if (version !== rendering) return;
    if (!result?.ok) throw new Error(result?.error || 'Receipt status is unavailable. Open settings to review saved receipts.');
    if (result.private) {
      query('#current').textContent = "Private windows aren't collected.";
      query('#detail').textContent = '';
      query('#queue').textContent = '';
      query('#recent').replaceChildren();
      query('#unsaved').replaceChildren();
      for (const id of ['#queue-section', '#recent-section', '#history']) query(id).hidden = true;
      return;
    }
    for (const id of ['#queue-section', '#recent-section']) query(id).hidden = false;
    const current = result.current;
    query('#detail').textContent = '';
    query('#history').hidden = true;
    if (current?.state === 'storage_refused') {
      query('#current').textContent = `${current.orderId ? `Order ${current.orderId}: ` : ''}This order wasn't saved.`;
      query('#detail').textContent = current.reason === 'privacy'
        ? 'Receipt text may contain a redeemable code. Nothing was saved. This receipt cannot be collected safely.'
        : "Firefox couldn't store it. Export what's held here, then free room in Settings and reload this page.";
    } else if (current?.state === 'unreadable') {
      query('#current').textContent = current.orderId ? `Order ${current.orderId} couldn't be read.` : 'This page could not be read.';
      query('#detail').textContent = `Nothing was saved. It may still be loading, or ${merchant} may have changed this layout. Reload the page to try again.`;
    } else if (current?.state === 'saved' || current?.state === 'partial') {
      const name = current.kind === 'gift-card-snapshot' ? 'Gift-card activity' : `Order ${current.orderId}`;
      query('#current').textContent = `${name} · ${current.state === 'partial' ? 'Saved as partial' : 'Saved'}${current.alreadySaved ? current.status === 'received' ? ' · already on pfifi.com' : ' · already saved here' : ''}.`;
      if (current.state === 'partial') query('#detail').textContent = (current.warnings || []).map((warning) => missing[warning] || "Some source fields couldn't be read.").join(' ');
      if (current.status === 'refused') query('#detail').textContent += ' pfifi.com refused this source. Its reason is in Settings; other receipts keep sending.';
    } else if (current?.state === 'history') {
      query('#current').textContent = 'Open order details yourself to save their receipts.';
      if (Number.isSafeInteger(current.totalCount)) {
        query('#history').hidden = false;
        query('#history-count').textContent = `On this page: ${current.savedCount} of ${current.totalCount} orders saved`;
        query('#unsaved').replaceChildren();
        for (const id of current.unsavedOrderIds || []) {
          const row = root.document.createElement('li'); row.textContent = `${id} · not saved`; query('#unsaved').appendChild(row);
        }
      }
    } else query('#current').textContent = 'No receipt has been confirmed for this tab.';
    query('#queue').textContent = result.queueStatus?.text || 'Open settings to review the connection.';
    query('#recent').replaceChildren();
    for (const save of result.recent || []) {
      const row = root.document.createElement('li');
      const when = new Date(save.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      row.textContent = `${save.orderId || 'Gift-card activity'} · ${save.partial ? 'Saved as partial' : 'Saved'} · ${save.status === 'received' ? 'on pfifi.com' : save.status === 'refused' ? 'Refused' : 'here'} · ${when}`;
      query('#recent').appendChild(row);
    }
    if (!(result.recent || []).length) query('#recent').textContent = 'No receipts saved yet.';
  }
  const update = () => refresh().catch((error) => { query('#current').textContent = error.message; });
  query('#settings').addEventListener('click', () => { void root.browser.runtime.openOptionsPage(); });
  root.browser.storage?.onChanged?.addListener(() => { void update(); });
  if (root.setInterval) root.setInterval(update, 1000);
  void update();
})(globalThis);
