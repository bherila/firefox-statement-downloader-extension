'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const runtimePath = require.resolve('../core/runtime.js');
const storagePath = require.resolve('../core/storage.js');
const providerPath = require.resolve('../providers/meritain.js');

function installPageContext() {
  const values = {};
  global.browser = {
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested
            .filter((key) => Object.prototype.hasOwnProperty.call(values, key))
            .map((key) => [key, values[key]]));
        },
        async set(next) {
          Object.assign(values, next);
        },
      },
    },
  };
  global.document = {
    querySelector(selector) {
      if (selector === '[name="__RequestVerificationToken"]') return { value: 'synthetic-csrf-token' };
      return null;
    },
    querySelectorAll() { return []; },
    scripts: [{ textContent: 'var apiMemberParameters = {"MemberId":"2000001","GroupId":"100000001","DepNo":0};' }],
  };
  global.location = { href: 'https://connect.meritain.com/Member/MemberClaim/ClaimSummary' };
}

function loadProvider() {
  global.FinancialStatementDownloader = undefined;
  installPageContext();
  delete require.cache[runtimePath];
  delete require.cache[storagePath];
  delete require.cache[providerPath];
  require(runtimePath);
  require(storagePath);
  require(providerPath);
  return global.FinancialStatementDownloader.providers.meritain;
}

function serializedResponse(payload) {
  return { ok: true, status: 200, json: async () => JSON.stringify(payload) };
}

function tokenResponse() {
  return { ok: true, status: 200, json: async () => ({ token: 'synthetic-api-token', expiration: 300 }) };
}

function summaryPayload(rows, total = rows.length) {
  return { Data: rows, TotalRecords: total, TotalDisplayRecords: total };
}

function detailPayload(claimType = 'Medical') {
  return {
    Entity: {
      ClaimNumber: 'CLAIM-1',
      DepNo: 0,
      PlanProductType: claimType,
      IsDocumentAvailable: true,
      AssociatedDocuments: [{ PlanDocumentType: 'EOB', IsDocumentAvailable: true }],
    },
  };
}

function installFetch(handler) {
  global.fetch = handler;
}

test.afterEach(() => {
  delete global.fetch;
  delete global.document;
  delete global.location;
  delete global.browser;
  delete global.FinancialStatementDownloader;
  delete require.cache[runtimePath];
  delete require.cache[storagePath];
  delete require.cache[providerPath];
});

test('builds Meritain form fields with repeated claim types and 15-record pages', () => {
  const { buildSummaryFields } = loadProvider().helpers;
  const fields = buildSummaryFields({ groupId: '100000001', memberId: '2000001', depNo: '0' }, {
    all: false,
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    docTypes: ['Medical', 'Rx'],
  }, 15);

  assert.deepEqual(fields['ClaimTypes[]'], ['Medical', 'Rx']);
  assert.deepEqual(fields['ClaimStatus[]'], ['Inprocess', 'Processed', 'Awaitinginformation']);
  assert.equal(fields['RecordSetInformation[RecordSetStartingRecord]'], 15);
  assert.equal(fields['RecordSetInformation[RecordSetMaxCount]'], 15);
  assert.equal(fields.ServiceFromDate, '01/01/2024');
  assert.equal(fields.ServiceToDate, '12/31/2024');
});

test('normalizes dates and preserves the existing EOB filename convention', () => {
  const { buildDocument, toIsoDate } = loadProvider().helpers;

  assert.equal(toIsoDate('01/09/2024'), '2024-01-09');
  assert.equal(toIsoDate('2024-01-09'), '2024-01-09');
  assert.equal(toIsoDate('not-a-date'), null);

  const document = buildDocument({
    ClaimNumber: 'CLAIM-1',
    ClaimType: 'Rx',
    ServiceFromDate: '01/09/2024',
  }, { groupId: '100000001', memberId: '2000001', depNo: '0' });

  assert.equal(document.id, '100000001:2000001:0:Rx:CLAIM-1');
  assert.equal(document.title, 'Rx EOB (2024-01-09)');
  assert.equal(document.filename, 'Acct.EOB.Meritain/EOB_CLAIM-1.pdf');
  assert.equal(document.metadata.claimType, 'Rx');
});

test('paginates until the server-reported total and filters selected types', async () => {
  const provider = loadProvider();
  const requests = [];
  const waits = [];
  const rows = Array.from({ length: 16 }, (_, index) => ({
    ClaimNumber: `CLAIM-${index + 1}`,
    ClaimType: index === 15 ? 'Rx' : 'Medical',
    ServiceFromDate: '01/09/2024',
  }));
  installFetch(async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/Account/GetToken')) return tokenResponse();
    if (url.endsWith('/api/claims/summary')) {
      const start = Number(new URLSearchParams(init.body).get('RecordSetInformation[RecordSetStartingRecord]'));
      return serializedResponse(summaryPayload(start === 0 ? rows.slice(0, 15) : rows.slice(15), rows.length));
    }
    throw new Error(`unexpected URL ${url}`);
  });

  const documents = await provider.discoverDocuments({
    all: false,
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    docTypes: ['Medical'],
    paginationDelayMs: 100,
    jitterRatio: 0,
    sleep: async (milliseconds) => waits.push(milliseconds),
  });

  assert.equal(documents.length, 15);
  const summaryRequests = requests.filter((request) => request.url.endsWith('/api/claims/summary'));
  assert.equal(summaryRequests.length, 2);
  assert.equal(new URLSearchParams(summaryRequests[1].init.body).get('RecordSetInformation[RecordSetStartingRecord]'), '15');
  assert.equal(new URLSearchParams(summaryRequests[0].init.body).get('ServiceFromDate'), '01/01/2024');
  assert.deepEqual(waits, [100]);
});

test('rejects a short claims page that disagrees with the reported total', async () => {
  const provider = loadProvider();
  const rows = Array.from({ length: 10 }, (_, index) => ({
    ClaimNumber: `CLAIM-${index + 1}`,
    ClaimType: 'Medical',
    ServiceFromDate: '01/09/2024',
  }));
  installFetch(async (url) => {
    if (url.endsWith('/Account/GetToken')) return tokenResponse();
    if (url.endsWith('/api/claims/summary')) return serializedResponse(summaryPayload(rows, 40));
    throw new Error(`unexpected URL ${url}`);
  });

  await assert.rejects(
    provider.discoverDocuments({ all: true, docTypes: ['Medical'], paginationDelayMs: 0 }),
    /incomplete claims page \(10 of 40 records\)/,
  );
});

test('reserves generated filenames when disambiguating collisions', () => {
  const { disambiguateFilenames } = loadProvider().helpers;
  const documents = [
    { filename: 'Acct.EOB.Meritain/EOB_CLAIM.pdf' },
    { filename: 'Acct.EOB.Meritain/EOB_CLAIM.pdf' },
    { filename: 'Acct.EOB.Meritain/EOB_CLAIM-2.pdf' },
  ];

  assert.deepEqual(
    disambiguateFilenames(documents).map((document) => document.filename),
    [
      'Acct.EOB.Meritain/EOB_CLAIM.pdf',
      'Acct.EOB.Meritain/EOB_CLAIM-3.pdf',
      'Acct.EOB.Meritain/EOB_CLAIM-2.pdf',
    ],
  );
});

test('imports existing EOB filenames and seeds matching completion state', async () => {
  const provider = loadProvider();
  const result = await provider.helpers.importExistingFiles([
    { name: 'EOB_CLAIM-1.pdf' },
    { name: 'notes.txt' },
    { name: 'EOB_CLAIM-1.pdf' },
  ]);
  assert.deepEqual(result, { selected: 3, recognized: 1, added: 1, total: 1, ignored: 1 });

  installFetch(async (url) => {
    if (url.endsWith('/Account/GetToken')) return tokenResponse();
    if (url.endsWith('/api/claims/summary')) {
      return serializedResponse(summaryPayload([{
        ClaimNumber: 'CLAIM-1',
        ClaimType: 'Medical',
        ServiceFromDate: '01/09/2024',
      }]));
    }
    throw new Error(`unexpected URL ${url}`);
  });
  const [document] = await provider.discoverDocuments({
    all: true,
    docTypes: ['Medical'],
    paginationDelayMs: 0,
  });

  const providerStorage = global.FinancialStatementDownloader.createProviderStorage('meritain');
  assert.equal(await providerStorage.isDone(document), true);

  global.document.scripts[0].textContent = 'var apiMemberParameters = {"MemberId":"EXAMPLE MEMBER","GroupId":"EXAMPLE GROUP","DepNo":0};';
  const [otherMemberDocument] = await provider.discoverDocuments({
    all: true,
    docTypes: ['Medical'],
    paginationDelayMs: 0,
  });
  assert.notEqual(otherMemberDocument.id, document.id);
  assert.equal(await providerStorage.isDone(otherMemberDocument), false);
});

test('treats a forbidden response as terminal without refreshing or retrying', async () => {
  const provider = loadProvider();
  const requests = [];
  installFetch(async (url) => {
    requests.push(url);
    if (url.endsWith('/Account/GetToken')) return tokenResponse();
    if (url.endsWith('/api/claims/details')) return { ok: false, status: 403 };
    throw new Error(`unexpected URL ${url}`);
  });

  await assert.rejects(
    provider.downloadDocument({
      title: 'Medical EOB (2024-01-09)',
      filename: 'Acct.EOB.Meritain/EOB_CLAIM-1.pdf',
      metadata: { claimNumber: 'CLAIM-1', claimType: 'Medical', depNo: '0' },
    }),
    (error) => error.status === 403 && error.blocked === true && error.sessionExpired === false,
  );
  assert.equal(requests.filter((url) => url.endsWith('/Account/GetToken')).length, 1);
  assert.equal(requests.filter((url) => url.endsWith('/api/claims/details')).length, 1);
});

test('uses the page token and downloads a PDF through the Meritain API contract', async () => {
  const provider = loadProvider();
  const requests = [];
  installFetch(async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/Account/GetToken')) return tokenResponse();
    if (url.endsWith('/api/claims/details')) return serializedResponse(detailPayload('Medical'));
    if (url.endsWith('/Claim/DownloadDocument')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([37, 80, 68, 70, 45, 49]).buffer,
      };
    }
    throw new Error(`unexpected URL ${url}`);
  });

  const outcome = await provider.downloadDocument({
    title: 'Medical EOB (2024-01-09)',
    filename: 'Acct.EOB.Meritain/EOB_CLAIM-1.pdf',
    metadata: { claimNumber: 'CLAIM-1', claimType: 'Medical', depNo: '0' },
  });

  assert.deepEqual(outcome.data, [37, 80, 68, 70, 45, 49]);
  assert.equal(outcome.contentType, 'application/pdf');
  const download = requests.find((request) => request.url.endsWith('/Claim/DownloadDocument'));
  assert.equal(download.init.headers.Authorization, 'Bearer synthetic-api-token');
  assert.deepEqual(JSON.parse(download.init.body), {
    ClaimDocumentType: 'EOB',
    ClaimNumber: 'CLAIM-1',
    PlanProductType: 'Medical',
    DepNo: 0,
    MemberID: '2000001',
  });
});

test('recognizes the Meritain claims summary page only', () => {
  const provider = loadProvider();

  assert.equal(provider.matches('https://connect.meritain.com/Member/MemberClaim/ClaimSummary'), true);
  assert.equal(provider.matches('https://connect.meritain.com/Member/MemberClaim/ClaimSummary?x=1'), true);
  assert.equal(provider.matches('https://account.meritain.com/portal'), false);
  assert.equal(provider.matches('https://connect.meritain.com/Member/MemberClaim/Other'), false);
});
