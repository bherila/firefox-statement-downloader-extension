'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadRuntime() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'runtime.js'), 'utf8');
  const context = vm.createContext({ setTimeout });
  vm.runInContext(source, context, { filename: 'core/runtime.js' });
  return context.FinancialStatementDownloader;
}

test('pad2 pads single digits without truncating larger values', () => {
  const { pad2 } = loadRuntime();
  assert.equal(pad2(4), '04');
  assert.equal(pad2(12), '12');
  assert.equal(pad2(123), '123');
});

test('monthRange returns an inclusive chronological range across years', () => {
  const { monthRange } = loadRuntime();
  const actual = monthRange(2024, 11, 2025, 2);

  assert.deepEqual(
    Array.from(actual, ({ year, month }) => ({ year, month })),
    [
      { year: 2024, month: 11 },
      { year: 2024, month: 12 },
      { year: 2025, month: 1 },
      { year: 2025, month: 2 },
    ],
  );
});

test('monthRange validates dates and chronological order', () => {
  const { monthRange } = loadRuntime();

  assert.throws(() => monthRange(2024, 0, 2024, 1), /startMonth/);
  assert.throws(() => monthRange(2024, 1, 2024, 13), /endMonth/);
  assert.throws(() => monthRange(2024.5, 1, 2025, 1), /startYear/);
  assert.throws(() => monthRange(2025, 1, 2024, 12), /must not be after/);
});

test('withRetry retries failures and reports stronger backoff for status 429', async () => {
  const { withRetry } = loadRuntime();
  const waits = [];
  const retries = [];
  let calls = 0;

  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('rate limited');
        error.status = 429;
        throw error;
      }
      if (calls === 2) {
        const error = new Error('temporary failure');
        error.status = 503;
        throw error;
      }
      return 'downloaded';
    },
    { attempts: 3, baseDelayMs: 10, sleep: async (ms) => waits.push(ms) },
    (error, delay, retryNumber, maxRetries) => {
      retries.push({ status: error.status, delay, retryNumber, maxRetries });
    },
  );

  assert.equal(result, 'downloaded');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [40, 20]);
  assert.deepEqual(retries, [
    { status: 429, delay: 40, retryNumber: 1, maxRetries: 2 },
    { status: 503, delay: 20, retryNumber: 2, maxRetries: 2 },
  ]);
});

test('withRetry rethrows the original error with its status', async () => {
  const { withRetry } = loadRuntime();
  const failure = new Error('still unavailable');
  failure.status = 503;

  await assert.rejects(
    withRetry(async () => {
      throw failure;
    }, { attempts: 2, baseDelayMs: 0 }),
    (error) => error === failure && error.status === 503,
  );
});

test('normalizeDocument creates a canonical document and copies metadata', () => {
  const { normalizeDocument } = loadRuntime();
  const metadata = { href: '/documents/statement-1' };

  const actual = normalizeDocument(' fidelity ', {
    id: ' statement-1 ',
    title: ' January Statement ',
    category: ' statements ',
    filename: ' 2025-01-fidelity.pdf ',
    date: '2025-01-31',
    account: 'Brokerage',
    metadata,
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(actual)),
    {
      provider: 'fidelity',
      id: 'statement-1',
      title: 'January Statement',
      category: 'statements',
      filename: '2025-01-fidelity.pdf',
      date: '2025-01-31',
      account: 'Brokerage',
      metadata: { href: '/documents/statement-1' },
    },
  );
  assert.notEqual(actual.metadata, metadata);
});

test('normalizeDocument requires stable identity and file fields', () => {
  const { normalizeDocument } = loadRuntime();
  const complete = {
    id: 'doc-1',
    title: 'Statement',
    category: 'statements',
    filename: 'statement.pdf',
  };

  assert.throws(() => normalizeDocument('', complete), /provider/);
  for (const field of ['id', 'title', 'category', 'filename']) {
    assert.throws(
      () => normalizeDocument('wealthfront', { ...complete, [field]: '   ' }),
      new RegExp(field),
    );
  }
  assert.throws(
    () => normalizeDocument('wealthfront', { ...complete, metadata: [] }),
    /metadata/,
  );
});
