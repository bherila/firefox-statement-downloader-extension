(function initializeCaptureBackground(root) {
  'use strict';
  const FSD = root.FinancialStatementDownloader || {};
  const PREFERENCES = 'fsd:capture:preferences';
  const ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;

  function create(store) {
    const browser = root.browser;
    const tabStates = new Map();
    const popupUrl = browser.runtime?.getURL('popup.html');
    const optionsUrl = browser.runtime?.getURL('options.html');
    let preferencesPromise = null;
    let preferenceTail = Promise.resolve();
    let writingPreferences = false;
    let storageRefused = false;
    let refreshing = null;
    let refreshAgain = false;

    function location(value) {
      try {
        const url = new URL(value);
        if (url.origin !== FSD.amz.origin) return null;
        const receipt = FSD.providers.amz.helpers.pageKind(value);
        const kind = receipt || (['/gc/balance', '/gp/css/gc/balance'].includes(url.pathname) ? 'balance' : null);
        if (!kind) return null;
        const orderId = url.searchParams.get('orderID');
        const validOrder = ORDER_ID.test(orderId || '') ? orderId : null;
        return { kind, orderId: validOrder,
          key: kind === 'detail' && validOrder ? `${url.origin}${url.pathname}?orderID=${validOrder}` : `${url.origin}${url.pathname}${url.search}` };
      } catch (error) { return null; }
    }

    function sourceSender(sender) {
      return sender?.tab && Number.isInteger(sender.tab.id) && sender.tab.id >= 0 && sender.frameId === 0
        ? location(sender.url) : null;
    }

    function readPreferences() {
      if (!preferencesPromise) {
        preferencesPromise = (async () => {
          const saved = browser.storage?.local ? await browser.storage.local.get([PREFERENCES]) : {};
          const value = saved[PREFERENCES] || {};
          return { giftCardsEnabled: value.giftCardsEnabled === true,
            generation: Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : 0 };
        })().catch((error) => { preferencesPromise = null; throw error; });
      }
      return preferencesPromise;
    }

    async function policy(sender) {
      const page = sourceSender(sender);
      if (!page) return undefined;
      const preferences = await readPreferences();
      return { ok: true, enabled: !sender.tab.incognito && (page.kind !== 'balance' || preferences.giftCardsEnabled), generation: preferences.generation };
    }

    const summary = (record) => record.summary || {
      orderId: record.data?.order_id || null, warnings: record.data?.warnings || [],
    };
    const partial = (record) => (summary(record).warnings || []).length > 0;
    const recentEntry = (record) => ({ id: record.id, orderId: summary(record).orderId || null,
      kind: record.kind || 'receipt', partial: partial(record), status: record.status, createdAt: record.createdAt });
    function savedState(record, alreadySaved) {
      return { state: partial(record) ? 'partial' : 'saved', id: record.id, kind: record.kind || 'receipt',
        orderId: summary(record).orderId || null, warnings: [...(summary(record).warnings || [])],
        status: record.status, alreadySaved, createdAt: record.createdAt };
    }

    async function sameOpenPage(sender, page) {
      if (!browser.tabs?.get) return !sender.tab.incognito;
      try {
        const tab = await browser.tabs.get(sender.tab.id);
        return !tab.incognito && location(tab.url)?.key === page.key;
      } catch (error) { return false; }
    }

    function currentState(tab, records) {
      const page = location(tab.url);
      const saved = tabStates.get(tab.id);
      if (saved && saved.key !== page?.key) tabStates.delete(tab.id);
      const entry = tabStates.get(tab.id);
      if (entry?.current.state === 'history') {
        const current = { state: 'history', kind: 'receipt' };
        if (entry.orderIds) {
          const known = new Set(records.filter((record) => (record.kind || 'receipt') === 'receipt').map((record) => summary(record).orderId));
          Object.assign(current, { savedCount: entry.orderIds.filter((id) => known.has(id)).length,
            totalCount: entry.orderIds.length, unsavedOrderIds: entry.orderIds.filter((id) => !known.has(id)) });
        }
        return current;
      }
      if (entry?.current.id) {
        const record = records.find((item) => item.id === entry.current.id);
        return record ? savedState(record, entry.current.alreadySaved) : null;
      }
      if (entry) return entry.current;
      // A prior background acknowledgement survives restart in source metadata.
      if (page?.kind === 'detail' && page.orderId) {
        const record = [...records].reverse().find((item) => (item.kind || 'receipt') === 'receipt' && summary(item).orderId === page.orderId);
        if (record) return savedState(record, true);
      }
      return null;
    }

    async function saved(sender, result, source, kind = 'receipt') {
      const page = sourceSender(sender);
      if (!page || sender.tab.incognito || !result?.id || result.error) return;
      if (kind === 'receipt' ? page.kind !== 'detail' || page.orderId !== source?.order_id
        : kind !== 'gift-card-snapshot' || page.kind !== 'balance') return;
      const capturePolicy = await policy(sender);
      if (!capturePolicy?.enabled || !await sameOpenPage(sender, page)) return;
      const { records } = await store.snapshot();
      const record = records.find((item) => item.id === result.id && (item.kind || 'receipt') === kind);
      if (!record) return;
      tabStates.set(sender.tab.id, { key: page.key, current: savedState(record, result.alreadySaved === true) });
      for (const entry of tabStates.values()) {
        if (entry.current.state === 'storage_refused' && entry.current.kind === kind
          && (kind === 'receipt' ? entry.current.orderId === source.order_id : entry.key === page.key)) {
          entry.current = savedState(record, true);
        }
      }
      if (!result.alreadySaved) storageRefused = false;
      await refresh();
    }

    async function failed(sender, orderId, error) {
      const page = sourceSender(sender);
      if (!page || sender.tab.incognito || page.kind === 'history' || !await sameOpenPage(sender, page)) return;
      if (page.kind === 'detail' && (orderId !== page.orderId || !ORDER_ID.test(orderId || ''))) return;
      if (!(await policy(sender))?.enabled) return;
      storageRefused = true;
      tabStates.set(sender.tab.id, { key: page.key, current: { state: 'storage_refused', kind: page.kind === 'balance' ? 'gift-card-snapshot' : 'receipt',
        orderId: page.orderId, reason: error?.name === 'QuotaExceededError' ? 'quota' : 'storage' } });
      await refresh();
    }

    async function tabs() {
      if (browser.tabs?.query) {
        try { return await browser.tabs.query({}); } catch (error) { return []; }
      }
      return [];
    }

    async function refreshBadges() {
      if (!browser.browserAction?.setBadgeText) return;
      const open = await tabs();
      const regular = open.filter((tab) => !tab.incognito);
      const state = regular.length ? await store.snapshot() : null;
      const pending = state?.records.filter((record) => record.status === 'local').length || 0;
      const attention = storageRefused || [...tabStates.values()].some((entry) => entry.current.state === 'storage_refused')
        || state?.settings.stopReason || state?.records.some((record) => record.status === 'refused');
      for (const tab of open) {
        if (!Number.isInteger(tab.id)) continue;
        let text = '';
        if (!tab.incognito && state) {
          const current = currentState(tab, state.records);
          text = attention ? '!' : current?.state === 'storage_refused' ? '!'
            : current?.state === 'saved' ? '✓' : current?.state === 'partial' ? '~'
              : current?.state === 'unreadable' ? '?' : pending ? String(pending)
                : state.settings.userId && !state.settings.enabled ? 'II' : '';
        }
        try { await browser.browserAction.setBadgeText({ tabId: tab.id, text }); } catch (error) { /* A tab can close during refresh. */ }
      }
    }

    function refresh() {
      if (refreshing) { refreshAgain = true; return refreshing; }
      refreshing = (async () => {
        do { refreshAgain = false; await refreshBadges(); } while (refreshAgain);
      })().finally(() => { refreshing = null; });
      return refreshing;
    }

    async function notifyPreferences() {
      const preferences = await readPreferences();
      for (const tab of await tabs()) {
        if (tab.incognito || !location(tab.url) || !browser.tabs?.sendMessage) continue;
        try { await browser.tabs.sendMessage(tab.id, { event: 'capturePreferencesChanged', generation: preferences.generation }); }
        catch (error) { /* Tabs without an active content script need no injection. */ }
      }
    }

    async function configurePreferences(enabled) {
      const previous = await readPreferences();
      if (previous.giftCardsEnabled === enabled) return { ok: true, ...previous };
      const preferences = { giftCardsEnabled: enabled, generation: previous.generation + 1 };
      if (!browser.storage?.local) throw new Error('Capture preferences could not be saved.');
      writingPreferences = true;
      try { await browser.storage.local.set({ [PREFERENCES]: preferences }); }
      finally { writingPreferences = false; }
      preferencesPromise = Promise.resolve(preferences);
      await notifyPreferences();
      await refresh();
      return { ok: true, ...preferences };
    }

    async function popupSnapshot(tabId, sender) {
      if (!Number.isInteger(tabId) || tabId < 0 || !browser.tabs?.get) throw new Error('Choose an available tab.');
      const tab = await browser.tabs.get(tabId);
      if (tab.incognito || sender.tab?.incognito) return { ok: true, private: true };
      const state = await store.snapshot();
      const preferences = await readPreferences();
      const described = FSD.importStatus?.describe(state) || { phase: state.queue?.phase || 'Idle' };
      const { phase, text, detail, pending, held, waitingUntil } = described;
      return { ok: true, private: false, current: currentState(tab, state.records),
        recent: [...state.records].reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20).map(recentEntry),
        queueStatus: { phase, text, detail, pending, held, waitingUntil },
        pendingCount: state.records.filter((record) => record.status === 'local').length,
        giftCardsEnabled: preferences.giftCardsEnabled };
    }

    const safely = (fn) => Promise.resolve().then(fn).catch(() => ({ ok: false, error: 'Capture status is unavailable. Open settings to review.' }));
    browser.runtime?.onMessage?.addListener((message, sender) => {
      if (!message || typeof message.action !== 'string') return undefined;
      if (message.action === 'amzCapturePolicy' && sourceSender(sender)) return safely(() => policy(sender));
      if (message.action === 'amzPageStatus' && sourceSender(sender)) return safely(async () => {
        const page = sourceSender(sender);
        if (!(await policy(sender))?.enabled || !await sameOpenPage(sender, page)) return { ok: true };
        if (message.state === 'history' && page.kind === 'history') {
          const orderIds = Array.isArray(message.orderIds) && message.orderIds.length > 0 && message.orderIds.length <= 1000
            && message.orderIds.every((id) => typeof id === 'string' && ORDER_ID.test(id))
            && new Set(message.orderIds).size === message.orderIds.length ? [...message.orderIds] : undefined;
          tabStates.set(sender.tab.id, { key: page.key, current: { state: 'history', kind: 'receipt' }, orderIds });
        } else if (message.state === 'unreadable' && ['detail', 'balance'].includes(page.kind)) {
          tabStates.set(sender.tab.id, { key: page.key, current: { state: 'unreadable',
            kind: page.kind === 'balance' ? 'gift-card-snapshot' : 'receipt', orderId: page.orderId } });
        } else return { ok: false, error: 'Unsupported page status.' };
        await refresh(); return { ok: true };
      });
      if (message.action === 'popupSnapshot' && popupUrl && sender.url === popupUrl) return safely(() => popupSnapshot(message.tabId, sender));
      if (!optionsUrl || sender.url !== optionsUrl || sender.tab?.incognito) return undefined;
      if (message.action === 'capturePreferences') return safely(async () => ({ ok: true, ...await readPreferences() }));
      if (message.action === 'configureCapturePreferences') {
        if (typeof message.giftCardsEnabled !== 'boolean') return Promise.resolve({ ok: false, error: 'Choose whether to collect gift-card pages.' });
        const result = preferenceTail.then(() => configurePreferences(message.giftCardsEnabled));
        preferenceTail = result.catch(() => {});
        return safely(() => result);
      }
      return undefined;
    });
    browser.tabs?.onCreated?.addListener(() => { void refresh().catch(() => {}); });
    browser.tabs?.onUpdated?.addListener((tabId, changes) => {
      if (changes.url || changes.status === 'loading') tabStates.delete(tabId);
      void refresh().catch(() => {});
    });
    browser.tabs?.onRemoved?.addListener((tabId) => { tabStates.delete(tabId); void refresh().catch(() => {}); });
    browser.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[PREFERENCES] && !writingPreferences) {
        preferencesPromise = null;
        void notifyPreferences().catch(() => {});
      }
      void refresh().catch(() => {});
    });
    void refresh().catch(() => {});
    return { saved, failed, refresh, policy };
  }

  FSD.captureBackground = { create };
  root.FinancialStatementDownloader = FSD;
})(globalThis);
