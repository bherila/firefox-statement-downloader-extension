(function initializeBatch(root) {
  'use strict';

  const namespace = root.FinancialStatementDownloader || {};

  function createStopController() {
    let stopped = false;
    let reason = null;
    let resolveStopped;
    const stoppedPromise = new Promise((resolve) => {
      resolveStopped = resolve;
    });
    const signal = {
      get aborted() {
        return stopped;
      },
      get reason() {
        return reason;
      },
      wait() {
        return stoppedPromise;
      },
    };
    return {
      stop(nextReason = 'stopped by user') {
        if (stopped) return;
        stopped = true;
        reason = nextReason;
        resolveStopped(nextReason);
      },
      requestStop(nextReason) {
        this.stop(nextReason);
      },
      get stopped() {
        return stopped;
      },
      get reason() {
        return reason;
      },
      signal,
      waitForStop() {
        return stoppedPromise;
      },
    };
  }

  function isStopped(controller) {
    return Boolean(
      controller && (
        controller.stopped ||
        controller.aborted ||
        (controller.signal && controller.signal.aborted)
      )
    );
  }

  function errorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  function waitForStop(controller) {
    if (!controller) return new Promise(() => {});
    if (isStopped(controller)) return Promise.resolve(controller.reason);
    if (typeof controller.waitForStop === 'function') return controller.waitForStop();
    if (controller.signal && typeof controller.signal.wait === 'function') return controller.signal.wait();
    if (controller.signal && typeof controller.signal.addEventListener === 'function') {
      return new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve(controller.signal.reason), { once: true }));
    }
    return new Promise(() => {});
  }

  async function waitUnlessStopped(promise, controller) {
    if (isStopped(controller)) return false;
    const outcome = await Promise.race([
      Promise.resolve(promise).then(() => true),
      waitForStop(controller).then(() => false),
    ]);
    return outcome && !isStopped(controller);
  }

  async function runBatch({ provider, options = {}, controller, report } = {}) {
    if (!provider || typeof provider !== 'object') {
      throw new TypeError('provider is required');
    }
    if (typeof provider.id !== 'string' || provider.id.trim() === '') {
      throw new TypeError('provider.id must be a non-empty string');
    }
    if (typeof provider.discoverDocuments !== 'function') {
      throw new TypeError('provider.discoverDocuments must be a function');
    }
    if (typeof provider.downloadDocument !== 'function') {
      throw new TypeError('provider.downloadDocument must be a function');
    }

    const notify = typeof report === 'function' ? report : () => {};
    const stopController = controller || createStopController();
    const storage = options.storage || namespace.createProviderStorage(provider.id);
    const attempts = options.attempts === undefined ? 3 : options.attempts;
    const retryDelayMs = options.retryDelayMs === undefined ? 1000 : options.retryDelayMs;
    const delayMs = options.delayMs === undefined ? 1000 : options.delayMs;
    const wait = options.sleep || namespace.sleep || ((ms) => new Promise((resolve) => root.setTimeout(resolve, ms)));

    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError('options.attempts must be a positive integer');
    }
    if (!Number.isFinite(delayMs) || delayMs < 0 || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
      throw new RangeError('batch delays must be non-negative numbers');
    }

    const summary = {
      discovered: 0,
      attempted: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      stopped: false,
      failures: [],
    };

    notify({
      type: 'discovery-start',
      provider: provider.id,
      message: `Finding ${provider.label || provider.id} documents…`,
    });
    let discovered;
    try {
      discovered = await provider.discoverDocuments(options, notify, stopController);
    } catch (error) {
      if (!isStopped(stopController)) throw error;
      summary.stopped = true;
      notify({
        type: 'batch-complete',
        provider: provider.id,
        summary,
        message: 'Stopped during document discovery.',
      });
      return summary;
    }
    if (!Array.isArray(discovered)) {
      throw new TypeError('provider.discoverDocuments must return an array');
    }
    const documents = discovered.map((document) => namespace.normalizeDocument(provider.id, document));
    summary.discovered = documents.length;
    notify({
      type: 'discovery-complete',
      provider: provider.id,
      count: documents.length,
      message: `Found ${documents.length} document${documents.length === 1 ? '' : 's'}.`,
    });

    async function isInDownloadHistory(document) {
      if (options.checkDownloadHistory === false) {
        return false;
      }
      try {
        const result = await root.browser.runtime.sendMessage({
          action: 'checkDownloaded',
          relPath: document.filename,
        });
        return Boolean(result && result.exists);
      } catch (error) {
        notify({
          type: 'history-check-failed',
          provider: provider.id,
          document,
          error: errorMessage(error),
          message: `Could not check download history for ${document.title}; it will be attempted.`,
        });
        return false;
      }
    }

    async function finishDownload(document, outcome) {
      if (outcome && outcome.downloaded === true) {
        return outcome;
      }

      const url = typeof outcome === 'string' ? outcome : outcome && outcome.url;
      if (typeof url !== 'string' || url.trim() === '') {
        throw new Error('provider download outcome must contain a URL or { downloaded: true }');
      }
      const result = await root.browser.runtime.sendMessage({
        action: 'download',
        url,
        filename: (outcome && outcome.filename) || document.filename,
      });
      if (!result || result.ok === false) {
        throw new Error(result && result.error ? result.error : 'background download failed');
      }
      return result;
    }

    async function downloadWithRetries(document) {
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (isStopped(stopController)) {
          return { stopped: true };
        }
        try {
          const outcome = await provider.downloadDocument(document, notify, stopController);
          return { result: await finishDownload(document, outcome) };
        } catch (error) {
          lastError = error;
          if (isStopped(stopController) || (error && error.stopped)) {
            return { stopped: true };
          }
          if (attempt === attempts || isStopped(stopController)) {
            break;
          }
          const retryMs = (error && error.status === 429 ? 4 : 1) * retryDelayMs * Math.pow(2, attempt - 1);
          notify({
            type: 'download-retry',
            provider: provider.id,
            document,
            attempt,
            attempts,
            delayMs: retryMs,
            error: errorMessage(error),
            message: `Retrying ${document.title} (${attempt + 1}/${attempts})…`,
          });
          if (!await waitUnlessStopped(wait(retryMs), stopController)) {
            return { stopped: true };
          }
        }
      }
      throw lastError;
    }

    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      if (isStopped(stopController)) {
        summary.stopped = true;
        break;
      }

      if (await storage.isDone(document) || await isInDownloadHistory(document)) {
        summary.skipped += 1;
        notify({
          type: 'document-skipped',
          provider: provider.id,
          document,
          message: `Skipped ${document.title}; it was already downloaded.`,
        });
        continue;
      }

      summary.attempted += 1;
      notify({
        type: 'download-start',
        provider: provider.id,
        document,
        message: `Downloading ${document.title}…`,
      });
      try {
        const outcome = await downloadWithRetries(document);
        if (outcome.stopped) {
          summary.stopped = true;
          break;
        }
        await storage.markDone(document);
        summary.downloaded += 1;
        notify({
          type: 'download-complete',
          provider: provider.id,
          document,
          message: `Downloaded ${document.title}.`,
        });
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({ id: document.id, error: errorMessage(error) });
        notify({
          type: 'download-failed',
          provider: provider.id,
          document,
          error: errorMessage(error),
          level: 'error',
          message: `Failed ${document.title}: ${errorMessage(error)}`,
        });
      }

      if (isStopped(stopController)) {
        summary.stopped = true;
        break;
      }
      if (delayMs > 0 && index < documents.length - 1) {
        if (!await waitUnlessStopped(wait(delayMs), stopController)) {
          summary.stopped = true;
          break;
        }
      }
    }

    summary.stopped = summary.stopped || isStopped(stopController);
    notify({
      type: 'batch-complete',
      provider: provider.id,
      summary,
      message: summary.stopped
        ? `Stopped: ${summary.downloaded} downloaded, ${summary.skipped} skipped, ${summary.failed} failed.`
        : `Finished: ${summary.downloaded} downloaded, ${summary.skipped} skipped, ${summary.failed} failed.`,
    });
    return summary;
  }

  Object.assign(namespace, { createStopController, isStopped, waitForStop, runBatch });
  root.FinancialStatementDownloader = namespace;
})(globalThis);
