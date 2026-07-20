(function registerCoinbaseProvider(root) {
  'use strict';

  const app = root.FinancialStatementDownloader = root.FinancialStatementDownloader || {};
  app.providers = app.providers || {};

  const PROVIDER_ID = 'coinbase';
  const STORAGE_KEYS = {
    template: 'fsd:coinbase:template',
    settings: 'fsd:coinbase:settings',
  };
  const LEGACY_TEMPLATE_KEY = 'template';
  const GENERATE_URL = 'https://accounts.coinbase.com/v1/statements/generate-pro-report';
  const POLL_URL = 'https://accounts.coinbase.com/v1/statements/pro-report/';
  const REPORT_TYPES = {
    account: {
      label: 'Account statements',
      requestKey: 'account',
      scope: { accountId: 'ALL' },
      folder: 'account',
    },
    fills: {
      label: 'Fill statements',
      requestKey: 'fills',
      scope: { productId: 'ALL' },
      folder: 'fill',
    },
  };

  function browserApi() {
    if (!root.browser) {
      throw new Error('Firefox browser API is unavailable');
    }
    return root.browser;
  }

  function fetchApi() {
    if (typeof root.fetch !== 'function') {
      throw new Error('fetch is unavailable');
    }
    return root.fetch.bind(root);
  }

  function pad2(value) {
    return typeof app.pad2 === 'function' ? app.pad2(value) : String(value).padStart(2, '0');
  }

  function isoStartOfMonth(year, month) {
    return `${year}-${pad2(month)}-01T00:00:00.000Z`;
  }

  function isoEndOfMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).toISOString();
  }

  function monthsInRange(startYear, startMonth, endYear, endMonth) {
    if (typeof app.monthRange === 'function') {
      return app.monthRange(startYear, startMonth, endYear, endMonth);
    }
    const result = [];
    let year = startYear;
    let month = startMonth;
    while (year < endYear || (year === endYear && month <= endMonth)) {
      result.push({ year, month });
      month += 1;
      if (month > 12) {
        year += 1;
        month = 1;
      }
    }
    return result;
  }

  function integer(value, label) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed)) {
      throw new Error(`${label} must be a whole number`);
    }
    return parsed;
  }

  function normalizeOptions(input) {
    const options = input || {};
    const startYear = integer(options.startYear, 'Start year');
    const startMonth = integer(options.startMonth, 'Start month');
    const endYear = integer(options.endYear, 'End year');
    const endMonth = integer(options.endMonth, 'End month');
    if (startYear < 2000 || startYear > 9999 || endYear < 2000 || endYear > 9999) {
      throw new Error('Years must be four-digit years no earlier than 2000');
    }
    if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) {
      throw new Error('Months must be between 1 and 12');
    }
    if ((startYear * 12 + startMonth) > (endYear * 12 + endMonth)) {
      throw new Error('From date must not be later than To date');
    }

    const types = [];
    if (options.wantAccount !== false) {
      types.push('account');
    }
    if (options.wantFills !== false) {
      types.push('fills');
    }
    if (types.length === 0) {
      throw new Error('Select at least one Coinbase statement type');
    }

    const parsedDelay = Number(options.delayMs);
    return {
      startYear,
      startMonth,
      endYear,
      endMonth,
      wantAccount: types.includes('account'),
      wantFills: types.includes('fills'),
      delayMs: Number.isFinite(parsedDelay) ? Math.max(1000, Math.round(parsedDelay)) : 3000,
      types,
      email: typeof options.email === 'string' ? options.email.trim() : '',
      profileId: typeof options.profileId === 'string' ? options.profileId.trim() : '',
    };
  }

  function notify(report, stage, message, details) {
    if (typeof report === 'function') {
      report(Object.assign({ type: stage, provider: PROVIDER_ID, stage, message }, details || {}));
    }
  }

  function sleep(ms) {
    return typeof app.sleep === 'function'
      ? app.sleep(ms)
      : new Promise((resolve) => root.setTimeout(resolve, ms));
  }

  function isStopped(controller) {
    return typeof app.isStopped === 'function'
      ? app.isStopped(controller)
      : Boolean(controller && (controller.stopped || controller.aborted || (controller.signal && controller.signal.aborted)));
  }

  function waitForStop(controller) {
    if (typeof app.waitForStop === 'function') return app.waitForStop(controller);
    if (!controller) return new Promise(() => {});
    if (isStopped(controller)) return Promise.resolve(controller.reason);
    if (typeof controller.waitForStop === 'function') return controller.waitForStop();
    if (controller.signal && typeof controller.signal.wait === 'function') return controller.signal.wait();
    return new Promise(() => {});
  }

  function cancellationError(controller) {
    const error = new Error((controller && controller.reason) || 'stopped');
    error.stopped = true;
    return error;
  }

  async function sleepUnlessStopped(ms, controller) {
    if (isStopped(controller)) return false;
    const completed = await Promise.race([
      sleep(ms).then(() => true),
      waitForStop(controller).then(() => false),
    ]);
    return completed && !isStopped(controller);
  }

  async function withRetry(operation, report, document, controller, attempts = 4, baseDelayMs = 3000) {
    if (!controller && typeof app.withRetry === 'function') {
      return app.withRetry(operation, { attempts, baseDelayMs }, (error, delayMs, attempt, maxRetries) => {
        notify(report, 'retry', `Retrying ${document.id} after ${error.message || error}`, {
          document,
          attempt,
          maxRetries,
          delayMs,
        });
      });
    }
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (isStopped(controller)) throw cancellationError(controller);
      try {
        const result = await operation();
        if (isStopped(controller)) throw cancellationError(controller);
        return result;
      } catch (error) {
        lastError = error;
        if (isStopped(controller) || error.stopped) throw cancellationError(controller);
        if (attempt === attempts - 1) {
          break;
        }
        const rateLimited = error && error.status === 429;
        const delayMs = rateLimited
          ? baseDelayMs * Math.pow(2, attempt + 2)
          : baseDelayMs * Math.pow(2, attempt);
        notify(report, 'retry', `Retrying ${document.id} after ${error.message || error}`, {
          document,
          attempt: attempt + 1,
          maxRetries: attempts - 1,
          delayMs,
        });
        if (!await sleepUnlessStopped(delayMs, controller)) throw cancellationError(controller);
      }
    }
    throw lastError;
  }

  async function generateReport(template, document) {
    const metadata = document.metadata || {};
    const type = REPORT_TYPES[metadata.reportType];
    if (!type) {
      throw new Error(`Unsupported Coinbase report type: ${metadata.reportType}`);
    }
    const response = await fetchApi()(GENERATE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'PRO_REPORT_FORMAT_PDF',
        email: template.email,
        profile_id: template.profile_id,
        proof_token: template.proof_token || '',
        [type.requestKey]: Object.assign({}, type.scope, {
          startDate: metadata.periodStart,
          endDate: metadata.periodEnd,
        }),
      }),
    });
    if (!response.ok) {
      const error = new Error(`generate-pro-report HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    if (!payload.id) {
      throw new Error('generate-pro-report response missing id');
    }
    return payload.id;
  }

  async function pollUntilComplete(reportId, timeoutMs = 30000, controller) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (isStopped(controller)) throw cancellationError(controller);
      const response = await fetchApi()(`${POLL_URL}${encodeURIComponent(reportId)}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const error = new Error(`pro-report poll HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      if (payload.status === 'PRO_REPORT_STATUS_COMPLETED' && payload.file_url) {
        return payload.file_url;
      }
      if (payload.status && payload.status.includes('FAIL')) {
        throw new Error(`report generation failed: ${payload.status}`);
      }
      if (!await sleepUnlessStopped(800, controller)) throw cancellationError(controller);
    }
    throw new Error('timed out waiting for report to complete');
  }

  async function loadTemplate() {
    // Keep this key stable: the background request observer also writes it, and this
    // one-time copy upgrades installations of the original Coinbase-only extension.
    const storage = browserApi().storage.local;
    const stored = await storage.get([STORAGE_KEYS.template, LEGACY_TEMPLATE_KEY]);
    let template = stored[STORAGE_KEYS.template] || null;
    if (!template && stored[LEGACY_TEMPLATE_KEY]) {
      template = stored[LEGACY_TEMPLATE_KEY];
      await storage.set({ [STORAGE_KEYS.template]: template });
    }
    return template;
  }

  function templateIsValid(template) {
    return Boolean(template && template.email && template.profile_id);
  }

  const provider = {
    id: PROVIDER_ID,
    label: 'Coinbase',

    isSupportedPage() {
      const location = root.location;
      return Boolean(location && location.hostname === 'accounts.coinbase.com' &&
        location.pathname.startsWith('/statements/pro'));
    },

    findMountPoint() {
      if (!root.document) {
        return null;
      }
      const heading = root.document.querySelector('main h1, main h2, [role="main"] h1, [role="main"] h2');
      return heading ||
        root.document.querySelector('main, [role="main"]') ||
        root.document.body;
    },

    renderControls(container, state) {
      const settings = (state && state.settings) || {};
      const template = state && state.template;
      container.innerHTML = `
        <div class="fsd-provider-status" data-role="template-status"></div>
        <div class="row">
          <label>Email <input type="email" data-field="email"></label>
          <label>Profile ID <input type="text" data-field="profileId"></label>
        </div>
        <div class="row">
          <label>From <input type="number" data-field="startYear" placeholder="yyyy" min="2000" max="9999"> - <input type="number" data-field="startMonth" placeholder="mm" min="1" max="12"></label>
          <label>To <input type="number" data-field="endYear" placeholder="yyyy" min="2000" max="9999"> - <input type="number" data-field="endMonth" placeholder="mm" min="1" max="12"></label>
        </div>
        <div class="row">
          <label><input type="checkbox" data-field="wantAccount"> Account statements</label>
          <label><input type="checkbox" data-field="wantFills"> Fill statements</label>
        </div>
        <label>Delay between requests (ms) <input type="number" data-field="delayMs" min="1000" step="500"></label>
      `;

      const setValue = (name, value) => {
        const field = container.querySelector(`[data-field="${name}"]`);
        if (field) field.value = value == null ? '' : value;
      };
      setValue('email', template && template.email);
      setValue('profileId', template && template.profile_id);
      setValue('startYear', settings.startYear);
      setValue('startMonth', settings.startMonth);
      setValue('endYear', settings.endYear);
      setValue('endMonth', settings.endMonth);
      setValue('delayMs', settings.delayMs || 3000);
      container.querySelector('[data-field="wantAccount"]').checked = settings.wantAccount !== false;
      container.querySelector('[data-field="wantFills"]').checked = settings.wantFills !== false;
      const status = container.querySelector('[data-role="template-status"]');
      status.textContent = templateIsValid(template)
        ? `Calibrated: ${template.email} / ${template.profile_id}`
        : 'Not calibrated — click a Coinbase PDF/CSV link once, or enter email and profile ID.';
      status.dataset.state = templateIsValid(template) ? 'ready' : 'warning';
    },

    readOptions(container) {
      const value = (name) => container.querySelector(`[data-field="${name}"]`).value;
      const checked = (name) => container.querySelector(`[data-field="${name}"]`).checked;
      return normalizeOptions({
        startYear: value('startYear'),
        startMonth: value('startMonth'),
        endYear: value('endYear'),
        endMonth: value('endMonth'),
        wantAccount: checked('wantAccount'),
        wantFills: checked('wantFills'),
        delayMs: value('delayMs'),
        email: value('email').trim(),
        profileId: value('profileId').trim(),
      });
    },

    async loadState() {
      if (typeof app.createProviderStorage === 'function') {
        const storage = app.createProviderStorage(PROVIDER_ID);
        await storage.migrateLegacy(['settings']);
        const [template, settings] = await Promise.all([
          loadTemplate(),
          storage.loadSettings(),
        ]);
        return { template, settings };
      }
      const storage = browserApi().storage.local;
      const [template, stored] = await Promise.all([
        loadTemplate(),
        storage.get(STORAGE_KEYS.settings),
      ]);
      return {
        template,
        settings: stored[STORAGE_KEYS.settings] || null,
      };
    },

    async discoverDocuments(options, report, controller) {
      const normalized = normalizeOptions(options);
      if ((normalized.email && !normalized.profileId) || (!normalized.email && normalized.profileId)) {
        throw new Error('Both email and profile ID are required for manual Coinbase calibration');
      }
      if (normalized.email && normalized.profileId) {
        const existingTemplate = await loadTemplate();
        const template = {
          email: normalized.email,
          profile_id: normalized.profileId,
          proof_token: existingTemplate &&
            existingTemplate.email === normalized.email &&
            existingTemplate.profile_id === normalized.profileId
            ? existingTemplate.proof_token || ''
            : '',
        };
        await browserApi().storage.local.set({ [STORAGE_KEYS.template]: template });
      }
      const settings = {
        startYear: normalized.startYear,
        startMonth: normalized.startMonth,
        endYear: normalized.endYear,
        endMonth: normalized.endMonth,
        wantAccount: normalized.wantAccount,
        wantFills: normalized.wantFills,
        delayMs: normalized.delayMs,
      };
      if (typeof app.createProviderStorage === 'function') {
        await app.createProviderStorage(PROVIDER_ID).saveSettings(settings);
      } else {
        await browserApi().storage.local.set({ [STORAGE_KEYS.settings]: settings });
      }

      const documents = [];
      for (const { year, month } of monthsInRange(
        normalized.startYear,
        normalized.startMonth,
        normalized.endYear,
        normalized.endMonth
      )) {
        if (isStopped(controller)) break;
        const monthString = `${year}-${pad2(month)}`;
        for (const reportType of normalized.types) {
          if (isStopped(controller)) break;
          const type = REPORT_TYPES[reportType];
          const raw = {
            id: `${reportType}:${monthString}`,
            title: `${type.label} — ${monthString}`,
            category: reportType === 'account' ? 'statements' : 'trade-confirmations',
            date: `${monthString}-01`,
            filename: `CoinbaseProStatements/${type.folder}/${monthString}.pdf`,
            metadata: {
              reportType,
              periodStart: isoStartOfMonth(year, month),
              periodEnd: isoEndOfMonth(year, month),
              delayMs: normalized.delayMs,
            },
          };
          documents.push(typeof app.normalizeDocument === 'function'
            ? app.normalizeDocument(PROVIDER_ID, raw)
            : Object.assign({ provider: PROVIDER_ID }, raw));
        }
      }
      notify(report, 'discovered', `Found ${documents.length} Coinbase reports`, {
        count: documents.length,
      });
      return documents;
    },

    async downloadDocument(document, report, controller) {
      const metadata = document && document.metadata;
      if (!document || document.provider !== PROVIDER_ID || !metadata || !REPORT_TYPES[metadata.reportType]) {
        throw new Error('Invalid Coinbase document descriptor');
      }
      if (isStopped(controller)) throw cancellationError(controller);
      const template = await loadTemplate();
      if (!templateIsValid(template)) {
        throw new Error('Coinbase is not calibrated; click a PDF/CSV link once before downloading');
      }

      notify(report, 'generating', `Generating ${document.title}`, { document });
      const reportId = await withRetry(() => generateReport(template, document), report, document, controller);
      notify(report, 'preparing', `Waiting for ${document.title}`, { document });
      const fileUrl = await withRetry(() => pollUntilComplete(reportId, 30000, controller), report, document, controller);
      return {
        url: fileUrl,
        filename: document.filename,
      };
    },
  };

  app.providers.coinbase = provider;
})(globalThis);
