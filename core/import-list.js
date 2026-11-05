(function initializeImportList(root) {
  'use strict';
  const FSD = root.FinancialStatementDownloader || {};
  function summary(record) {
    if (record.summary) return record.summary;
    return { orderId: record.data?.order_id || null, marketplace: record.data?.marketplace || '',
      layout: record.data?.layout || null, itemCount: record.data?.items?.length ?? null,
      activityCount: record.data?.activities?.length ?? null, warnings: record.data?.warnings || [] };
  }
  function grouped(records, userId) {
    const groups = new Map();
    records.forEach((record, index) => {
      const info = summary(record);
      const kind = record.kind || 'receipt';
      const key = JSON.stringify([kind, info.marketplace, info.orderId, record.userId]);
      if (!groups.has(key)) groups.set(key, { key, kind, orderId: info.orderId, marketplace: info.marketplace,
        userId: record.userId, records: [], newestIndex: -1 });
      const group = groups.get(key); group.records.push(record);
      if (!group.latest || Date.parse(record.createdAt) > Date.parse(group.latest.createdAt)
        || record.createdAt === group.latest.createdAt && index > group.newestIndex) {
        group.latest = record; group.newestIndex = index;
      }
    });
    return [...groups.values()].map((group) => {
      const info = summary(group.latest);
      const merchant = info.layout === 'whole_foods' ? 'Whole Foods' : info.layout === 'fresh' ? 'Fresh' : FSD.amz.displayName;
      return { ...group, summary: info, merchant, held: group.records.filter((record) => record.data).length,
        waiting: group.records.some((record) => record.status === 'local'),
        sent: group.records.some((record) => record.status === 'received') && group.records.every((record) => ['received', 'suppressed'].includes(record.status)),
        attention: Boolean(info.warnings?.length || group.records.some((record) => record.status === 'refused')),
        other: group.userId != null && group.userId !== userId };
    }).sort((a, b) => Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt) || b.newestIndex - a.newestIndex);
  }
  function select(groups, filter, search = '', page = 1) {
    const needle = search.trim().toLowerCase();
    const searched = groups.filter((group) => `${group.merchant} ${group.orderId || 'gift-card activity'}`.toLowerCase().includes(needle));
    const matches = (group, tab) => tab === 'all' || tab === 'attention' && group.attention
      || tab === 'waiting' && group.waiting && !group.other || tab === 'sent' && group.sent && !group.other || tab === 'other' && group.other;
    const counts = Object.fromEntries(['attention', 'waiting', 'sent', 'other', 'all'].map((tab) => [tab, searched.filter((group) => matches(group, tab)).length]));
    const filtered = searched.filter((group) => matches(group, filter));
    const pages = Math.max(1, Math.ceil(filtered.length / 50));
    const currentPage = Math.min(pages, Math.max(1, page));
    return { rows: filtered.slice((currentPage - 1) * 50, currentPage * 50), counts, total: filtered.length, pages, page: currentPage };
  }
  FSD.importList = { summary, grouped, select };
  root.FinancialStatementDownloader = FSD;
})(globalThis);
