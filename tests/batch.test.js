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
  assert.equal(await fidelity.markDoneMany(['fidelity-1', 'fidelity-2']), 1);
  assert.deepEqual(plain(await fidelity.loadSettings()), { year: 2025 });
  assert.equal(await fidelity.isDone('fidelity-1'), true);
  assert.equal(await fidelity.isDone('fidelity-2'), true);
  await fidelity.clearDone();
  assert.equal(await fidelity.isDone('fidelity-1'), false);
});

test('batch skips provider-completed and Firefox-history documents and downloads a URL outcome', async () => {
  const fake = createBrowser({}, ['history.pdf']);
  const FSD = loadCore(fake);
  const storage = FSD.createProviderStorage('fidelity');
  await storage.markDone('complete');
  const downloadedByProvider = [];
  const events = [];
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
    report: (event) => events.push(event),
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
  const skipped = events.filter((event) => event.type === 'document-skipped');
  assert.deepEqual(skipped.map((event) => [event.current, event.total, event.remaining]), [
    [1, 3, 2],
    [2, 3, 1],
  ]);
  const started = events.find((event) => event.type === 'download-start');
  const completed = events.find((event) => event.type === 'download-complete');
  assert.match(started.message, /^File 3 of 3: Downloading/);
  assert.match(completed.message, /^File 3 of 3: Downloaded/);
  assert.equal(completed.remaining, 0);
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
    report: (event) => events.push(event),
  });

  assert.deepEqual(calls, ['broken', 'broken', 'working']);
  assert.equal(summary.failed, 1);
  assert.equal(summary.downloaded, 1);
  assert.deepEqual(plain(summary.failures), [{ id: 'broken', error: 'overlay never cleared' }]);
  assert.equal(fake.messages.some((message) => message.action === 'download'), false);
  const retry = events.find((event) => event.type === 'download-retry');
  const failure = events.find((event) => event.type === 'download-failed');
  assert.match(retry.message, /^File 1 of 2: Retrying/);
  assert.deepEqual([retry.current, retry.total, retry.remaining], [1, 2, 1]);
  assert.match(failure.message, /^File 1 of 2: Failed/);
  assert.ok(events.some((event) => event.type === 'batch-complete'));
});

test('batch does not retry a terminal refusal and stops before later documents', async () => {
  const fake = createBrowser();
  const FSD = loadCore(fake);
  const calls = [];
  const events = [];
  const provider = {
    id: 'meritain',
    async discoverDocuments() {
      return [doc('blocked'), doc('later')];
    },
    async downloadDocument(document) {
      calls.push(document.id);
      const error = new Error('request refused');
      error.blocked = true;
      throw error;
    },
  };

  const summary = await FSD.runBatch({
    provider,
    options: { attempts: 3, delayMs: 0, retryDelayMs: 0 },
    report: (event) => events.push(event.type),
  });

  assert.deepEqual(calls, ['blocked']);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.stopped, true);
  assert.equal(events.includes('download-retry'), false);
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

test('spreads the gap between downloads instead of using a fixed cadence', async () => {
  const fake = createBrowser();
  const FSD = loadCore(fake);
  const slept = [];

  const provider = {
    id: 'fidelity',
    discoverDocuments: async () => [doc('a'), doc('b'), doc('c')],
    downloadDocument: async (document) => ({ url: `https://example.test/${document.id}` }),
  };

  // A deterministic sequence stands in for Math.random so the spread is exact.
  const randoms = [0, 0.5, 1];
  let index = 0;

  await FSD.runBatch({
    provider,
    options: {
      delayMs: 1000,
      jitterRatio: 0.5,
      random: () => randoms[index++ % randoms.length],
      sleep: async (ms) => { slept.push(ms); },
      checkDownloadHistory: false,
    },
  });

  // delayMs 1000 with ratio 0.5 spans 750..1250, centred on the base delay.
  assert.deepEqual(slept, [750, 1000]);
});

test('jitterRatio of zero preserves an exact fixed delay', async () => {
  const fake = createBrowser();
  const FSD = loadCore(fake);
  const slept = [];

  await FSD.runBatch({
    provider: {
      id: 'fidelity',
      discoverDocuments: async () => [doc('a'), doc('b')],
      downloadDocument: async () => ({ url: 'https://example.test/a' }),
    },
    options: {
      delayMs: 500,
      jitterRatio: 0,
      sleep: async (ms) => { slept.push(ms); },
      checkDownloadHistory: false,
    },
  });

  assert.deepEqual(slept, [500]);
});

test('rejects a jitter ratio outside the supported range', async () => {
  const fake = createBrowser();
  const FSD = loadCore(fake);

  await assert.rejects(() => FSD.runBatch({
    provider: {
      id: 'fidelity',
      discoverDocuments: async () => [],
      downloadDocument: async () => ({ url: 'x' }),
    },
    // The core runs in its own vm realm, so match the message rather than the
    // RangeError constructor, which is a different identity across realms.
    options: { jitterRatio: 5 },
  }), /jitterRatio must be between 0 and 2/);
});

test('routes byte payloads to the background download handler', async () => {
  const fake = createBrowser();
  fake.api.runtime.sendMessage = async (message) => {
    fake.messages.push(message);
    if (message.action === 'checkDownloaded') return { exists: false };
    if (message.action === 'downloadData') return { ok: true, downloadId: 7 };
    throw new Error(`unexpected message: ${message.action}`);
  };
  const FSD = loadCore(fake);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  const summary = await FSD.runBatch({
    provider: {
      id: 'fidelity',
      discoverDocuments: async () => [doc('a')],
      downloadDocument: async () => ({ data: bytes, contentType: 'application/pdf' }),
    },
    options: { delayMs: 0, checkDownloadHistory: false },
  });

  assert.equal(summary.downloaded, 1);
  const sent = fake.messages.find((message) => message.action === 'downloadData');
  // The bytes must reach the background intact; there is no URL to fall back on.
  assert.deepEqual(sent.data, bytes);
  assert.equal(sent.contentType, 'application/pdf');
  assert.equal(sent.filename, 'a.pdf');
});
