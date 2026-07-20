'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const runtimePath = require.resolve('../core/runtime.js');
const providerPath = require.resolve('../providers/netbenefits.js');

function loadProvider() {
  global.FinancialStatementDownloader = undefined;
  delete require.cache[runtimePath];
  delete require.cache[providerPath];
  require(runtimePath);
  require(providerPath);
  return global.FinancialStatementDownloader.providers.netbenefits;
}

function loadHelpers() {
  return loadProvider().helpers;
}

test.afterEach(() => {
  delete global.FinancialStatementDownloader;
  delete require.cache[runtimePath];
  delete require.cache[providerPath];
});

test('converts ISO dates to the MM/DD/YYYY the forms expect', () => {
  const { toUsDate } = loadHelpers();

  assert.equal(toUsDate('2025-01-31'), '01/31/2025');
  assert.equal(toUsDate('2025-12-01'), '12/01/2025');
});

test('generates one period per calendar month, ending on the real last day', () => {
  const { periodsInRange } = loadHelpers();

  const periods = periodsInRange('2024-01-01', '2024-03-31', 'MONTHLY');

  assert.deepEqual(periods.map((p) => p.label), ['2024-01', '2024-02', '2024-03']);
  // 2024 is a leap year; February must end on the 29th, not the 28th.
  assert.equal(periods[1].end, '2024-02-29');
  assert.equal(periods[2].end, '2024-03-31');
});

test('generates calendar quarters and annual periods', () => {
  const { periodsInRange } = loadHelpers();

  const quarters = periodsInRange('2024-01-01', '2024-12-31', 'QUARTERLY');
  assert.deepEqual(quarters.map((p) => p.label), ['2024-Q1', '2024-Q2', '2024-Q3', '2024-Q4']);
  assert.equal(quarters[0].end, '2024-03-31');
  assert.equal(quarters[3].end, '2024-12-31');

  const years = periodsInRange('2023-01-01', '2025-12-31', 'ANNUAL');
  assert.deepEqual(years.map((p) => p.label), ['2023', '2024', '2025']);
});

test('clamps the first and last period to the requested range', () => {
  const { periodsInRange } = loadHelpers();

  const periods = periodsInRange('2024-02-10', '2024-04-15', 'MONTHLY');

  // A partial month must not ask for days outside the range the user chose.
  assert.equal(periods[0].start, '2024-02-10');
  assert.equal(periods[periods.length - 1].end, '2024-04-15');
});

test('excludes periods that fall entirely outside the range', () => {
  const { periodsInRange } = loadHelpers();

  const quarters = periodsInRange('2024-05-01', '2024-08-31', 'QUARTERLY');

  assert.deepEqual(quarters.map((p) => p.label), ['2024-Q2', '2024-Q3']);
});

test('computes the rolling ten-year retention floor', () => {
  const { retentionFloor } = loadHelpers();

  // Ten years back, plus a day: the earliest date still answerable.
  assert.equal(retentionFloor('2026-07-20T00:00:00Z'), '2016-07-21');
  assert.equal(retentionFloor('2020-01-01T00:00:00Z'), '2010-01-02');
});

test('reads the plan context out of the page form', () => {
  const { readPlanContext } = loadHelpers();
  const fake = {
    querySelector(sel) {
      const values = {
        'input[name="txntoken"]': { value: 'tok-123' },
        'input[name="sodClientId"]': { value: '000000001' },
        'input[name="sodPlan"]': { value: '50001' },
      };
      if (values[sel]) return values[sel];
      return { textContent: '  EXAMPLE EMPLOYER  ' };
    },
  };

  const context = readPlanContext(fake);

  assert.equal(context.txntoken, 'tok-123');
  assert.equal(context.sodClientId, '000000001');
  assert.equal(context.sodPlan, '50001');
  assert.equal(context.planName, 'EXAMPLE EMPLOYER');
});

test('builds a plan folder from the plan name and number', () => {
  const { planFolder } = loadHelpers();

  assert.equal(planFolder({ planName: 'EXAMPLE EMPLOYER', sodPlan: '50001' }), 'EXAMPLE-EMPLOYER-50001');
  // Falls back to the plan number when the page gives no usable name.
  assert.equal(planFolder({ planName: '', sodPlan: '50002' }), '50002');
});

test('recognizes the soft-block response rather than saving it as a statement', () => {
  const { looksBlocked } = loadHelpers();

  assert.equal(looksBlocked("Sorry, we can't complete this action right now."), true);
  assert.equal(looksBlocked('<html>Access Denied</html>'), true);
  assert.equal(looksBlocked('<html>Your account statement</html>'), false);
});

test('rejects a statement whose range does not match what was asked for', () => {
  const { statementRangeMatches } = loadHelpers();
  const period = { start: '2024-03-01', end: '2024-03-31', label: '2024-03' };

  assert.equal(statementRangeMatches('<p>Period 03/01/2024 - 03/31/2024</p>', period), true);
  // The server silently returning a different period would otherwise fill the
  // archive with mislabeled files.
  assert.equal(statementRangeMatches('<p>Period 01/01/2024 - 01/31/2024</p>', period), false);
});

test('only claims the NetBenefits savings pages', () => {
  const provider = loadProvider();

  assert.equal(provider.matches('https://workplaceservices.fidelity.com/mybenefits/savings2/sod/soddetail'), true);
  assert.equal(provider.matches('https://workplaceservices.fidelity.com/mybenefits/navstation/navigation'), false);
  assert.equal(provider.matches('https://digitalservices.fidelity.com/navigate/ent-documentcenter/statements'), false);
});

test('lists whole years for transaction exports', () => {
  const { yearsInRange } = loadHelpers();

  assert.deepEqual(yearsInRange('2023-06-01', '2025-02-01'), [2023, 2024, 2025]);
});
