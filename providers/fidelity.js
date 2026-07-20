(function registerFidelityProvider(root) {
  'use strict';

  const app = root.FinancialStatementDownloader = root.FinancialStatementDownloader || {};
  app.providers = app.providers || {};

  const PROVIDER_ID = 'fidelity';

  // Fidelity splits the document APIs across two hosts. Sending a request to the
  // wrong one fails with an opaque 400, so the host is pinned per endpoint.
  const DOCS_HOST = 'https://digitalservices.fidelity.com';
  const DP_HOST = 'https://dpservice.fidelity.com';

  const LIST_URL = `${DOCS_HOST}/ftgw/dp/retail-am-financialdoc/v1/accounts/communications/financial-documents/statements`;
  const DOWNLOAD_URL = `${DOCS_HOST}/ftgw/dp/retail-am-financialdoc/v2/accounts/communications/financial-documents/download`;
  const ACCOUNTS_URL = `${DP_HOST}/ftgw/dp/customer-am-acctnxt/v2/accounts`;

  // The APIs authenticate on session cookies but reject requests that lack the
  // Document Access Hub application identity headers.
  const API_HEADERS = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    appid: 'AP160308',
    appname: 'Document Access Hub',
    'fid-originating-app-id': 'AP160308',
    'fid-originating-app-version': '1',
  };

  const ACCOUNT_CATEGORIES = [
    'Brokerage', 'StockPlans', 'Annuity', 'Charitable', 'FidelityCreditCards',
    'InternalDigital', 'BrokerageLending', 'RegisteredStock', 'WorkplaceBenefits',
    'WorkplaceContributions',
  ].join(',');

  // All four share the list endpoint's contract. AC returns nothing for some
  // customers but the page queries it regardless, so it stays in the sweep.
  const DOC_TYPES = [
    { code: 'STMT', label: 'Statements' },
    { code: 'TC', label: 'Trade confirmations' },
    { code: 'AR', label: 'Account records' },
    { code: 'AC', label: 'Account records' },
  ];

  // Householded documents carry no acctNum, and the download endpoint validates
  // acctType against a fixed set; Brokerage is the value the site sends for them.
  const HOUSEHOLD_ACCT_TYPE = 'Brokerage';
  const HOUSEHOLD_FOLDER = 'Household';
  // Account records (AR) are customer-level documents such as name changes.
  // They carry neither acctNum nor a household flag, which is expected rather
  // than a data problem; the site's own table omits the Account column for them.
  const CUSTOMER_FOLDER = 'Customer-Records';

  const { normalizeDocument, sleep } = app;

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

  async function postJson(url, body, controller) {
    if (isStopped(controller)) throw cancellationError(controller);
    const response = await fetchApi()(url, {
      method: 'POST',
      credentials: 'include',
      headers: API_HEADERS,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = new Error(`Fidelity request failed (${response.status})`);
      error.status = response.status;
      // 401/403 here means the session lapsed rather than a transient fault.
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

  function toIsoDate(epochSeconds) {
    if (!Number.isFinite(epochSeconds)) return null;
    // Period boundaries arrive as epoch seconds in Fidelity's local time; using
    // the UTC date keeps filenames stable regardless of the viewer's timezone.
    return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
  }

  function assertDateString(value, field) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new TypeError(`${field} must be a YYYY-MM-DD string`);
    }
    return value;
  }

  function collectAccounts(payload) {
    const accounts = [];
    const seen = new Set();
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node.acctNum && !seen.has(node.acctNum)) {
        seen.add(node.acctNum);
        accounts.push(node);
      }
      Object.values(node).forEach(walk);
    })(payload);
    return accounts;
  }

  async function loadAccountIndex(controller) {
    const payload = await postJson(ACCOUNTS_URL, {
      acctCategory: ACCOUNT_CATEGORIES,
      filters: {
        returnCustomerAttrDetail: true,
        returnPreferenceDetail: true,
        returnAcctRelAttrDetail: true,
        returnAcctIndDetail: true,
        returnOrderedAccounts: true,
        returnAcctStateDetail: true,
      },
    }, controller);

    const index = new Map();
    for (const account of collectAccounts(payload)) {
      const preference = account.preferenceDetail || {};
      // preferenceDetail.name is what the site shows the customer; the other two
      // are progressively less friendly fallbacks.
      const label = preference.name || preference.defaultAcctName || account.acctSubTypeDesc || account.acctNum;
      index.set(account.acctNum, {
        acctNum: account.acctNum,
        acctType: account.acctType || HOUSEHOLD_ACCT_TYPE,
        label,
      });
    }
    return index;
  }

  function listDocDetails(payload) {
    const detail = payload
      && payload.statement
      && payload.statement.docDetails
      && payload.statement.docDetails.docDetail;
    if (!detail) return [];
    return Array.isArray(detail) ? detail : [detail];
  }

  function resolveScope(raw, accountIndex) {
    if (raw.isHouseholded) {
      return { scope: 'household', folder: HOUSEHOLD_FOLDER, label: HOUSEHOLD_FOLDER, acctType: HOUSEHOLD_ACCT_TYPE };
    }
    if (!raw.acctNum) {
      return { scope: 'customer', folder: CUSTOMER_FOLDER, label: CUSTOMER_FOLDER, acctType: HOUSEHOLD_ACCT_TYPE };
    }
    const account = accountIndex.get(raw.acctNum);
    if (!account) {
      // Closed accounts still have documents but are absent from the account
      // list. Filing under the bare number beats discarding the document.
      return {
        scope: 'account',
        folder: sanitizeSegment(raw.acctNum, 'Unknown-Account'),
        label: raw.acctNum,
        acctType: HOUSEHOLD_ACCT_TYPE,
      };
    }
    return {
      scope: 'account',
      folder: sanitizeSegment(`${account.label}-${raw.acctNum}`, raw.acctNum),
      label: account.label,
      acctType: account.acctType,
    };
  }

  function buildDocument(raw, docTypeCode, accountIndex) {
    const { scope, folder, label, acctType } = resolveScope(raw, accountIndex);
    const isHousehold = scope === 'household';

    const date = toIsoDate(raw.periodEndDate) || toIsoDate(raw.generatedDate) || 'undated';
    const typeLabel = sanitizeSegment(raw.type, docTypeCode);
    const title = `${date} ${raw.type || docTypeCode}`;

    return {
      id: raw.id,
      title,
      category: docTypeCode,
      date,
      account: label,
      filename: `Fidelity/${folder}/${date}_${typeLabel}.pdf`,
      metadata: {
        docType: docTypeCode,
        acctType,
        acctNum: raw.acctNum || null,
        householdNum: raw.householdNum || null,
        isHouseholded: isHousehold,
        scope,
        rawType: raw.type || null,
      },
    };
  }

  // Distinct documents can share a date and type — a customer may have several
  // "Customer Name Change" records generated the same day. Numbering them here
  // keeps names stable across runs, which the browser's own "(1)" suffixing
  // would not: that depends on what is already on disk.
  function disambiguateFilenames(documents) {
    const counts = new Map();
    for (const document of documents) {
      const taken = counts.get(document.filename) || 0;
      counts.set(document.filename, taken + 1);
      if (taken > 0) {
        document.filename = document.filename.replace(/\.pdf$/, `-${taken + 1}.pdf`);
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

    notify(report, 'discovery-progress', 'Loading Fidelity accounts…');
    const accountIndex = await loadAccountIndex(controller);

    const requested = Array.isArray(options.docTypes) && options.docTypes.length
      ? DOC_TYPES.filter((entry) => options.docTypes.includes(entry.code))
      : DOC_TYPES;

    const documents = [];
    const seen = new Set();

    for (const docType of requested) {
      if (isStopped(controller)) throw cancellationError(controller);
      notify(report, 'discovery-progress', `Searching ${docType.label}…`, { docType: docType.code });

      const payload = await postJson(LIST_URL, {
        startDate,
        endDate,
        docType: docType.code,
        hasCryptoAccount: false,
        annuityAccountLookup: true,
      }, controller);

      for (const raw of listDocDetails(payload)) {
        if (!raw || !raw.id) continue;
        // The document id is stable and unique. Household and per-account copies
        // of the same period have different ids, so both are kept on purpose.
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        documents.push(buildDocument(raw, docType.code, accountIndex));
      }
    }

    disambiguateFilenames(documents);

    notify(report, 'discovery-progress', `Found ${documents.length} Fidelity documents.`, {
      count: documents.length,
    });
    return documents;
  }

  function decodeBase64(content) {
    if (typeof root.atob !== 'function') {
      throw new Error('atob is unavailable');
    }
    const binary = root.atob(content);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function looksLikePdf(bytes) {
    return bytes.length > 4
      && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }

  async function downloadDocument(document, report, controller) {
    const metadata = document && document.metadata;
    if (!document || document.provider !== PROVIDER_ID || !metadata || !metadata.docType) {
      throw new Error('Invalid Fidelity document descriptor');
    }
    if (isStopped(controller)) throw cancellationError(controller);

    const payload = await postJson(DOWNLOAD_URL, {
      id: document.id,
      formatType: 'PDF',
      docType: metadata.docType,
      acctType: metadata.acctType,
    }, controller);

    const detail = payload && payload.document && payload.document.docDetail;
    if (!detail || typeof detail.content !== 'string' || detail.content === '') {
      throw new Error('Fidelity returned no document content');
    }

    const bytes = decodeBase64(detail.content);
    // The response advertises deflated:"Y" even for plain PDFs, so trust the
    // magic bytes instead and fail loudly rather than writing a corrupt file.
    if (!looksLikePdf(bytes)) {
      throw new Error('Fidelity returned content that is not a PDF');
    }

    return {
      data: bytes,
      contentType: detail.contentType || 'application/pdf',
      filename: document.filename,
    };
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
    // Documents reach back to 2011, but defaulting to all of it would make the
    // common case (recent documents) the slowest one.
    const startValue = state.startDate || isoYearsAgo(1);
    const endValue = state.endDate || isoToday();
    for (const [name, label, value] of [
      ['startDate', 'From', startValue],
      ['endDate', 'To', endValue],
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
      : DOC_TYPES.map((entry) => entry.code);
    // AR and AC are both "Account records" to the customer; showing the codes
    // would leak an implementation detail, so they share one checkbox.
    const choices = [
      { codes: ['STMT'], label: 'Statements' },
      { codes: ['TC'], label: 'Trade confirmations' },
      { codes: ['AR', 'AC'], label: 'Account records' },
    ];
    for (const choice of choices) {
      const field = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.codes = choice.codes.join(',');
      input.checked = choice.codes.some((code) => selected.includes(code));
      field.appendChild(input);
      field.appendChild(document.createTextNode(choice.label));
      types.appendChild(field);
    }
    container.appendChild(types);

    const note = document.createElement('div');
    note.className = 'fsd-provider-status';
    note.textContent = 'Employer documents live on NetBenefits and are not covered here.';
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
      if (input.checked) docTypes.push(...input.dataset.codes.split(','));
    }
    if (docTypes.length === 0) {
      throw new Error('Choose at least one document type');
    }

    await storage().saveSettings({ startDate, endDate, docTypes });
    return {
      startDate,
      endDate,
      docTypes,
      // Spread requests out; a burst across 1,000+ documents is what would draw
      // attention, and the whole job is unattended anyway.
      delayMs: 1500,
      jitterRatio: 0.6,
    };
  }

  function findMountPoint() {
    // Anchor next to the site's own date filter so the button sits with the
    // controls it complements.
    return document.querySelector('#options-select-TimeFilter')
      || document.querySelector('table.pvd-table__table')
      || null;
  }

  const provider = {
    id: PROVIDER_ID,
    label: 'Fidelity',
    renderControls,
    readOptions,
    findMountPoint,
    loadState,
    // The document center is the only origin where these APIs are same-site.
    matches(url) {
      return typeof url === 'string' && /^https:\/\/digitalservices\.fidelity\.com\/navigate\/ent-documentcenter\//.test(url);
    },
    requiresDateRange: true,
    docTypes: DOC_TYPES,
    discoverDocuments,
    downloadDocument,
  };

  provider.helpers = {
    sanitizeSegment,
    toIsoDate,
    buildDocument,
    resolveScope,
    disambiguateFilenames,
    listDocDetails,
    collectAccounts,
    decodeBase64,
    looksLikePdf,
    assertDateString,
    DOC_TYPES,
    API_HEADERS,
    LIST_URL,
    DOWNLOAD_URL,
    ACCOUNTS_URL,
  };

  app.providers.fidelity = provider;
})(globalThis);
