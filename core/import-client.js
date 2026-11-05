(function initializeImportClient(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader || {};
  // Public, session-authenticated API. No identity-provider credentials or
  // bearer tokens are read, copied, persisted, or passed to content scripts.
  const ORIGIN = 'https://pfifi.com';
  const JOB_TYPES = ['finance_transactions', 'finance_payslip', 'utility_bill', 'equity_award'];

  function retryDelay(error, attempt, random = Math.random) {
    const exponential = Math.min(3600000, 30000 * (2 ** Math.min(attempt, 7)));
    return Math.ceil(Math.max(error.retryAfterMs || 0, exponential) * (1 + random() * 0.2));
  }

  async function waitDelay(milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      await new Promise((resolve) => root.setTimeout(resolve, Math.min(60000, deadline - Date.now())));
    }
  }

  /**
   * @param {() => Promise<any>} operation
   * @param {{check?: () => Promise<boolean>, wait?: (milliseconds: number) => Promise<void>, random?: () => number, onRetry?: (milliseconds: number) => void}} [options]
   */
  async function withRateLimitRetry(operation, options = {}) {
    let attempt = 0;
    const wait = options.wait || waitDelay;
    while (!options.check || await options.check()) {
      try {
        return await operation();
      } catch (error) {
        if (error.status !== 429) throw error;
        const delay = retryDelay(error, attempt++, options.random);
        if (options.onRetry) options.onRetry(delay);
        await wait(delay);
      }
    }
    throw new Error('Imports paused or the destination account changed.');
  }

  function accountMismatch(active) {
    return Object.assign(new Error('The signed-in account changed. Review accounts in settings.'), {
      status: 409,
      activeIdentity: { userId: active.userId, userName: active.userName || String(active.userId) },
    });
  }

  function validationDetails(body) {
    const sourceErrors = {};
    const requestErrors = {};
    for (const [field, value] of Object.entries(body?.errors || {})) {
      const messages = (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string');
      const match = field.match(/^sources\.(0|[1-9]\d*)(?:\.|$)/);
      if (match) sourceErrors[Number(match[1])] = [...(sourceErrors[Number(match[1])] || []), ...messages];
      else requestErrors[field] = messages;
    }
    return { sourceErrors, requestErrors };
  }

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
          // Keep structured validation evidence: only indexed source errors
          // identify a refused source; request-level errors do not.
          let body = null;
          try { body = await response.json(); } catch (parseError) { /* Non-JSON failures still retain their HTTP status. */ }
          const details = response.status === 422 ? validationDetails(body) : {};
          if (response.status === 422 && typeof body?.message === 'string') error.message = body.message.slice(0, 2000);
          Object.assign(error, { body, ...details });
          if (response.status === 429) {
            const header = response.headers?.get('Retry-After')?.trim() || '';
            const wait = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
            error.retryAfterMs = Number.isFinite(wait) && wait > 0 ? wait : 0;
          }
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
      return { userId: result.user_id, userName: typeof result.user_name === 'string' && result.user_name.trim() ? result.user_name.trim() : String(result.user_id), csrfToken: result.csrf_token };
    }

    async function uploadRequest(path, options) {
      try {
        return await request(path, options);
      } catch (error) {
        // The browser session can change between the preflight and POST. Fetch
        // only identity metadata so the account-choice UI can name both owners.
        if (error.status === 409) {
          try {
            const active = await session();
            error.activeIdentity = { userId: active.userId, userName: active.userName };
          } catch (identityError) { /* Preserve the original stop if sign-in also expired. */ }
        }
        throw error;
      }
    }

    async function upload(record, expectedUserId) {
      const active = await session();
      if (active.userId !== expectedUserId) throw accountMismatch(active);
      const form = new FormData();
      form.append('file', new Blob([record.bytes], { type: record.contentType }), record.filename);
      form.append('sha256', record.id);
      form.append('expected_user_id', String(expectedUserId));
      const source = ['receipt', 'gift-card-snapshot'].includes(record.kind);
      if (!source) {
        if (!JOB_TYPES.includes(record.jobType)) throw new Error('Unsupported import job type.');
        form.append('job_type', record.jobType);
      }
      // Both intake endpoints validate the expected recipient against the
      // request's authenticated user before storing any source bytes.
      const path = record.kind === 'gift-card-snapshot' ? '/api/finance/browser-import/gift-card-snapshots'
        : source ? '/api/finance/browser-import/receipts' : '/api/genai/import/jobs';
      const result = await uploadRequest(path, {
        method: 'POST', headers: { 'X-CSRF-TOKEN': active.csrfToken }, body: form,
      });
      const remoteId = source ? result.document_id : result.job_id;
      if (!Number.isSafeInteger(remoteId) || remoteId < 1) throw new Error('Import acknowledgement was incomplete. Check the destination before retrying.');
      return { remoteId, status: result.status || 'received', duplicate: result.duplicate === true || result.deduplicated === true };
    }

    async function uploadBatch(records, expectedUserId) {
      if (!Array.isArray(records) || !records.length || records.length > 20) throw new Error('A receipt batch must contain 1–20 sources.');
      const kind = records[0].kind || 'receipt';
      if (!['receipt', 'gift-card-snapshot'].includes(kind) || records.some((record) => (record.kind || 'receipt') !== kind)) {
        throw new Error('A batch must contain one supported source kind.');
      }
      const active = await session();
      if (active.userId !== expectedUserId) throw accountMismatch(active);
      const form = new FormData();
      form.append('expected_user_id', String(expectedUserId));
      for (const record of records) {
        form.append('files[]', new Blob([record.bytes], { type: record.contentType }), record.filename);
        form.append('sha256[]', record.id);
      }
      const path = kind === 'gift-card-snapshot' ? '/api/finance/browser-import/gift-card-snapshots/batch'
        : '/api/finance/browser-import/receipts/batch';
      const result = await uploadRequest(path, {
        method: 'POST', headers: { 'X-CSRF-TOKEN': active.csrfToken }, body: form,
      });
      const expected = new Set(records.map((record) => record.id));
      const received = new Map();
      for (const item of result.results || []) {
        if (!expected.has(item.sha256) || received.has(item.sha256) || item.status !== 'received'
          || !Number.isSafeInteger(item.document_id) || item.document_id < 1) {
          throw new Error('Batch acknowledgement was incomplete. Check the destination before retrying.');
        }
        received.set(item.sha256, { id: item.sha256, remoteId: item.document_id, status: item.status, duplicate: item.duplicate === true });
      }
      if (received.size !== expected.size) throw new Error('Batch acknowledgement was incomplete. Check the destination before retrying.');
      return records.map((record) => received.get(record.id));
    }

    return { session, upload, uploadBatch };
  }

  FSD.importClient = { ORIGIN, JOB_TYPES, createImportClient, retryDelay, withRateLimitRetry, accountMismatch };
  root.FinancialStatementDownloader = FSD;
})(globalThis);
