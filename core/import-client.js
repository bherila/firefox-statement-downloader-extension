(function initializeImportClient(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader || {};
  // Public, session-authenticated API. No identity-provider credentials or
  // bearer tokens are read, copied, persisted, or passed to content scripts.
  const ORIGIN = 'https://pfifi.com';
  const JOB_TYPES = ['finance_transactions', 'finance_payslip', 'utility_bill', 'equity_award'];

  function createImportClient(fetcher = root.fetch.bind(root)) {
    async function request(path, options = {}) {
      const controller = new AbortController();
      const timer = root.setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetcher(`${ORIGIN}${path}`, {
          credentials: 'include', redirect: 'error', referrerPolicy: 'no-referrer',
          ...options, signal: controller.signal,
          headers: { Accept: 'application/json', ...options.headers },
        });
        if (!response.ok) {
          const error = new Error([401, 419].includes(response.status)
            ? 'Sign in to the import destination again.'
            : response.status === 409 ? 'The signed-in account changed. Reconnect in settings.'
              : `Import destination returned HTTP ${response.status}.`);
          error.status = response.status;
          throw error;
        }
        return await response.json();
      } finally {
        root.clearTimeout(timer);
      }
    }

    async function session() {
      const result = await request('/api/finance/browser-import/session');
      if (!result || !Number.isSafeInteger(result.user_id) || result.user_id < 1
        || typeof result.csrf_token !== 'string' || !result.csrf_token) {
        throw new Error('The destination does not support browser imports yet.');
      }
      return { userId: result.user_id, csrfToken: result.csrf_token };
    }

    async function upload(record, expectedUserId) {
      const active = await session();
      if (active.userId !== expectedUserId) throw new Error('The signed-in account changed. Reconnect in settings.');
      const form = new FormData();
      form.append('file', new Blob([record.bytes], { type: record.contentType }), record.filename);
      form.append('sha256', record.id);
      form.append('expected_user_id', String(expectedUserId));
      const receipt = record.kind === 'receipt';
      if (!receipt) {
        if (!JOB_TYPES.includes(record.jobType)) throw new Error('Unsupported import job type.');
        form.append('job_type', record.jobType);
      }
      // Both intake endpoints validate the expected recipient against the
      // request's authenticated user before storing any source bytes.
      const result = await request(receipt ? '/api/finance/browser-import/receipts' : '/api/genai/import/jobs', {
        method: 'POST', headers: { 'X-CSRF-TOKEN': active.csrfToken }, body: form,
      });
      const remoteId = receipt ? result.document_id : result.job_id;
      if (!Number.isSafeInteger(remoteId) || remoteId < 1) throw new Error('Import acknowledgement was incomplete. Check the destination before retrying.');
      return { remoteId, status: result.status || 'received', duplicate: result.duplicate === true || result.deduplicated === true };
    }

    return { session, upload };
  }

  FSD.importClient = { ORIGIN, JOB_TYPES, createImportClient };
  root.FinancialStatementDownloader = FSD;
})(globalThis);
