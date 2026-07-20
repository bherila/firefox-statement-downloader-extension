'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const runtimePath = require.resolve('../core/runtime.js');
const providerPath = require.resolve('../providers/fidelity.js');

function loadProvider() {
  global.FinancialStatementDownloader = undefined;
  delete require.cache[runtimePath];
  delete require.cache[providerPath];
  require(runtimePath);
  require(providerPath);
  return global.FinancialStatementDownloader.providers.fidelity;
}

function loadHelpers() {
  return loadProvider().helpers;
}

// Minimal stand-ins for the two real payload shapes, trimmed to the fields the
// provider actually reads.
function accountsPayload() {
  return {
    acctDetails: {
      acctDetail: [
        {
          acctNum: '100000001',
          acctType: 'Brokerage',
          acctSubTypeDesc: 'Brokerage Retirement Individual',
          preferenceDetail: { name: 'Roth IRA', defaultAcctName: 'IRA - Roth' },
        },
        {
          acctNum: '100000009',
          acctType: 'WPS',
          preferenceDetail: { defaultAcctName: 'Workplace Savings' },
        },
        { acctNum: '100000008', acctType: 'Fidelity Credit Card' },
      ],
    },
  };
}

function listPayload(docs) {
  return { statement: { docDetails: { docDetail: docs } } };
}

function installFetch(handler) {
  global.fetch = handler;
}

test.afterEach(() => {
  delete global.fetch;
  delete global.atob;
  delete global.FinancialStatementDownloader;
  delete require.cache[runtimePath];
  delete require.cache[providerPath];
});

test('sanitizes path segments without leaving separators or empty names', () => {
  const { sanitizeSegment } = loadHelpers();

  assert.equal(sanitizeSegment('Roth IRA', 'x'), 'Roth-IRA');
  assert.equal(sanitizeSegment('Brokerage/Link: 401k', 'x'), 'Brokerage-Link-401k');
  assert.equal(sanitizeSegment('   ', 'fallback'), 'fallback');
  assert.equal(sanitizeSegment(null, 'fallback'), 'fallback');
  // Nothing may survive that could escape the download directory.
  assert.ok(!sanitizeSegment('../../etc/passwd', 'x').includes('/'));
});

test('converts Fidelity epoch seconds to a stable ISO date', () => {
  const { toIsoDate } = loadHelpers();

  assert.equal(toIsoDate(1703998800), '2023-12-31');
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate(undefined), null);
});

test('rejects date ranges that are not YYYY-MM-DD', () => {
  const { assertDateString } = loadHelpers();

  assert.equal(assertDateString('2024-01-01', 'startDate'), '2024-01-01');
  assert.throws(() => assertDateString('2024-1-1', 'startDate'), TypeError);
  assert.throws(() => assertDateString('01/01/2024', 'startDate'), TypeError);
  assert.throws(() => assertDateString(undefined, 'startDate'), TypeError);
});

test('normalizes a single docDetail object into an array', () => {
  const { listDocDetails } = loadHelpers();

  assert.deepEqual(listDocDetails(listPayload({ id: 'a' })), [{ id: 'a' }]);
  assert.deepEqual(listDocDetails(listPayload([{ id: 'a' }, { id: 'b' }])).length, 2);
  assert.deepEqual(listDocDetails({}), []);
});

test('files per-account documents under a friendly account folder', () => {
  const { buildDocument, collectAccounts } = loadHelpers();
  const index = new Map(collectAccounts(accountsPayload()).map((account) => [
    account.acctNum,
    {
      acctNum: account.acctNum,
      acctType: account.acctType,
      label: (account.preferenceDetail || {}).name
        || (account.preferenceDetail || {}).defaultAcctName
        || account.acctSubTypeDesc,
    },
  ]));

  const document = buildDocument({
    id: 'abc',
    type: 'PI Monthly/Quarterly Statement',
    isHouseholded: false,
    acctNum: '100000001',
    periodEndDate: 1703998800,
  }, 'STMT', index);

  assert.equal(document.filename, 'Fidelity/Roth-IRA-100000001/2023-12-31_PI-Monthly-Quarterly-Statement.pdf');
  assert.equal(document.metadata.acctType, 'Brokerage');
  assert.equal(document.metadata.isHouseholded, false);
});

test('files householded documents separately and downloads them as Brokerage', () => {
  const { buildDocument } = loadHelpers();

  const document = buildDocument({
    id: 'xyz',
    type: 'PI Year End Investment Report',
    isHouseholded: true,
    householdNum: 'M10000012',
    periodEndDate: 1703998800,
  }, 'STMT', new Map());

  assert.ok(document.filename.startsWith('Fidelity/Household/'));
  // The download endpoint rejects every acctType except Brokerage for these.
  assert.equal(document.metadata.acctType, 'Brokerage');
  assert.equal(document.metadata.acctNum, null);
});

test('still downloads a document whose account is missing from the index', () => {
  const { buildDocument } = loadHelpers();

  const document = buildDocument({
    id: 'orphan',
    type: 'Trade Confirm',
    isHouseholded: false,
    acctNum: '999999999',
    periodEndDate: 1703998800,
  }, 'TC', new Map());

  // Losing the friendly folder name is acceptable; dropping the document is not.
  assert.ok(document.filename.includes('999999999'));
  assert.equal(document.metadata.acctType, 'Brokerage');
});

test('keeps household and per-account copies of the same period as distinct documents', async () => {
  const provider = loadProvider();
  const shared = { type: 'PI Year End Investment Report', periodEndDate: 1703998800 };

  installFetch(async (url) => {
    if (url.includes('customer-am-acctnxt')) {
      return { ok: true, status: 200, json: async () => accountsPayload() };
    }
    if (url.includes('financial-documents/statements')) {
      return {
        ok: true,
        status: 200,
        json: async () => listPayload([
          { id: 'household-1', isHouseholded: true, householdNum: 'M1', ...shared },
          { id: 'account-1', isHouseholded: false, acctNum: '100000001', ...shared },
        ]),
      };
    }
    throw new Error(`unexpected url ${url}`);
  });

  const documents = await provider.discoverDocuments({
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    docTypes: ['STMT'],
  });

  assert.equal(documents.length, 2);
  assert.notEqual(documents[0].filename, documents[1].filename);
});

test('deduplicates repeated document ids across doc type sweeps', async () => {
  const provider = loadProvider();

  installFetch(async (url) => {
    if (url.includes('customer-am-acctnxt')) {
      return { ok: true, status: 200, json: async () => accountsPayload() };
    }
    return {
      ok: true,
      status: 200,
      json: async () => listPayload([
        { id: 'same-id', isHouseholded: false, acctNum: '100000001', type: 'Doc', periodEndDate: 1703998800 },
      ]),
    };
  });

  // AR and AC routinely return overlapping records for the same customer.
  const documents = await provider.discoverDocuments({
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    docTypes: ['AR', 'AC'],
  });

  assert.equal(documents.length, 1);
});

test('rejects an inverted date range before issuing any request', async () => {
  const provider = loadProvider();
  let called = false;
  installFetch(async () => {
    called = true;
    throw new Error('should not be reached');
  });

  await assert.rejects(
    () => provider.discoverDocuments({ startDate: '2024-12-31', endDate: '2024-01-01' }),
    RangeError
  );
  assert.equal(called, false);
});

test('flags an expired session distinctly from a transient failure', async () => {
  const provider = loadProvider();
  installFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }));

  await assert.rejects(
    () => provider.discoverDocuments({ startDate: '2024-01-01', endDate: '2024-12-31' }),
    (error) => error.status === 403 && error.sessionExpired === true
  );
});

test('sends the application identity headers the API requires', async () => {
  const provider = loadProvider();
  const seen = [];
  installFetch(async (url, init) => {
    seen.push(init.headers);
    if (url.includes('customer-am-acctnxt')) {
      return { ok: true, status: 200, json: async () => accountsPayload() };
    }
    return { ok: true, status: 200, json: async () => listPayload([]) };
  });

  await provider.discoverDocuments({ startDate: '2024-01-01', endDate: '2024-12-31', docTypes: ['STMT'] });

  // Without these the endpoints answer 400 rather than 401, which is easy to
  // misdiagnose as a malformed body.
  assert.ok(seen.length > 0);
  for (const headers of seen) {
    assert.equal(headers.appid, 'AP160308');
    assert.equal(headers['fid-originating-app-id'], 'AP160308');
  }
});

test('decodes base64 content and returns bytes rather than a URL', async () => {
  const provider = loadProvider();
  const pdfBytes = Buffer.from('%PDF-1.4\nhello');
  global.atob = (value) => Buffer.from(value, 'base64').toString('binary');

  installFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      document: {
        docDetail: {
          contentType: 'application/pdf',
          content: pdfBytes.toString('base64'),
          encoding: 'Base64',
          deflated: 'Y',
        },
      },
    }),
  }));

  const outcome = await provider.downloadDocument({
    provider: 'fidelity',
    id: 'abc',
    filename: 'Fidelity/Roth-IRA/2024-01-01_Statement.pdf',
    metadata: { docType: 'STMT', acctType: 'Brokerage' },
  });

  assert.ok(outcome.data instanceof Uint8Array);
  assert.equal(Buffer.from(outcome.data).toString(), '%PDF-1.4\nhello');
  assert.equal(outcome.url, undefined);
});

test('refuses to save a response whose bytes are not a PDF', async () => {
  const provider = loadProvider();
  global.atob = (value) => Buffer.from(value, 'base64').toString('binary');

  installFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      document: {
        docDetail: {
          contentType: 'application/pdf',
          // deflated:"Y" is set even on plain PDFs, so the flag cannot be
          // trusted; an HTML error page must not be written out as a .pdf.
          content: Buffer.from('<html>error</html>').toString('base64'),
          deflated: 'Y',
        },
      },
    }),
  }));

  await assert.rejects(
    () => provider.downloadDocument({
      provider: 'fidelity',
      id: 'abc',
      filename: 'x.pdf',
      metadata: { docType: 'STMT', acctType: 'Brokerage' },
    }),
    /not a PDF/
  );
});

test('only claims the Fidelity document center pages', () => {
  const provider = loadProvider();

  assert.equal(provider.matches('https://digitalservices.fidelity.com/navigate/ent-documentcenter/statements'), true);
  assert.equal(provider.matches('https://digitalservices.fidelity.com/navigate/ent-documentcenter/tax-forms'), true);
  // Employer documents live on a different origin with its own auth.
  assert.equal(provider.matches('https://workplaceservices.fidelity.com/mybenefits/savings2/'), false);
  assert.equal(provider.matches('https://digital.fidelity.com/ftgw/digital/portfolio/documents'), false);
});

test('files customer-level records without an account under their own folder', () => {
  const { buildDocument } = loadHelpers();

  // Account records such as name changes carry neither acctNum nor a household
  // flag; the site's own table omits the Account column for them.
  const document = buildDocument({
    id: 'ar-1',
    type: 'Customer Name Change',
    isHouseholded: false,
    periodEndDate: 1512709200,
  }, 'AR', new Map());

  assert.ok(document.filename.startsWith('Fidelity/Customer-Records/'));
  assert.equal(document.metadata.scope, 'customer');
  assert.equal(document.metadata.acctType, 'Brokerage');
});

test('classifies the three document scopes distinctly', () => {
  const { resolveScope } = loadHelpers();
  const index = new Map([['1', { acctNum: '1', acctType: 'WPS', label: 'Workplace' }]]);

  assert.equal(resolveScope({ isHouseholded: true }, index).scope, 'household');
  assert.equal(resolveScope({ isHouseholded: false }, index).scope, 'customer');
  assert.equal(resolveScope({ isHouseholded: false, acctNum: '1' }, index).scope, 'account');
  // A closed account is absent from the index but its documents still resolve.
  assert.equal(resolveScope({ isHouseholded: false, acctNum: '99' }, index).folder, '99');
});

test('numbers colliding filenames deterministically rather than relying on the browser', () => {
  const { disambiguateFilenames } = loadHelpers();

  const documents = disambiguateFilenames([
    { filename: 'Fidelity/Customer-Records/2017-12-08_Customer-Name-Change.pdf' },
    { filename: 'Fidelity/Customer-Records/2017-12-08_Customer-Name-Change.pdf' },
    { filename: 'Fidelity/Customer-Records/2017-12-08_Customer-Name-Change.pdf' },
    { filename: 'Fidelity/Household/2017-12-31_Report.pdf' },
  ]);

  assert.deepEqual(documents.map((d) => d.filename), [
    'Fidelity/Customer-Records/2017-12-08_Customer-Name-Change.pdf',
    'Fidelity/Customer-Records/2017-12-08_Customer-Name-Change-2.pdf',
    'Fidelity/Customer-Records/2017-12-08_Customer-Name-Change-3.pdf',
    'Fidelity/Household/2017-12-31_Report.pdf',
  ]);
});

test('maps a date range onto the tax years it spans, newest first', () => {
  const { taxYearsInRange } = loadHelpers();

  assert.deepEqual(taxYearsInRange('2022-06-01', '2025-02-01'), ['2025', '2024', '2023', '2022']);
  assert.deepEqual(taxYearsInRange('2024-01-01', '2024-12-31'), ['2024']);
});

test('files a single-account tax form under that account using its nickname', () => {
  const { buildTaxDocument } = loadHelpers();

  const document = buildTaxDocument({
    docName: 'Consolidated Form 1099',
    acctDetails: { acctDetail: [{ nickname: 'Taxable Individual', acctNum: 'X10000011', acctType: 'Brokerage' }] },
    docDetail: { docId: 'tax-1', docType: '7154', docGeneratedDate: 1744606800 },
  }, '2024');

  assert.equal(document.filename, 'Fidelity/Taxable-Individual-X10000011/2024_Consolidated-Form-1099.pdf');
  assert.equal(document.metadata.scope, 'account');
  assert.equal(document.metadata.taxYear, '2024');
  // The listing's numeric docType identifies the form; the download endpoint
  // still expects STMT.
  assert.equal(document.metadata.docType, 'STMT');
  assert.equal(document.metadata.formCode, '7154');
});

test('files a tax form covering several accounts outside any account folder', () => {
  const { buildTaxDocument } = loadHelpers();

  const document = buildTaxDocument({
    docName: 'Consolidated Form 1099',
    acctDetails: {
      acctDetail: [
        { nickname: 'A', acctNum: '1', acctType: 'Brokerage' },
        { nickname: 'B', acctNum: '2', acctType: 'Brokerage' },
      ],
    },
    docDetail: { docId: 'tax-2', docGeneratedDate: 1744606800 },
  }, '2024');

  assert.ok(document.filename.startsWith('Fidelity/Tax-Forms/'));
  assert.equal(document.metadata.scope, 'tax');
  assert.equal(document.metadata.acctNum, null);
});

test('normalizes a single tax form detail object into an array', () => {
  const { listTaxFormDetails, taxFormAccounts } = loadHelpers();

  assert.equal(listTaxFormDetails({ taxSeason: { taxFormDetails: { taxFormDetail: { docName: 'x' } } } }).length, 1);
  assert.deepEqual(listTaxFormDetails({}), []);
  assert.equal(taxFormAccounts({ acctDetails: { acctDetail: { acctNum: '1' } } }).length, 1);
  assert.deepEqual(taxFormAccounts({}), []);
});

test('skips tax forms for a season that has not been issued yet', async () => {
  const provider = loadProvider();

  installFetch(async (url) => {
    if (url.includes('customer-am-acctnxt')) {
      return { ok: true, status: 200, json: async () => accountsPayload() };
    }
    if (url.includes('taxform')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          taxSeason: {
            taxFormDetails: {
              taxFormDetail: [
                // Listed for the current season but not yet generated.
                { docName: 'Pending 1099', isDocAvail: false, docDetail: { docId: 'pending' } },
                { docName: 'Form 5498', isDocAvail: true, docDetail: { docId: 'ready', docGeneratedDate: 1744606800 },
                  acctDetails: { acctDetail: [{ nickname: 'Roth IRA', acctNum: '100000001', acctType: 'Brokerage' }] } },
              ],
            },
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => listPayload([]) };
  });

  const documents = await provider.discoverDocuments({
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    docTypes: ['TAX'],
  });

  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, 'ready');
});
