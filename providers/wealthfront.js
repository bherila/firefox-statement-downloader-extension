(function registerWealthfrontProvider(root) {
  'use strict';

  const app = root.FinancialStatementDownloader = root.FinancialStatementDownloader || {};
  app.providers = app.providers || {};

  const PROVIDER_ID = 'wealthfront';
  const ORIGIN = 'https://www.wealthfront.com';

  // Both listings are plain authenticated GETs that return the entire corpus;
  // neither takes a date range or a page cursor. The documents page paginates
  // what it already holds in memory, so scraping its table would page through
  // data the extension can simply ask for once.
  const STATEMENTS_URL = `${ORIGIN}/api/documents/statements`;
  const TAX_FORMS_URL = `${ORIGIN}/api/documents/tax-forms-data`;

  const STATEMENT_FOLDER = 'Statements';
  const CONFIRM_FOLDER = 'Trade-Confirmations';
  const TAX_FOLDER = 'Tax-Forms';
  const UNKNOWN_ACCOUNT = 'Unknown-Account';

  // The API's statement types collapse into two customer-facing groups. A type
  // missing from this map still downloads; it just files under Statements.
  const STATEMENT_TYPES = {
    STATEMENT: { group: 'STATEMENTS', label: 'Statement' },
    GREEN_DOT_STATEMENT: { group: 'STATEMENTS', label: 'Cash-Statement' },
    INTERIM_STATEMENT: { group: 'STATEMENTS', label: 'Interim-Statement' },
    CONFIRM: { group: 'CONFIRM', label: 'Trade-Confirmation' },
  };

  const DOC_TYPES = [
    { code: 'STATEMENTS', label: 'Statements' },
    { code: 'CONFIRM', label: 'Trade confirmations' },
    { code: 'TAX', label: 'Tax forms' },
  ];

  // Trade confirmations outnumber everything else several times over, so they
  // are offered but not preselected.
  const DEFAULT_DOC_TYPES = ['STATEMENTS', 'TAX'];

  function fetchApi() {
    if (typeof root.fetch !== 'function') {
      throw new Error('fetch is unavailable');
    }
    return root.fetch.bind(root);
  }

  function isStopped(controller) {
    return Boolean(app.isStopped ? app.isStopped(controller) : controller && controller.stopped);
  }

  function cancellationError(controller) {
    const error = new Error((controller && controller.reason) || 'stopped by user');
    error.stopped = true;
    return error;
  }

  function notify(report, type, message, extra) {
    if (typeof report === 'function') {
      report(Object.assign({ type, provider: PROVIDER_ID, message }, extra || {}));
    }
  }

  async function getJson(url, controller) {
    if (isStopped(controller)) throw cancellationError(controller);
    const response = await fetchApi()(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const error = new Error(`Wealthfront request failed (${response.status})`);
      error.status = response.status;
      error.sessionExpired = response.status === 401 || response.status === 403;
      throw error;
    }
    return response.json();
  }

  function sanitizeSegment(value, fallback) {
    const cleaned = String(value === undefined || value === null ? '' : value)
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/ /g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    return cleaned || fallback;
  }

  // Statement dates arrive as a bare YYYYMMDD string.
  function toIsoDate(compact) {
    const text = String(compact === undefined || compact === null ? '' : compact);
    if (!/^\d{8}$/.test(text)) return null;
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  function assertDateString(value, field) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new TypeError(`${field} must be a YYYY-MM-DD string`);
    }
    return value;
  }

  function accountIndexFromStatements(payload) {
    const index = new Map();
    const accounts = (payload && payload.validAccountsToRequestStatement) || [];
    for (const account of accounts) {
      if (account && account.account_id) {
        index.set(String(account.account_id), account.display_name || String(account.account_id));
      }
    }
    return index;
  }

  function accountFolder(accountId, accountNames) {
    const name = accountNames.get(String(accountId));
    return sanitizeSegment(name || accountId, UNKNOWN_ACCOUNT);
  }

  function buildStatementDocument(raw, accountNames) {
    const mapping = STATEMENT_TYPES[raw.type]
      || { group: 'STATEMENTS', label: sanitizeSegment(raw.type, 'Document') };
    const date = toIsoDate(raw.date) || 'undated';
    const folder = accountFolder(raw.accountId, accountNames);

    // Confirmations run to hundreds per account, so they get a year level to
    // keep any one directory browsable. Statements are few enough to stay flat.
    const path = mapping.group === 'CONFIRM'
      ? `${folder}/${CONFIRM_FOLDER}/${date.slice(0, 4)}`
      : `${folder}/${STATEMENT_FOLDER}`;

    return {
      id: raw.externalId,
      title: `${date} ${mapping.label.replace(/-/g, ' ')}`,
      category: mapping.group,
      date,
      account: accountNames.get(String(raw.accountId)) || String(raw.accountId),
      filename: `Wealthfront/${path}/${date}_${mapping.label}.pdf`,
      metadata: {
        group: mapping.group,
        rawType: raw.type,
        accountId: raw.accountId,
        url: `${ORIGIN}/documents/${raw.accountId}/document/${raw.externalId}`,
      },
    };
  }

  function taxFileExtension(type) {
    return /_XLS$/.test(String(type)) ? 'xls' : 'pdf';
  }

  function taxFormLabel(type) {
    // FORM_1099_CORRECTION_PDF -> Form-1099-Correction
    const words = String(type).replace(/_(PDF|XLS)$/, '').replace(/_/g, ' ').toLowerCase()
      .replace(/\b\w/g, (character) => character.toUpperCase());
    return sanitizeSegment(words, 'Tax-Form');
  }

  function buildTaxDocuments(payload, accountNames) {
    const documents = [];
    const files = (payload && payload.files) || {};

    for (const [accountId, entry] of Object.entries(files)) {
      const byYear = (entry && entry.documents) || {};
      for (const [year, byType] of Object.entries(byYear)) {
        for (const [type, records] of Object.entries(byType || {})) {
          const list = Array.isArray(records) ? records : [records];
          list.forEach((record, position) => {
            // idx is the server's own ordinal for same-year duplicates such as a
            // reissued correction, and is what the download URL keys on.
            const index = record && record.index !== undefined ? record.index : position;
            const extension = taxFileExtension(type);
            const label = taxFormLabel(type);
            const folder = accountFolder(accountId, accountNames);
            documents.push({
              id: `${accountId}-${year}-${type}-${index}`,
              title: `${year} ${label.replace(/-/g, ' ')}`,
              category: 'TAX',
              date: toIsoDate(record && record.docDate) || `${year}-12-31`,
              account: accountNames.get(String(accountId)) || String(accountId),
              filename: `Wealthfront/${folder}/${TAX_FOLDER}/${year}_${label}.${extension}`,
              metadata: {
                group: 'TAX',
                rawType: type,
                accountId: Number(accountId),
                taxYear: year,
                url: `${ORIGIN}/documents/${accountId}/${year}/${type}?idx=${index}`,
              },
            });
          });
        }
      }
    }
    return documents;
  }

  function withinRange(document, startDate, endDate) {
    return document.date >= startDate && document.date <= endDate;
  }

  function disambiguateFilenames(documents) {
    const counts = new Map();
    for (const document of documents) {
      const taken = counts.get(document.filename) || 0;
      counts.set(document.filename, taken + 1);
      if (taken > 0) {
        document.filename = document.filename.replace(/(\.[a-z0-9]+)$/i, `-${taken + 1}$1`);
      }
    }
    return documents;
  }

  async function discoverDocuments(options = {}, report, controller) {
    const startDate = assertDateString(options.startDate, 'options.startDate');
    const endDate = assertDateString(options.endDate, 'options.endDate');
    if (startDate > endDate) {
      throw new RangeError('options.startDate must not be after options.endDate');
    }

    const selected = Array.isArray(options.docTypes) && options.docTypes.length
      ? options.docTypes
      : DEFAULT_DOC_TYPES;

    notify(report, 'discovery-progress', 'Loading Wealthfront documents…');
    const statementsPayload = await getJson(STATEMENTS_URL, controller);
    const accountNames = accountIndexFromStatements(statementsPayload);

    const documents = [];

    const wantsStatements = selected.includes('STATEMENTS');
    const wantsConfirms = selected.includes('CONFIRM');
    if (wantsStatements || wantsConfirms) {
      for (const raw of statementsPayload.statements || []) {
        if (!raw || !raw.externalId) continue;
        const document = buildStatementDocument(raw, accountNames);
        if (document.category === 'STATEMENTS' && !wantsStatements) continue;
        if (document.category === 'CONFIRM' && !wantsConfirms) continue;
        documents.push(document);
      }
    }

    if (selected.includes('TAX')) {
      if (isStopped(controller)) throw cancellationError(controller);
      notify(report, 'discovery-progress', 'Loading Wealthfront tax forms…');
      const taxPayload = await getJson(TAX_FORMS_URL, controller);
      // Tax forms carry their own account name map; a closed account can still
      // have forms while being absent from the statements account list.
      const names = new Map(accountNames);
      for (const [id, name] of Object.entries(taxPayload.accountIdsToAccountNames || {})) {
        if (!names.has(String(id))) names.set(String(id), name);
      }
      documents.push(...buildTaxDocuments(taxPayload, names));
    }

    const filtered = documents.filter((document) => withinRange(document, startDate, endDate));
    filtered.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    disambiguateFilenames(filtered);

    notify(report, 'discovery-progress', `Found ${filtered.length} Wealthfront documents.`, {
      count: filtered.length,
    });
    return filtered;
  }

  async function downloadDocument(document) {
    const metadata = document && document.metadata;
    if (!document || document.provider !== PROVIDER_ID || !metadata || !metadata.url) {
      throw new Error('Invalid Wealthfront document descriptor');
    }
    // Wealthfront serves documents directly at a stable authenticated URL, so
    // the download goes straight to the browser without buffering bytes.
    return { url: metadata.url, filename: document.filename };
  }

  function isoToday() {
    return new Date().toISOString().slice(0, 10);
  }

  function isoYearsAgo(years) {
    const date = new Date();
    date.setUTCFullYear(date.getUTCFullYear() - years);
    return date.toISOString().slice(0, 10);
  }

  function storage() {
    return app.createProviderStorage(PROVIDER_ID);
  }

  async function loadState() {
    const settings = await storage().loadSettings();
    return settings || {};
  }

  function renderControls(container, state = {}) {
    container.textContent = '';

    const range = document.createElement('div');
    range.className = 'row';
    for (const [name, label, value] of [
      ['startDate', 'From', state.startDate || isoYearsAgo(1)],
      ['endDate', 'To', state.endDate || isoToday()],
    ]) {
      const field = document.createElement('label');
      field.textContent = label;
      const input = document.createElement('input');
      input.type = 'date';
      input.name = name;
      input.value = value;
      field.appendChild(input);
      range.appendChild(field);
    }
    container.appendChild(range);

    const types = document.createElement('div');
    types.className = 'row';
    const selected = Array.isArray(state.docTypes) && state.docTypes.length
      ? state.docTypes
      : DEFAULT_DOC_TYPES;
    for (const docType of DOC_TYPES) {
      const field = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.codes = docType.code;
      input.checked = selected.includes(docType.code);
      field.appendChild(input);
      field.appendChild(document.createTextNode(docType.label));
      types.appendChild(field);
    }
    container.appendChild(types);

    const note = document.createElement('div');
    note.className = 'fsd-provider-status';
    note.textContent = 'Trade confirmations are numerous; selecting them makes for a much longer run.';
    container.appendChild(note);
  }

  async function readOptions(container) {
    const startDate = container.querySelector('input[name="startDate"]').value;
    const endDate = container.querySelector('input[name="endDate"]').value;
    assertDateString(startDate, 'From date');
    assertDateString(endDate, 'To date');
    if (startDate > endDate) {
      throw new RangeError('The From date must not be after the To date');
    }

    const docTypes = [];
    for (const input of container.querySelectorAll('input[type="checkbox"][data-codes]')) {
      if (input.checked) docTypes.push(input.dataset.codes);
    }
    if (docTypes.length === 0) {
      throw new Error('Choose at least one document type');
    }

    await storage().saveSettings({ startDate, endDate, docTypes });
    return { startDate, endDate, docTypes, delayMs: 1500, jitterRatio: 0.6 };
  }

  function findMountPoint() {
    return document.querySelector('select[name="selectedDocumentType"]')
      || document.querySelector('select[name="selectedAccountId"]')
      || null;
  }

  const provider = {
    id: PROVIDER_ID,
    label: 'Wealthfront',
    matches(url) {
      return typeof url === 'string' && /^https:\/\/www\.wealthfront\.com\/documents/.test(url);
    },
    requiresDateRange: true,
    docTypes: DOC_TYPES,
    renderControls,
    readOptions,
    findMountPoint,
    loadState,
    discoverDocuments,
    downloadDocument,
  };

  provider.helpers = {
    sanitizeSegment,
    toIsoDate,
    assertDateString,
    accountIndexFromStatements,
    accountFolder,
    buildStatementDocument,
    buildTaxDocuments,
    taxFileExtension,
    taxFormLabel,
    withinRange,
    disambiguateFilenames,
    DOC_TYPES,
    DEFAULT_DOC_TYPES,
    STATEMENTS_URL,
    TAX_FORMS_URL,
  };

  app.providers.wealthfront = provider;
})(globalThis);
