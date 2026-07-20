'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const backgroundPath = require.resolve('../background.js');

function loadBackground() {
  const captured = {
    messages: null,
    request: null,
    downloadCreated: null,
    downloadChanged: null,
    stored: {},
  };
  global.browser = {
    webRequest: {
      onBeforeRequest: {
        addListener(listener) { captured.request = listener; },
      },
    },
    storage: {
      local: {
        async set(values) { Object.assign(captured.stored, values); },
      },
    },
    downloads: {
      onCreated: {
        addListener(listener) { captured.downloadCreated = listener; },
      },
      onChanged: {
        addListener(listener) { captured.downloadChanged = listener; },
      },
      async download() { return 1; },
      async search() { return []; },
    },
    runtime: {
      onMessage: {
        addListener(listener) { captured.messages = listener; },
      },
    },
  };
  delete require.cache[backgroundPath];
  require(backgroundPath);
  return captured;
}

test.afterEach(() => {
  delete require.cache[backgroundPath];
  delete global.browser;
});

test('captures Coinbase calibration into provider-scoped storage', async () => {
  const captured = loadBackground();
  const body = new TextEncoder().encode(JSON.stringify({
    email: 'person@example.com',
    profile_id: 'profile-1',
    proof_token: 'proof',
  }));

  captured.request({ requestBody: { raw: [{ bytes: body }] } });
  await Promise.resolve();

  assert.deepEqual(captured.stored['fsd:coinbase:template'], {
    email: 'person@example.com',
    profile_id: 'profile-1',
    proof_token: 'proof',
  });
});

test('arms a PDF download watch before a site-triggered download', async () => {
  const captured = loadBackground();
  const sender = { tab: { id: 7 }, url: 'https://www.wealthfront.com/documents' };
  const started = await captured.messages({ action: 'startDownloadWatch', extension: '.pdf' }, sender);

  captured.downloadCreated({
    id: 42,
    filename: '/Downloads/Wealthfront/statement.pdf',
    url: 'https://example.test/download?id=1',
    referrer: 'https://www.wealthfront.com/documents',
  });
  captured.downloadChanged({ id: 42, state: { current: 'complete' } });
  const finished = await captured.messages({
    action: 'finishDownloadWatch',
    watchId: started.watchId,
    timeoutMs: 1000,
  });

  assert.deepEqual(finished, {
    ok: true,
    downloadId: 42,
    filename: '/Downloads/Wealthfront/statement.pdf',
    url: 'https://example.test/download?id=1',
  });
});

test('ignores a PDF created by an unrelated referrer origin', async () => {
  const captured = loadBackground();
  const sender = { tab: { id: 7 }, url: 'https://www.wealthfront.com/documents' };
  const started = await captured.messages({ action: 'startDownloadWatch', extension: '.pdf' }, sender);

  captured.downloadCreated({
    id: 50,
    filename: '/Downloads/unrelated.pdf',
    url: 'https://files.example.test/unrelated.pdf',
    referrer: 'https://unrelated.example.test/reports',
  });
  captured.downloadChanged({ id: 50, state: { current: 'complete' } });

  const cancelled = captured.messages({ action: 'finishDownloadWatch', watchId: started.watchId, timeoutMs: 1000 });
  await captured.messages({ action: 'cancelDownloadWatch', watchId: started.watchId });
  assert.deepEqual(await cancelled, { ok: false, error: 'download watch cancelled' });
});

test('ignores a referrer-less PDF when the watch has a known page origin', async () => {
  const captured = loadBackground();
  const sender = { tab: { id: 7 }, url: 'https://www.wealthfront.com/documents' };
  const started = await captured.messages({ action: 'startDownloadWatch', extension: '.pdf' }, sender);

  captured.downloadCreated({
    id: 54,
    filename: '/Downloads/uncorrelated.pdf',
    url: 'https://files.example.test/uncorrelated.pdf',
  });
  captured.downloadChanged({ id: 54, state: { current: 'complete' } });

  const finishing = captured.messages({
    action: 'finishDownloadWatch', watchId: started.watchId, timeoutMs: 1000,
  });
  await captured.messages({ action: 'cancelDownloadWatch', watchId: started.watchId });
  assert.deepEqual(await finishing, { ok: false, error: 'download watch cancelled' });
});

test('claims at most one origin-matching watch', async () => {
  const captured = loadBackground();
  const wealthfront = await captured.messages(
    { action: 'startDownloadWatch', extension: '.pdf' },
    { tab: { id: 7 }, url: 'https://www.wealthfront.com/documents' },
  );
  const fidelity = await captured.messages(
    { action: 'startDownloadWatch', extension: '.pdf' },
    { tab: { id: 8 }, url: 'https://digital.fidelity.com/documents' },
  );

  captured.downloadCreated({
    id: 51,
    filename: '/Downloads/statement.pdf',
    url: 'https://files.example.test/statement.pdf',
    referrer: 'https://digital.fidelity.com/documents',
  });
  captured.downloadChanged({ id: 51, state: { current: 'complete' } });

  assert.deepEqual(await captured.messages({
    action: 'finishDownloadWatch', watchId: fidelity.watchId, timeoutMs: 1000,
  }), {
    ok: true,
    downloadId: 51,
    filename: '/Downloads/statement.pdf',
    url: 'https://files.example.test/statement.pdf',
  });

  const unclaimed = captured.messages({
    action: 'finishDownloadWatch', watchId: wealthfront.watchId, timeoutMs: 1000,
  });
  await captured.messages({ action: 'cancelDownloadWatch', watchId: wealthfront.watchId });
  assert.deepEqual(await unclaimed, { ok: false, error: 'download watch cancelled' });
});

test('rejects a concurrent watch for the same page scope', async () => {
  const captured = loadBackground();
  const sender = { tab: { id: 7 }, url: 'https://www.wealthfront.com/documents' };
  const first = await captured.messages({ action: 'startDownloadWatch', extension: '.pdf' }, sender);
  const second = await captured.messages({ action: 'startDownloadWatch', extension: '.pdf' }, sender);

  assert.equal(first.ok, true);
  assert.deepEqual(second, {
    ok: false,
    error: 'a matching download watch is already active',
  });
  await captured.messages({ action: 'cancelDownloadWatch', watchId: first.watchId });
});

test('does not finish successfully until the claimed download completes', async () => {
  const captured = loadBackground();
  const started = await captured.messages(
    { action: 'startDownloadWatch', extension: '.pdf' },
    { tab: { id: 7 }, url: 'https://www.wealthfront.com/documents' },
  );
  captured.downloadCreated({
    id: 52,
    filename: '/Downloads/statement.pdf',
    url: 'https://files.example.test/statement.pdf',
    referrer: 'https://www.wealthfront.com/documents',
  });

  let settled = false;
  const finishing = captured.messages({
    action: 'finishDownloadWatch', watchId: started.watchId, timeoutMs: 1000,
  }).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  captured.downloadChanged({ id: 52, state: { current: 'complete' } });
  assert.equal((await finishing).ok, true);
});

test('reports an interrupted claimed download as a failure', async () => {
  const captured = loadBackground();
  const started = await captured.messages(
    { action: 'startDownloadWatch', extension: '.pdf' },
    { tab: { id: 7 }, url: 'https://www.wealthfront.com/documents' },
  );
  captured.downloadCreated({
    id: 53,
    filename: '/Downloads/statement.pdf',
    url: 'https://files.example.test/statement.pdf',
    referrer: 'https://www.wealthfront.com/documents',
  });
  captured.downloadChanged({
    id: 53,
    state: { current: 'interrupted' },
    error: { current: 'NETWORK_FAILED' },
  });

  assert.deepEqual(await captured.messages({
    action: 'finishDownloadWatch', watchId: started.watchId, timeoutMs: 1000,
  }), {
    ok: false,
    error: 'download interrupted: NETWORK_FAILED',
    downloadId: 53,
  });
});
