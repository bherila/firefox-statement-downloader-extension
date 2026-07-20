'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const providerPath = require.resolve('../providers/fidelity.js');

function loadHelpers() {
  global.FinancialStatementDownloader = undefined;
  delete require.cache[providerPath];
  require(providerPath);
  return global.FinancialStatementDownloader.providers.fidelity.helpers;
}

test.afterEach(() => {
  delete global.browser;
  delete global.FinancialStatementDownloader;
  delete require.cache[providerPath];
});

test('detects and sorts unique four-digit Fidelity year values', () => {
  const { extractYear, extractYears } = loadHelpers();

  assert.equal(extractYear('View documents from 2024'), 2024);
  assert.equal(extractYear('Account ending 2024'), 2024);
  assert.equal(extractYear('24'), null);
  assert.equal(extractYear('12024'), null);
  assert.deepEqual(extractYears(['2023', 'Tax year 2024', '2023', 'All years']), [2024, 2023]);
});

test('classifies the three Fidelity document categories without confusing confirmations', () => {
  const { classifyCategory } = loadHelpers();

  assert.equal(classifyCategory('Monthly statements'), 'statements');
  assert.equal(classifyCategory('Trade Confirmations and Statements'), 'trade-confirmations');
  assert.equal(classifyCategory('1099 Tax Forms'), 'tax-documents');
  assert.equal(classifyCategory('Form 5498'), 'tax-documents');
  assert.equal(classifyCategory('Portfolio documents'), null);
});

test('builds filesystem-safe, institution-scoped filenames', () => {
  const { buildFilename } = loadHelpers();

  assert.equal(buildFilename({
    year: 2024,
    category: 'statements',
    date: '02/29/2024',
    title: 'Brokerage: Monthly/Statement.pdf',
    account: 'Individual ***1234',
  }), 'Fidelity/statements/2024/2024-02-29 - Brokerage- Monthly-Statement - Individual - 1234.pdf');

  assert.equal(buildFilename({
    year: 'Tax year 2023',
    category: 'tax-documents',
    title: 'Form 1099-R',
  }), 'Fidelity/tax-documents/2023/Form 1099-R.pdf');
});

test('stable document IDs ignore signed query strings but distinguish document identity', () => {
  const { stableDocumentId } = loadHelpers();
  const base = {
    category: 'trade-confirmations',
    year: 2024,
    date: 'March 4, 2024',
    title: 'Trade confirmation',
    account: 'Brokerage 1234',
  };
  const first = stableDocumentId({ ...base, href: 'https://statements.fidelity.com/download/abc?token=one' });
  const refreshed = stableDocumentId({ ...base, href: 'https://statements.fidelity.com/download/abc?token=two' });
  const other = stableDocumentId({ ...base, date: 'March 5, 2024', href: 'https://statements.fidelity.com/download/def' });

  assert.equal(first, refreshed);
  assert.notEqual(first, other);
  assert.match(first, /^trade-confirmations:2024:[a-z0-9]+$/);
});

test('stable document IDs retain identity query parameters while ignoring signing and tracking noise', () => {
  const { stableDocumentId, stableHrefIdentity } = loadHelpers();
  const base = {
    category: 'statements',
    year: 2025,
    date: '2025-12-31',
    title: 'Monthly statement',
    account: 'Brokerage 1234',
  };
  const first = stableDocumentId({
    ...base,
    href: '/download?documentId=statement-a&accountId=1234&token=one&utm_source=table',
  });
  const refreshed = stableDocumentId({
    ...base,
    href: '/download?accountId=1234&token=two&documentId=statement-a&utm_source=email',
  });
  const distinct = stableDocumentId({
    ...base,
    href: '/download?documentId=statement-b&accountId=1234&token=three',
  });

  assert.equal(first, refreshed);
  assert.notEqual(first, distinct);
  assert.equal(
    stableHrefIdentity('/download?documentId=statement-a&token=secret'),
    'https://digital.fidelity.com/download?documentId=statement-a'
  );
});

test('stopping an active Fidelity download watch cancels it promptly', async () => {
  const messages = [];
  global.browser = {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        if (message.action === 'finishDownloadWatch') return new Promise(() => {});
        if (message.action === 'cancelDownloadWatch') return { ok: true };
        throw new Error(`unexpected message: ${message.action}`);
      },
    },
  };
  const { finishWatchedDownload } = loadHelpers();
  let stopped = false;
  let reason = null;
  let resolveStop;
  const stopPromise = new Promise((resolve) => { resolveStop = resolve; });
  const controller = {
    get stopped() { return stopped; },
    get reason() { return reason; },
    waitForStop() { return stopPromise; },
    stop(nextReason) {
      stopped = true;
      reason = nextReason;
      resolveStop(nextReason);
    },
  };

  const finishing = finishWatchedDownload('watch-1', 120000, controller);
  await Promise.resolve();
  controller.stop('user stopped');

  await assert.rejects(finishing, (error) => error.stopped === true && /user stopped/.test(error.message));
  assert.deepEqual(messages, [
    { action: 'finishDownloadWatch', watchId: 'watch-1', timeoutMs: 120000 },
    { action: 'cancelDownloadWatch', watchId: 'watch-1' },
  ]);
});
