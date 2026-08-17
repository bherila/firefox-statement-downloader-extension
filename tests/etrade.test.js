'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const runtimePath = require.resolve('../core/runtime.js');
const storagePath = require.resolve('../core/storage.js');
const providerPath = require.resolve('../providers/etrade.js');
const originalAtob = global.atob;

function metadataPayload() {
  const documentMetaDataList = [
    ['ClientStatements', 'Statements'],
    ['TradeConfirmations', 'Trade Confirmations'],
    ['TaxDocuments', 'Tax Documents'],
    ['GeneralCorrespondence', 'General Correspondence'],
  ].map(([documentTypeName, displayValue]) => ({
    documentTypeName,
    displayValue,
    documentSubTypeList: [],
  }));
  return {
    accountList: [{
      keyAccount: 'EXAMPLE_ACCOUNT',
      accountDisplayValue: 'Example Brokerage',
      accountType: 'single',
    }],
    documentMetaDataList,
    docTypeDateFilterList: [
      {
        docTypes: ['ClientStatements', 'TradeConfirmations', 'GeneralCorrespondence'],
        dateFilters: ['2025', '2024', '2023'].map((dateFilterName) => ({ dateFilterName })),
      },
      {
        docTypes: ['TaxDocuments'],
        dateFilters: ['2026', '2025', '2024'].map((dateFilterName) => ({ dateFilterName })),
      },
    ],
  };
}

function rawDocument(index, docType = 'TradeConfirmations') {
  return {
    documentDate: `2024-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00`,
    documentLoadDate: docType === 'TaxDocuments' ? '2024-02-10T00:00:00' : null,
    documentId: `doc-${index}`,
    documentTitle: docType === 'GeneralCorrespondence' ? 'Important Notice' : 'Document',
    documentTypeName: docType,
    keyAccountNo: 'EXAMPLE_ACCOUNT',
    optionalAttributeList: docType === 'TradeConfirmations'
      ? [
        { fieldName: 'ActionType', displayValue: 'Buy' },
        { fieldName: 'Symbol', displayValue: 'EXM' },
      ]
      : [],
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function installBrowser() {
  const stored = {};
  global.browser = {
    storage: {
      local: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((item) => Object.hasOwn(stored, item))
            .map((item) => [item, stored[item]]));
        },
        async set(values) { Object.assign(stored, values); },
      },
    },
  };
  return stored;
}

function installPageSession() {
  global.wrappedJSObject = {
    pageConfig: { uaa_vt: 'synthetic-page-session' },
    getDeviceFootPrint() {
      return { DeviceFootPrint: 'synthetic-device' };
    },
  };
}

function tokenPayload() {
  return {
    access_token: 'synthetic-access-token',
    access_token_expires_at: Date.now() + 300000,
  };
}

function loadProvider() {
  global.FinancialStatementDownloader = undefined;
  for (const path of [runtimePath, storagePath, providerPath]) delete require.cache[path];
  require(runtimePath);
  require(storagePath);
  require(providerPath);
  return global.FinancialStatementDownloader.providers.etrade;
}

test.beforeEach(() => {
  installBrowser();
  installPageSession();
});

test.afterEach(() => {
  delete global.fetch;
  delete global.browser;
  delete global.wrappedJSObject;
  delete global.FinancialStatementDownloader;
  global.atob = originalAtob;
  for (const path of [runtimePath, storagePath, providerPath]) delete require.cache[path];
});

test('registers the E*TRADE page, API permission, and provider script', () => {
  const manifest = require('../manifest.json');
  assert.ok(manifest.permissions.includes('https://ext-web.etrade.com/*'));
  assert.ok(manifest.content_scripts[0].matches.includes('https://us.etrade.com/etx/pxy/accountdocs*'));
  assert.ok(manifest.content_scripts[0].js.includes('providers/etrade.js'));

  const provider = loadProvider();
  assert.equal(provider.matches('https://us.etrade.com/etx/pxy/accountdocs#/documents'), true);
  assert.equal(provider.matches('https://us.etrade.com/etx/pxy/portfolio'), false);
});

test('derives each document type year list from metadata', () => {
  const { availableYears, allAvailableYears } = loadProvider().helpers;
  const metadata = metadataPayload();

  assert.deepEqual(availableYears(metadata, 'TradeConfirmations'), ['2025', '2024', '2023']);
  assert.deepEqual(availableYears(metadata, 'TaxDocuments'), ['2026', '2025', '2024']);
  assert.deepEqual(allAvailableYears(metadata), ['2026', '2025', '2024', '2023']);
});

test('waits for the E*TRADE page session and device runtime to become ready', async () => {
  let readinessChecks = 0;
  global.wrappedJSObject = {};
  global.fetch = async (url) => (
    url.includes('/oauth2/token') ? jsonResponse(tokenPayload()) : jsonResponse(metadataPayload())
  );
  const provider = loadProvider();
  global.FinancialStatementDownloader.sleep = async () => {
    readinessChecks += 1;
    if (readinessChecks === 2) installPageSession();
  };

  const state = await provider.loadState();

  assert.equal(readinessChecks, 2);
  assert.deepEqual(state.metadata.accountList, metadataPayload().accountList);
});

test('bootstraps and caches a scoped access token without persisting session material', async () => {
  const provider = loadProvider();
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(tokenPayload());
  };

  assert.equal(await provider.helpers.accessToken(), 'synthetic-access-token');
  assert.equal(await provider.helpers.accessToken(), 'synthetic-access-token');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, provider.helpers.TOKEN_URL);
  assert.equal(requests[0].init.credentials, 'include');
  assert.equal(requests[0].init.headers.stk1, 'synthetic-page-session');
  assert.deepEqual(JSON.parse(requests[0].init.body), { scope: ['accountdocuments'] });
  assert.deepEqual(provider.helpers.deviceHeaders(true), {
    'X-Device-Footprint': 'synthetic-device',
  });
});

test('collects every page for a year using the all-accounts API filter', async () => {
  const provider = loadProvider();
  const searches = [];
  const requestUrls = [];
  global.fetch = async (url, init) => {
    if (url.includes('/oauth2/token')) return jsonResponse(tokenPayload());
    requestUrls.push(url);
    if (url.includes('/usermetadata?')) return jsonResponse(metadataPayload());
    const body = JSON.parse(init.body);
    searches.push({ body, headers: init.headers });
    const start = body.pageNum === '1' ? 1 : 51;
    const end = body.pageNum === '1' ? 50 : 70;
    return jsonResponse({
      numFound: '70',
      defaultDocumentList: Array.from({ length: end - start + 1 }, (_, offset) => (
        rawDocument(start + offset)
      )),
    });
  };

  const documents = await provider.discoverDocuments({
    fromYear: '2024',
    toYear: '2024',
    docTypes: ['TradeConfirmations'],
    paginationDelayMs: 0,
  });

  assert.equal(documents.length, 70);
  assert.deepEqual(searches.map((entry) => entry.body.pageNum), ['1', '2']);
  assert.deepEqual(searches[0].body.filters, [
    { filterName: 'KeyAccountNo', values: ['All'] },
    { filterName: 'DocType', values: ['TradeConfirmations'] },
    { filterName: 'DocSubType', values: ['All'] },
  ]);
  assert.equal(searches[0].headers.Authorization, 'Bearer synthetic-access-token');
  assert.equal(searches[0].headers['X-Device-Footprint'], 'synthetic-device');
  assert.match(documents[0].filename, /^ETrade\/Example-Brokerage\/Trade-Confirmations\/2024\/2024-01-\d{2}_Buy-EXM_[0-9a-f]{8}\.pdf$/);
  for (const requestUrl of requestUrls) {
    const parsed = new URL(requestUrl);
    assert.match(parsed.searchParams.get('RequestID'), /^[0-9a-f-]{39}$/);
    assert.match(parsed.searchParams.get('SeqID'), /^\d{4}$/);
  }
});

test('rejects a paginated result that does not contain the reported unique documents', async () => {
  const provider = loadProvider();
  global.fetch = async (url) => (
    url.includes('/oauth2/token')
      ? jsonResponse(tokenPayload())
      : url.includes('/usermetadata?')
      ? jsonResponse(metadataPayload())
      : jsonResponse({ numFound: '2', defaultDocumentList: [rawDocument(1), rawDocument(1)] })
  );

  await assert.rejects(() => provider.discoverDocuments({
    fromYear: '2024',
    toYear: '2024',
    docTypes: ['TradeConfirmations'],
    paginationDelayMs: 0,
  }), /reported 2 documents but returned 1 unique document/);
});

test('uses tax load dates, segment metadata, and a collision-resistant filename', () => {
  const { accountIndex, buildDocument } = loadProvider().helpers;
  const raw = rawDocument(1, 'TaxDocuments');
  raw.optionalAttributeList = [
    { fieldName: 'AdditionalInformation', displayValue: 'Form 1099' },
    { fieldName: 'Sequence', displayValue: '1' },
    { fieldName: 'TotalSegments', displayValue: '2' },
  ];

  const document = buildDocument(raw, accountIndex(metadataPayload()));
  assert.equal(document.date, '2024-02-10');
  assert.equal(document.metadata.docSeq, '1');
  assert.equal(document.metadata.totalSeq, '2');
  assert.match(document.filename, /^ETrade\/Example-Brokerage\/Tax-Forms\/2024\/2024-02-10_Form-1099_[0-9a-f]{8}\.pdf$/);
});

test('downloads the category endpoint and returns validated PDF bytes', async () => {
  const provider = loadProvider();
  const pdf = Buffer.from('%PDF-1.7\nexample');
  let captured;
  global.atob = (value) => Buffer.from(value, 'base64').toString('binary');
  global.fetch = async (url, init) => {
    if (url.includes('/oauth2/token')) return jsonResponse(tokenPayload());
    captured = { url, body: JSON.parse(init.body) };
    return jsonResponse({ documentStream: pdf.toString('base64'), fileName: 'Document.pdf' });
  };

  const outcome = await provider.downloadDocument({
    title: '2024-01-12 correspondence',
    filename: 'ETrade/Example-Brokerage/Correspondence/2024/2024-01-12_Notice.pdf',
    metadata: {
      docType: 'GeneralCorrespondence',
      documentId: 'doc-example',
      keyAccountNo: 'EXAMPLE_ACCOUNT',
      date: '2024-01-12T00:00:00',
      docSeq: '0',
      totalSeq: '0',
    },
  });

  assert.match(captured.url, /\/document\/GeneralCorrespondence\.pdf\?/);
  assert.deepEqual(captured.body, {
    docDetails: [{
      date: '2024-01-12T00:00:00',
      documentId: 'doc-example',
      keyAccountNo: 'EXAMPLE_ACCOUNT',
    }],
    docSeq: '0',
    docType: 'GeneralCorrespondence',
    fileType: 'pdf',
    totalSeq: '0',
  });
  assert.equal(Buffer.from(outcome.data).toString(), '%PDF-1.7\nexample');
  assert.equal(outcome.contentType, 'application/pdf');
});

test('refuses a non-PDF document response', async () => {
  const provider = loadProvider();
  global.atob = (value) => Buffer.from(value, 'base64').toString('binary');
  global.fetch = async (url) => (
    url.includes('/oauth2/token')
      ? jsonResponse(tokenPayload())
      : jsonResponse({
        documentStream: Buffer.from('<html>signed out</html>').toString('base64'),
      })
  );

  await assert.rejects(() => provider.downloadDocument({
    title: 'statement',
    filename: 'ETrade/Example/Statements/2024/statement.pdf',
    metadata: {
      docType: 'ClientStatements',
      documentId: 'doc-example',
      keyAccountNo: 'EXAMPLE_ACCOUNT',
      date: '2024-01-31T00:00:00',
    },
  }), /not a PDF/);
});

test('stops rather than retrying when E*TRADE refuses document traffic', async () => {
  const provider = loadProvider();
  global.fetch = async (url) => (
    url.includes('/oauth2/token')
      ? jsonResponse(tokenPayload())
      : url.includes('/usermetadata?')
        ? jsonResponse(metadataPayload())
        : jsonResponse({}, 429)
  );
  const controller = {
    stopped: false,
    reason: null,
    stop(reason) {
      this.stopped = true;
      this.reason = reason;
    },
  };

  await assert.rejects(() => provider.discoverDocuments({
    fromYear: '2024',
    toYear: '2024',
    docTypes: ['ClientStatements'],
    paginationDelayMs: 0,
  }, null, controller), (error) => error.status === 429 && error.blocked === true);
  assert.equal(controller.stopped, true);
});
