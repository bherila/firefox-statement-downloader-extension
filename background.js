'use strict';

// Coinbase report generation needs values from the page's own request. Observe only
// that endpoint and keep the required report parameters in local extension storage.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.requestBody || !details.requestBody.raw || !details.requestBody.raw[0]) {
      return;
    }
    try {
      const bytes = details.requestBody.raw[0].bytes;
      const json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      if (json.profile_id && json.email) {
        browser.storage.local.set({
          'fsd:coinbase:template': {
            email: json.email,
            profile_id: json.profile_id,
            proof_token: json.proof_token || '',
          },
        });
      }
    } catch (error) {
      // Ignore malformed or unrelated request bodies.
    }
  },
  { urls: ['https://accounts.coinbase.com/v1/statements/generate-pro-report'] },
  ['requestBody'],
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const downloadWatches = new Map();
let nextWatchId = 1;

function urlOrigin(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch (error) {
    return null;
  }
}

function cleanUpDownloadWatch(watchId, watch) {
  clearTimeout(watch.expirationTimer);
  clearTimeout(watch.finishTimer);
  downloadWatches.delete(watchId);
}

function settleDownloadWatch(watchId, result) {
  const watch = downloadWatches.get(watchId);
  if (!watch || watch.result) return;

  watch.result = result;
  if (watch.resolve) {
    const resolve = watch.resolve;
    watch.resolve = null;
    cleanUpDownloadWatch(watchId, watch);
    resolve(result);
  }
}

function failAmbiguousWatches(candidates) {
  for (const [watchId] of candidates) {
    settleDownloadWatch(watchId, {
      ok: false,
      error: 'multiple download watches matched the site download',
    });
  }
}

browser.downloads.onCreated.addListener((item) => {
  const candidate = String(item.filename || item.url || '').toLowerCase().split(/[?#]/, 1)[0];
  let candidates = [...downloadWatches.entries()].filter(([, watch]) => (
    !watch.result
      && watch.downloadId === null
      && (!watch.extension || candidate.endsWith(watch.extension))
  ));

  // Firefox includes the initiating page as referrer when the site starts the
  // download. If present, never let a watch armed by another origin claim it.
  if (item.referrer) {
    const referrerOrigin = urlOrigin(item.referrer);
    candidates = referrerOrigin
      ? candidates.filter(([, watch]) => watch.origin === referrerOrigin)
      : [];
  } else {
    // A referrer-less event cannot be tied back to a content-script tab. Prefer a
    // visible timeout/failure over recording an unrelated PDF as a completed statement.
    candidates = candidates.filter(([, watch]) => !watch.origin);
  }

  if (candidates.length > 1) {
    failAmbiguousWatches(candidates);
    return;
  }

  if (candidates.length !== 1) return;

  const [, watch] = candidates[0];
  watch.downloadId = item.id;
  watch.download = {
    downloadId: item.id,
    filename: item.filename || null,
    url: item.url || null,
  };
});

browser.downloads.onChanged.addListener((delta) => {
  const match = [...downloadWatches.entries()].find(([, watch]) => (
    !watch.result && watch.downloadId === delta.id
  ));
  if (!match || !delta.state || !delta.state.current) return;

  const [watchId, watch] = match;
  if (delta.state.current === 'complete') {
    settleDownloadWatch(watchId, { ok: true, ...watch.download });
  } else if (delta.state.current === 'interrupted') {
    settleDownloadWatch(watchId, {
      ok: false,
      error: delta.error && delta.error.current
        ? `download interrupted: ${delta.error.current}`
        : 'download interrupted',
      downloadId: watch.downloadId,
    });
  }
});

function finishDownloadWatch(watchId, timeoutMs) {
  const watch = downloadWatches.get(watchId);
  if (!watch) {
    return Promise.resolve({ ok: false, error: 'download watch not found' });
  }
  if (watch.result) {
    cleanUpDownloadWatch(watchId, watch);
    return Promise.resolve(watch.result);
  }
  if (watch.resolve) {
    return Promise.resolve({ ok: false, error: 'download watch is already being finished' });
  }
  return new Promise((resolve) => {
    watch.resolve = (result) => {
      resolve(result);
    };
    watch.finishTimer = setTimeout(() => {
      settleDownloadWatch(watchId, { ok: false, error: 'timed out waiting for the site download' });
    }, timeoutMs);
  });
}

browser.runtime.onMessage.addListener((message, sender = {}) => {
  if (!message || typeof message.action !== 'string') {
    return undefined;
  }

  if (message.action === 'download') {
    return browser.downloads.download({
      url: message.url,
      filename: message.filename,
      conflictAction: message.conflictAction || 'uniquify',
      saveAs: false,
    }).then((downloadId) => ({ ok: true, downloadId }))
      .catch((error) => ({ ok: false, error: String(error) }));
  }

  if (message.action === 'checkDownloaded') {
    const pattern = `${escapeRegExp(message.relPath)}$`;
    return browser.downloads.search({ filenameRegex: pattern, state: 'complete' })
      .then((results) => ({ exists: results.length > 0 }))
      .catch(() => ({ exists: false }));
  }

  if (message.action === 'startDownloadWatch') {
    const extension = String(message.extension || '.pdf').toLowerCase();
    const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    const origin = urlOrigin(sender.origin || sender.url || (sender.tab && sender.tab.url));
    const conflicts = [...downloadWatches.values()].some((watch) => (
      !watch.result
        && watch.extension === extension
        && ((origin && watch.origin === origin)
          || (tabId !== null && watch.tabId === tabId)
          || (!origin && tabId === null && !watch.origin && watch.tabId === null))
    ));
    if (conflicts) {
      return Promise.resolve({ ok: false, error: 'a matching download watch is already active' });
    }

    const watchId = nextWatchId;
    nextWatchId += 1;
    const watch = {
      extension,
      tabId,
      origin,
      downloadId: null,
      download: null,
      result: null,
      resolve: null,
      expirationTimer: null,
      finishTimer: null,
    };
    watch.expirationTimer = setTimeout(() => {
      if (watch.resolve) {
        settleDownloadWatch(watchId, { ok: false, error: 'download watch expired' });
      } else {
        cleanUpDownloadWatch(watchId, watch);
      }
    }, 130000);
    downloadWatches.set(watchId, watch);
    return Promise.resolve({ ok: true, watchId });
  }

  if (message.action === 'finishDownloadWatch') {
    return finishDownloadWatch(message.watchId, Math.min(Math.max(message.timeoutMs || 60000, 1000), 120000));
  }

  if (message.action === 'cancelDownloadWatch') {
    const watch = downloadWatches.get(message.watchId);
    if (watch) {
      settleDownloadWatch(message.watchId, { ok: false, error: 'download watch cancelled' });
      if (downloadWatches.get(message.watchId) === watch) cleanUpDownloadWatch(message.watchId, watch);
    }
    return Promise.resolve({ ok: true });
  }

  return undefined;
});
