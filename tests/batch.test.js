'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createBrowser(initialStorage = {}, downloaded = []) {
  const values = { ...initialStorage };
  const messages = [];
  return {
    values,
    messages,
    api: {
      storage: {
        local: {
          async get(keys) {
            const requested = keys === undefined
              ? Object.keys(values)
              : Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              requested.filter((key) => Object.prototype.hasOwnProperty.call(values, key))
                .map((key) => [key, values[key]]),
            );
          },
          async set(next) {
            Object.assign(values, next);
          },
        },
      },
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          if (message.action === 'checkDownloaded') {
            return { exists: downloaded.includes(message.relPath) };
          }
          if (message.action === 'download') {
            return { ok: true, downloadId: messages.length };
          }
          throw new Error(`unexpected message: ${message.action}`);
        },
      },
    },
  };
}

function loadCore(browserFake) {
  const context = vm.createContext({ browser: browserFake.api, setTimeout });
  for (const file of ['runtime.js', 'storage.js', 'batch.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'core', file), 'utf8');
    vm.runInContext(source, context, { filename: `core/${file}` });
  }
  return context.FinancialStatementDownloader;
}

function doc(id) {
  return {
    id,
    title: `Document ${id}`,
    category: 'statements',
    filename: `${id}.pdf`,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('provider storage is isolated, tracks done documents, and migrates only explicitly', async () => {
  const fake = createBrowser({ settings: { legacy: true }, done: { old: true } });
  const FSD = loadCore(fake);
  const coinbase = FSD.createProviderStorage('coinbase');
  const fidelity = FSD.createProviderStorage('fidelity');

  assert.equal(await coinbase.loadSettings(), null);
  assert.equal(await fidelity.loadSettings(), null);
  assert.equal(await coinbase.isDone('old'), false);

  assert.deepEqual(Array.from(await coinbase.migrateLegacy(['settings', 'done'])), ['settings', 'done']);
  assert.deepEqual(plain(await coinbase.loadSettings()), { legacy: true });
  assert.equal(await coinbase.isDone('old'), true);
  assert.equal(await fidelity.isDone('old'), false);

  await fidelity.saveSettings({ year: 2025 });
  await fidelity.markDone('fidelity-1');
  assert.deepEqual(plain(await fidelity.loadSettings()), { year: 2025 });
  assert.equal(await fidelity.isDone('fidelity-1'), true);
  await fidelity.clearDone();
  assert.equal(await fidelity.isDone('fidelity-1'), false);
});

test('batch skips provider-completed and Firefox-history documents and downloads a URL outcome', async () => {
  const fake = createBrowser({}, ['history.pdf']);
  const FSD = loadCore(fake);
  const storage = FSD.createProviderStorage('fidelity');
  await storage.markDone('complete');
  const downloadedByProvider = [];
  const provider = {
    id: 'fidelity',
    async discoverDocuments(options, report) {
      assert.equal(options.year, 2025);
      assert.equal(typeof report, 'function');
      return [doc('complete'), doc('history'), doc('new')];
    },
    async downloadDocument(document) {
      downloadedByProvider.push(document.id);
      return { url: `https://example.test/${document.id}`, filename: `Fidelity/${document.filename}` };
    },
  };

  const summary = await FSD.runBatch({
    provider,
    options: { year: 2025, delayMs: 0, retryDelayMs: 0 },
  });

  assert.deepEqual(plain(summary), {
    discovered: 3,
    attempted: 1,
    downloaded: 1,
    skipped: 2,
    failed: 0,
    stopped: false,
    failures: [],
  });
  assert.deepEqual(downloadedByProvider, ['new']);
  assert.deepEqual(
    plain(fake.messages.filter((message) => message.action === 'download')),
    [{ action: 'download', url: 'https://example.test/new', filename: 'Fidelity/new.pdf' }],
  );
  assert.equal(await storage.isDone('new'), true);
});

test('batch retries failures, continues to later documents, and accepts downloaded outcomes', async () => {
  const fake = createBrowser();
  const FSD = loadCore(fake);
  const calls = [];
  const events = [];
  const provider = {
    id: 'wealthfront',
    async discoverDocuments() {
      return [doc('broken'), doc('working')];
    },
    async downloadDocument(document) {
      calls.push(document.id);
      if (document.id === 'broken') {
        throw new Error('overlay never cleared');
      }
      return { downloaded: true };
    },
  };

  const summary = await FSD.runBatch({
    provider,
    options: { attempts: 2, delayMs: 0, retryDelayMs: 0 },
    report: (event) => events.push(event.type),
  });

  assert.deepEqual(calls, ['broken', 'broken', 'working']);
  assert.equal(summary.failed, 1);
  assert.equal(summary.downloaded, 1);
  assert.deepEqual(plain(summary.failures), [{ id: 'broken', error: 'overlay never cleared' }]);
  assert.equal(fake.messages.some((message) => message.action === 'download'), false);
  assert.ok(events.includes('download-retry'));
  assert.ok(events.includes('download-failed'));
  assert.ok(events.includes('batch-complete'));
});

test('stop controller ends the batch after the active document', async () => {
  const fake = createBrowser();
  const FSD = loadCore(fake);
  const controller = FSD.createStopController();
  const calls = [];
  const provider = {
    id: 'coinbase',
    async discoverDocuments() {
      return [doc('first'), doc('second')];
    },
    async downloadDocument(document) {
      calls.push(document.id);
      controller.stop('test requested stop');
      return { downloaded: true };
    },
  };

  const summary = await FSD.runBatch({
    provider,
    controller,
    options: { delayMs: 0, retryDelayMs: 0 },
  });

  assert.deepEqual(calls, ['first']);
  assert.equal(summary.downloaded, 1);
  assert.equal(summary.stopped, true);
  assert.equal(controller.reason, 'test requested stop');
});

test('stop controller exposes an awaitable signal and interrupted discovery returns a stopped summary', async () => {
  const fake = createBrowser();
  const FSD = loadCore(fake);
  const controller = FSD.createStopController();
  const provider = {
    id: 'fidelity',
    async discoverDocuments(options, report, receivedController) {
      assert.equal(receivedController, controller);
      await receivedController.signal.wait();
      throw new Error('discovery interrupted');
    },
    async downloadDocument() {
      throw new Error('must not download');
    },
  };

  const batch = FSD.runBatch({ provider, controller, options: { delayMs: 0 } });
  controller.stop('stop discovery');
  const summary = await batch;

  assert.deepEqual(plain(summary), {
    discovered: 0,
    attempted: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    stopped: true,
    failures: [],
  });
  assert.equal(await controller.waitForStop(), 'stop discovery');
  assert.equal(controller.signal.aborted, true);
});
