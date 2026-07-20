'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const runtimePath = require.resolve('../core/runtime.js');
const providerPath = require.resolve('../providers/wealthfront.js');

function loadProvider() {
  global.FinancialStatementDownloader = undefined;
  delete require.cache[runtimePath];
  delete require.cache[providerPath];
  require(runtimePath);
  require(providerPath);
  return global.FinancialStatementDownloader.providers.wealthfront;
}

function loadHelpers() {
  return loadProvider().helpers;
}

function statementsPayload(statements) {
  return {
    statements,
    validAccountsToRequestStatement: [
      { account_id: 2000001, display_name: 'Individual Investment Account' },
      { account_id: 2000002, display_name: 'Individual Cash Account' },
    ],
  };
}

function taxPayload() {
  return {
    accountIdsToAccountNames: { 2000001: 'Individual Investment Account' },
    files: {
      2000001: {
        documents: {
          2023: {
            FORM_1099_PDF: [{ year: '2023', type: 'FORM_1099_PDF', index: 0, docDate: '20240210' }],
            FORM_1099_XLS: [{ year: '2023', type: 'FORM_1099_XLS', index: 0, docDate: '20240210' }],
          },
        },
      },
    },
  };
}

function installFetch(handler) {
  global.fetch = handler;
}

test.afterEach(() => {
  delete global.fetch;
  delete global.FinancialStatementDownloader;
  delete require.cache[runtimePath];
  delete require.cache[providerPath];
});

test('converts the compact YYYYMMDD statement date', () => {
  const { toIsoDate } = loadHelpers();

  assert.equal(toIsoDate('20260704'), '2026-07-04');
  assert.equal(toIsoDate('2026-07-04'), null);
  assert.equal(toIsoDate(undefined), null);
});

test('derives the file extension and label from the tax form type', () => {
  const { taxFileExtension, taxFormLabel } = loadHelpers();

  assert.equal(taxFileExtension('FORM_1099_PDF'), 'pdf');
  assert.equal(taxFileExtension('FORM_1099_XLS'), 'xls');
  assert.equal(taxFormLabel('FORM_1099_PDF'), 'Form-1099');
  // Corrected forms must not collide with the original they replace.
  assert.equal(taxFormLabel('FORM_1099_CORRECTION_PDF'), 'Form-1099-Correction');
});

test('gives confirmations a year level but keeps statements flat', () => {
  const { buildStatementDocument } = loadHelpers();
  const names = new Map([['2000001', 'Individual Investment Account']]);

  const statement = buildStatementDocument({ accountId: 2000001, type: 'STATEMENT', date: '20240131', externalId: 'a' }, names);
  const confirm = buildStatementDocument({ accountId: 2000001, type: 'CONFIRM', date: '20240108', externalId: 'b' }, names);

  assert.equal(statement.filename, 'Wealthfront/Individual-Investment-Account/Statements/2024-01-31_Statement.pdf');
  // Hundreds of confirmations per account would make a flat folder unusable.
  assert.equal(confirm.filename, 'Wealthfront/Individual-Investment-Account/Trade-Confirmations/2024/2024-01-08_Trade-Confirmation.pdf');
});

test('files an unrecognized statement type under Statements rather than dropping it', () => {
  const { buildStatementDocument } = loadHelpers();

  const document = buildStatementDocument({ accountId: 1, type: 'SOME_NEW_TYPE', date: '20240131', externalId: 'x' }, new Map());

  assert.equal(document.category, 'STATEMENTS');
  assert.ok(document.filename.includes('/Statements/'));
});

test('builds tax document URLs from the account, year, type, and index', () => {
  const { buildTaxDocuments } = loadHelpers();
  const names = new Map([['2000001', 'Individual Investment Account']]);

  const documents = buildTaxDocuments(taxPayload(), names).sort((a, b) => a.id.localeCompare(b.id));

  assert.equal(documents.length, 2);
  assert.equal(
    documents[0].metadata.url,
    'https://www.wealthfront.com/documents/2000001/2023/FORM_1099_PDF?idx=0'
  );
  assert.equal(documents[0].filename, 'Wealthfront/Individual-Investment-Account/Tax-Forms/2023_Form-1099.pdf');
  assert.equal(documents[1].filename, 'Wealthfront/Individual-Investment-Account/Tax-Forms/2023_Form-1099.xls');
});

test('excludes trade confirmations unless they are selected', async () => {
  const provider = loadProvider();
  installFetch(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('tax-forms-data') ? taxPayload() : statementsPayload([
      { accountId: 2000001, type: 'STATEMENT', date: '20240131', externalId: 's1' },
      { accountId: 2000001, type: 'CONFIRM', date: '20240108', externalId: 'c1' },
    ])),
  }));

  const withoutConfirms = await provider.discoverDocuments({
    startDate: '2024-01-01', endDate: '2024-12-31', docTypes: ['STATEMENTS'],
  });
  const withConfirms = await provider.discoverDocuments({
    startDate: '2024-01-01', endDate: '2024-12-31', docTypes: ['STATEMENTS', 'CONFIRM'],
  });

  assert.deepEqual(withoutConfirms.map((d) => d.id), ['s1']);
  assert.deepEqual(withConfirms.map((d) => d.id).sort(), ['c1', 's1']);
});

test('does not request tax forms when they are not selected', async () => {
  const provider = loadProvider();
  const requested = [];
  installFetch(async (url) => {
    requested.push(url);
    return { ok: true, status: 200, json: async () => statementsPayload([]) };
  });

  await provider.discoverDocuments({ startDate: '2024-01-01', endDate: '2024-12-31', docTypes: ['STATEMENTS'] });

  assert.equal(requested.length, 1);
  assert.ok(!requested[0].includes('tax-forms-data'));
});

test('filters to the requested range client-side', async () => {
  const provider = loadProvider();
  installFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => statementsPayload([
      { accountId: 2000001, type: 'STATEMENT', date: '20230131', externalId: 'old' },
      { accountId: 2000001, type: 'STATEMENT', date: '20240131', externalId: 'inside' },
      { accountId: 2000001, type: 'STATEMENT', date: '20250131', externalId: 'new' },
    ]),
  }));

  // The API has no range parameter, so the range is applied after fetching.
  const documents = await provider.discoverDocuments({
    startDate: '2024-01-01', endDate: '2024-12-31', docTypes: ['STATEMENTS'],
  });

  assert.deepEqual(documents.map((d) => d.id), ['inside']);
});

test('returns a direct URL rather than buffering document bytes', async () => {
  const provider = loadProvider();

  const outcome = await provider.downloadDocument({
    provider: 'wealthfront',
    id: 'a',
    filename: 'Wealthfront/x/Statements/2024-01-31_Statement.pdf',
    metadata: { url: 'https://www.wealthfront.com/documents/1/document/DOC-A' },
  });

  assert.equal(outcome.url, 'https://www.wealthfront.com/documents/1/document/DOC-A');
  assert.equal(outcome.data, undefined);
});

test('flags an expired session distinctly from a transient failure', async () => {
  const provider = loadProvider();
  installFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));

  await assert.rejects(
    () => provider.discoverDocuments({ startDate: '2024-01-01', endDate: '2024-12-31' }),
    (error) => error.status === 401 && error.sessionExpired === true
  );
});

test('numbers colliding filenames deterministically, preserving the extension', () => {
  const { disambiguateFilenames } = loadHelpers();

  const documents = disambiguateFilenames([
    { filename: 'Wealthfront/A/Tax-Forms/2023_Form-1099.pdf' },
    { filename: 'Wealthfront/A/Tax-Forms/2023_Form-1099.pdf' },
    { filename: 'Wealthfront/A/Tax-Forms/2023_Form-1099.xls' },
  ]);

  assert.deepEqual(documents.map((d) => d.filename), [
    'Wealthfront/A/Tax-Forms/2023_Form-1099.pdf',
    'Wealthfront/A/Tax-Forms/2023_Form-1099-2.pdf',
    'Wealthfront/A/Tax-Forms/2023_Form-1099.xls',
  ]);
});

test('only claims the Wealthfront documents page', () => {
  const provider = loadProvider();

  assert.equal(provider.matches('https://www.wealthfront.com/documents'), true);
  // dashboard.wealthfront.com does not serve the app and had a mismatched cert.
  assert.equal(provider.matches('https://dashboard.wealthfront.com/documents'), false);
  assert.equal(provider.matches('https://www.wealthfront.com/login'), false);
});
