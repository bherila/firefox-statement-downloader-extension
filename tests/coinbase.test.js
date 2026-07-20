'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const providerPath = require.resolve('../providers/coinbase.js');
const runtimePath = require.resolve('../core/runtime.js');
const storagePath = require.resolve('../core/storage.js');

function installProvider({ stored = {}, fetch } = {}) {
  const data = Object.assign({}, stored);
  const messages = [];
  global.FinancialStatementDownloader = undefined;
  global.browser = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => key in data).map((key) => [key, data[key]]));
        },
        async set(values) {
          Object.assign(data, values);
        },
      },
    },
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        return { ok: true, downloadId: 42 };
      },
    },
  };
  global.fetch = fetch || (async () => { throw new Error('unexpected fetch'); });
  delete require.cache[runtimePath];
  require(runtimePath);
  delete require.cache[storagePath];
  require(storagePath);
  delete require.cache[providerPath];
  require(providerPath);
  return {
    provider: global.FinancialStatementDownloader.providers.coinbase,
    data,
    messages,
  };
}

test.afterEach(() => {
  delete global.browser;
  delete global.fetch;
  delete global.FinancialStatementDownloader;
  delete require.cache[providerPath];
  delete require.cache[runtimePath];
  delete require.cache[storagePath];
});

test('discovers normalized account and fill descriptors across a year boundary', async () => {
  const { provider } = installProvider();
  const documents = await provider.discoverDocuments({
    startYear: 2023,
    startMonth: 12,
    endYear: 2024,
    endMonth: 1,
    wantAccount: true,
    wantFills: true,
    delayMs: 1200,
  });

  assert.deepEqual(documents.map((document) => ({
    id: document.id,
    type: document.category,
    date: document.date,
    start: document.metadata.periodStart,
    end: document.metadata.periodEnd,
    filename: document.filename,
  })), [
    {
      id: 'account:2023-12',
      type: 'statements',
      date: '2023-12-01',
      start: '2023-12-01T00:00:00.000Z',
      end: '2023-12-31T00:00:00.000Z',
      filename: 'CoinbaseProStatements/account/2023-12.pdf',
    },
    {
      id: 'fills:2023-12',
      type: 'trade-confirmations',
      date: '2023-12-01',
      start: '2023-12-01T00:00:00.000Z',
      end: '2023-12-31T00:00:00.000Z',
      filename: 'CoinbaseProStatements/fill/2023-12.pdf',
    },
    {
      id: 'account:2024-01',
      type: 'statements',
      date: '2024-01-01',
      start: '2024-01-01T00:00:00.000Z',
      end: '2024-01-31T00:00:00.000Z',
      filename: 'CoinbaseProStatements/account/2024-01.pdf',
    },
    {
      id: 'fills:2024-01',
      type: 'trade-confirmations',
      date: '2024-01-01',
      start: '2024-01-01T00:00:00.000Z',
      end: '2024-01-31T00:00:00.000Z',
      filename: 'CoinbaseProStatements/fill/2024-01.pdf',
    },
  ]);
});

test('rejects invalid ranges and an empty report-type selection', async () => {
  const { provider } = installProvider();
  const base = {
    startYear: 2024,
    startMonth: 1,
    endYear: 2024,
    endMonth: 2,
    wantAccount: true,
    wantFills: false,
  };

  await assert.rejects(
    provider.discoverDocuments(Object.assign({}, base, { startMonth: 13 })),
    /Months must be between 1 and 12/
  );
  await assert.rejects(
    provider.discoverDocuments(Object.assign({}, base, { startMonth: 3 })),
    /From date must not be later than To date/
  );
  await assert.rejects(
    provider.discoverDocuments(Object.assign({}, base, { wantAccount: false })),
    /Select at least one/
  );
});

test('migrates the legacy calibration template to namespaced storage', async () => {
  const template = { email: 'person@example.com', profile_id: 'profile-1', proof_token: 'proof' };
  const { provider, data } = installProvider({ stored: { template } });

  const state = await provider.loadState();

  assert.deepEqual(state.template, template);
  assert.deepEqual(data['fsd:coinbase:template'], template);
});

test('keeps an observed proof token when saving unchanged manual calibration fields', async () => {
  const template = { email: 'person@example.com', profile_id: 'profile-1', proof_token: 'proof' };
  const { provider, data } = installProvider({
    stored: { 'fsd:coinbase:template': template },
  });

  await provider.discoverDocuments({
    startYear: 2024,
    startMonth: 1,
    endYear: 2024,
    endMonth: 1,
    wantAccount: true,
    wantFills: false,
    email: template.email,
    profileId: template.profile_id,
  });

  assert.deepEqual(data['fsd:coinbase:template'], template);
});

test('generates, polls, and downloads using the normalized descriptor', async () => {
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/generate-pro-report')) {
      return { ok: true, async json() { return { id: 'report-123' }; } };
    }
    assert.equal(url, 'https://accounts.coinbase.com/v1/statements/pro-report/report-123');
    return {
      ok: true,
      async json() {
        return { status: 'PRO_REPORT_STATUS_COMPLETED', file_url: 'https://files.example/report.pdf' };
      },
    };
  };
  const { provider, messages } = installProvider({
    stored: {
      'fsd:coinbase:template': {
        email: 'person@example.com',
        profile_id: 'profile-1',
        proof_token: 'proof',
      },
    },
    fetch,
  });
  const [document] = await provider.discoverDocuments({
    startYear: 2024,
    startMonth: 2,
    endYear: 2024,
    endMonth: 2,
    wantAccount: false,
    wantFills: true,
  });

  const result = await provider.downloadDocument(document);
  const generateBody = JSON.parse(requests[0].init.body);

  assert.deepEqual(generateBody.fills, {
    productId: 'ALL',
    startDate: '2024-02-01T00:00:00.000Z',
    endDate: '2024-02-29T00:00:00.000Z',
  });
  assert.equal(generateBody.email, 'person@example.com');
  assert.equal(generateBody.profile_id, 'profile-1');
  assert.equal(generateBody.proof_token, 'proof');
  assert.deepEqual(messages, []);
  assert.deepEqual(result, {
    url: 'https://files.example/report.pdf',
    filename: 'CoinbaseProStatements/fill/2024-02.pdf',
  });
});
