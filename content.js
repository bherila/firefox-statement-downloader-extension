(function initializeContentScript(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader;
  if (!FSD) {
    throw new Error('Financial Statement Downloader core did not load');
  }

  // Single-page apps hydrate after document_idle and replace whole subtrees as
  // they do. Mounting into that churn gets the launcher discarded immediately,
  // so the first attempt waits for the page to settle.
  const INITIAL_DELAY_MS = 1200;
  // Deliberately not a resetting debounce: these pages carry advertising and
  // analytics iframes that mutate continuously, so waiting for true quiescence
  // could mean never mounting at all. This guarantees a steady retry instead.
  const RECONCILE_DELAY_MS = 500;

  let activeProvider = null;
  let activeApp = null;
  let scheduled = false;

  function reconcile() {
    scheduled = false;
    const providers = Object.values(FSD.providers || {});
    // A provider that is malformed or throws while sniffing the page must not
    // prevent the others from mounting.
    const provider = providers.find((candidate) => {
      if (!candidate || typeof candidate.isSupportedPage !== 'function') {
        return false;
      }
      try {
        return candidate.isSupportedPage();
      } catch (error) {
        return false;
      }
    });

    if (!provider) {
      if (activeApp) {
        activeApp.destroy();
      }
      activeProvider = null;
      activeApp = null;
      return;
    }

    if (provider !== activeProvider) {
      if (activeApp) {
        activeApp.destroy();
      }
      activeProvider = provider;
      activeApp = FSD.mountProvider(provider);
      return;
    }

    activeApp.ensureMounted();
  }

  function scheduleReconcile(delayMs = RECONCILE_DELAY_MS) {
    if (scheduled) {
      return;
    }
    scheduled = true;
    root.setTimeout(reconcile, delayMs);
  }

  scheduleReconcile(INITIAL_DELAY_MS);
  // Wrapped rather than passed directly: these callbacks receive an event or a
  // MutationRecord list, which would otherwise be taken as the delay.
  const observer = new MutationObserver(() => scheduleReconcile());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  root.addEventListener('popstate', () => scheduleReconcile());
  root.addEventListener('hashchange', () => scheduleReconcile());
})(globalThis);
