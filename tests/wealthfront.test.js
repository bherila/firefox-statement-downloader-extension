'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const providerPath = require.resolve('../providers/wealthfront.js');

function loadHelpers() {
  global.FinancialStatementDownloader = {};
  delete require.cache[providerPath];
  require(providerPath);
  return global.FinancialStatementDownloader.providers.wealthfront.helpers;
}

test.afterEach(() => {
  delete global.FinancialStatementDownloader;
  delete require.cache[providerPath];
});

test('classifies Wealthfront statements, confirmations, and common tax forms', () => {
  const { classifyCategory } = loadHelpers();

  assert.equal(classifyCategory('Monthly Account Statement — December 2025'), 'statements');
  assert.equal(classifyCategory('Trade Confirmation'), 'trade-confirmations');
  assert.equal(classifyCategory('Consolidated 1099 Tax Document'), 'tax-documents');
  assert.equal(classifyCategory('Form 5498'), 'tax-documents');
  assert.equal(classifyCategory('Account transfer receipt'), null);
});

test('tax classification wins when a tax document also contains statement wording', () => {
  const { classifyCategory } = loadHelpers();

  assert.equal(classifyCategory('2025 tax statement (1099-DIV)'), 'tax-documents');
});

test('stable row signatures ignore whitespace, case, fragments, and tracking parameters', () => {
  const { stableRowSignature } = loadHelpers();
  const first = stableRowSignature({
    category: 'statements',
    date: '2025-12-31',
    account: 'Cash Account',
    title: 'December Statement',
    href: '/documents/abc.pdf?utm_source=table#download',
    locatorText: 'Download PDF',
  });
  const second = stableRowSignature({
    category: ' STATEMENTS ',
    date: '2025-12-31',
    account: 'cash   account',
    title: 'december statement',
    href: 'https://www.wealthfront.com/documents/abc.pdf',
    locatorText: ' download   pdf ',
  });

  assert.match(first, /^row-[a-f0-9]{8}$/);
  assert.equal(first, second);
});

test('pagination signatures preserve row order and identify repeated pages', () => {
  const { paginationSignature } = loadHelpers();

  assert.equal(paginationSignature(['row-a', 'row-b']), paginationSignature(['row-a', 'row-b']));
  assert.notEqual(paginationSignature(['row-a', 'row-b']), paginationSignature(['row-b', 'row-a']));
  assert.notEqual(paginationSignature(['row-a']), paginationSignature(['row-a', 'row-b']));
  assert.throws(() => paginationSignature('row-a'), /must be an array/);
});

test('builds category-scoped, filesystem-safe PDF filenames', () => {
  const { buildFilename } = loadHelpers();

  assert.equal(
    buildFilename({
      category: 'trade-confirmations',
      date: '01/19/2026',
      account: 'Individual / Brokerage',
      title: 'AAPL: Buy <Confirmation>.pdf',
    }),
    'Wealthfront/trade-confirmations/2026-01-19 - Individual - Brokerage - AAPL- Buy -Confirmation-.pdf'
  );
  assert.equal(
    buildFilename({ category: 'tax-documents', date: '2025', title: 'Form 1099-B' }),
    'Wealthfront/tax-documents/2025 - Form 1099-B.pdf'
  );
  assert.equal(
    buildFilename({ category: 'statements', date: '', title: 'Statement' }),
    'Wealthfront/statements/undated - Statement.pdf'
  );
});

test('normalizes numeric and named Wealthfront dates for filenames', () => {
  const { normalizeDate } = loadHelpers();

  assert.equal(normalizeDate('Available 2026/7/9'), '2026-07-09');
  assert.equal(normalizeDate('July 9, 2026'), '2026-07-09');
  assert.equal(normalizeDate('Tax year 2025'), '2025');
});

test('selected category defaults include all document types and reject none', () => {
  const { selectedCategories } = loadHelpers();

  assert.deepEqual(selectedCategories({}), [
    'statements',
    'trade-confirmations',
    'tax-documents',
  ]);
  assert.deepEqual(selectedCategories({ wantStatements: false, wantTaxDocuments: false }), [
    'trade-confirmations',
  ]);
  assert.throws(() => selectedCategories({
    wantStatements: false,
    wantTradeConfirmations: false,
    wantTaxDocuments: false,
  }), /Select at least one/);
});
