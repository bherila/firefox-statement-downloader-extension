'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
require('../core/runtime.js'); require('../core/import-list.js');
const { grouped, select, summary } = global.FinancialStatementDownloader.importList;
const source = (index, extra = {}) => ({ id: `example-${index}`, kind: 'receipt', userId: 100000001,
  createdAt: new Date(1767225600000 + index).toISOString(), status: 'received',
  summary: { orderId: `100-${String(index).padStart(7, '0')}-1000000`, marketplace: 'example.test', layout: 'standard', itemCount: 2, warnings: [] }, ...extra });

test('settings groups by order and destination then paginates fifty rows without source contents', () => {
  const records = Array.from({ length: 120 }, (_, index) => source(index));
  records.push({ ...source(1), id: 'example-revision', createdAt: '2026-02-01T00:00:00.000Z' });
  const groups = grouped(records, 100000001);
  assert.equal(groups.length, 120); assert.equal(groups[0].records.length, 2);
  assert.equal(select(groups, 'all').rows.length, 50);
  assert.equal(select(groups, 'all', '', 3).rows.length, 20);
  assert.equal(select(groups, 'all').pages, 3);
  assert.equal(select(groups, 'all', '100-0000001-1000000').total, 1);
  assert.equal(summary(records[0]).itemCount, 2);
});

test('attention, waiting, sent and other-account filters use metadata only', () => {
  const records = [source(1), source(2, { status: 'local', data: { items: [{ title: 'EXAMPLE PRIVATE ITEM' }] } }),
    source(3, { status: 'refused', error: 'EXAMPLE REFUSAL' }), source(4, { userId: 200000001, status: 'local' })];
  const groups = grouped(records, 100000001); const result = select(groups, 'all');
  assert.deepEqual(result.counts, { attention: 1, waiting: 1, sent: 1, other: 1, all: 4 });
  assert.equal(select(groups, 'all', 'EXAMPLE PRIVATE ITEM').total, 0);
  assert.equal(select(groups, 'waiting').rows[0].held, 1);
  assert.equal(select(groups, 'other').rows[0].userId, 200000001);
});
