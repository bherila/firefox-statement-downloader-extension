(function initializeContentScript(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader;
  if (!FSD) {
    throw new Error('Financial Statement Downloader core did not load');
  }

  let activeProvider = null;
  let activeApp = null;
  let scheduled = false;

  function reconcile() {
    scheduled = false;
    const providers = Object.values(FSD.providers || {});
    const provider = providers.find((candidate) => candidate.isSupportedPage());

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

  function scheduleReconcile() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    root.setTimeout(reconcile, 100);
  }

  reconcile();
  const observer = new MutationObserver(scheduleReconcile);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  root.addEventListener('popstate', scheduleReconcile);
  root.addEventListener('hashchange', scheduleReconcile);
})(globalThis);
