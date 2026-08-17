(function registerEtradeProvider(root) {
  'use strict';

  const app = root.FinancialStatementDownloader = root.FinancialStatementDownloader || {};
  app.providers = app.providers || {};

  const PROVIDER_ID = 'etrade';
  const PAGE_ORIGIN = 'https://us.etrade.com';
  const TOKEN_URL = `${PAGE_ORIGIN}/phx/authn/session/oauth2/token`;
  const API_ROOT = 'https://ext-web.etrade.com/etaz/api/adsal/accountdocs';
  const METADATA_URL = `${API_ROOT}/usermetadata`;
  const SEARCH_URL = `${API_ROOT}/v2/searchItems`;
  const MAX_PAGES = 1000;

  const DOC_TYPES = [
    { code: 'ClientStatements', label: 'Statements' },
    { code: 'TradeConfirmations', label: 'Trade confirmations' },
    { code: 'TaxDocuments', label: 'Tax forms' },
    { code: 'GeneralCorrespondence', label: 'Correspondence' },
  ];
  const DOC_TYPE_INDEX = new Map(DOC_TYPES.map((entry) => [entry.code, entry]));
  const FOLDERS = {
    ClientStatements: 'Statements',
    TradeConfirmations: 'Trade-Confirmations',
    TaxDocuments: 'Tax-Forms',
    GeneralCorrespondence: 'Correspondence',
  };

  let metadataCache = null;
  let accessTokenCache = null;

  function storage() {
    return app.createProviderStorage(PROVIDER_ID);
  }

  function fetchApi() {
    if (typeof root.fetch !== 'function') throw new Error('fetch is unavailable');
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

  function randomHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      root.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').slice(0, length);
  }

  function requestCoordinates() {
    const uuid = root.crypto && typeof root.crypto.randomUUID === 'function'
      ? root.crypto.randomUUID()
      : `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-a${randomHex(3)}-${randomHex(12)}`;
    return {
      RequestID: `${uuid}${randomHex(3)}`,
      SeqID: String(1000 + Math.floor(Math.random() * 9000)),
    };
  }

  function apiUrl(url) {
    const result = new URL(url);
    const coordinates = requestCoordinates();
    result.searchParams.set('RequestID', coordinates.RequestID);
    result.searchParams.set('SeqID', coordinates.SeqID);
    return result.href;
  }

  function pageWindow() {
    return root.wrappedJSObject || root;
  }

  function pageSessionValue() {
    const page = pageWindow();
    const configs = [page.pageConfig, page.page];
    for (const config of configs) {
      if (config && typeof config.uaa_vt === 'string' && config.uaa_vt) return config.uaa_vt;
    }
    return null;
  }

  function sessionNotReady(message) {
    const error = new Error(message);
    error.sessionExpired = true;
    return error;
  }

  async function accessToken() {
    if (accessTokenCache && accessTokenCache.expiresAt - Date.now() > 60000) {
      return accessTokenCache.value;
    }
    const sessionValue = pageSessionValue();
    if (!sessionValue) {
      throw sessionNotReady('E*TRADE page session is not ready; wait for Documents to load, then try again');
    }
    const response = await fetchApi()(TOKEN_URL, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        stk1: sessionValue,
      },
      body: JSON.stringify({ scope: ['accountdocuments'] }),
    });
    if (!response.ok) {
      const error = new Error(`E*TRADE token request failed (${response.status})`);
      error.status = response.status;
      error.sessionExpired = response.status === 401 || response.status === 403;
      throw error;
    }
    const payload = await response.json();
    if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) {
      throw sessionNotReady('E*TRADE returned an invalid document access token');
    }
    const expiresAt = Number(payload.access_token_expires_at);
    accessTokenCache = {
      value: payload.access_token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 300000,
    };
    return accessTokenCache.value;
  }

  function deviceHeaders(requireFingerprint) {
    const page = pageWindow();
    let values;
    try {
      values = typeof page.getDeviceFootPrint === 'function'
        ? page.getDeviceFootPrint.call(page)
        : null;
    } catch (error) {
      throw new Error('E*TRADE device fingerprint could not be generated', { cause: error });
    }
    const footprint = values && String(values.DeviceFootPrint || '');
    if (requireFingerprint && !footprint) {
      throw sessionNotReady('E*TRADE device fingerprint is not ready; wait for Documents to load, then try again');
    }
    return {
      ...(footprint ? { 'X-Device-Footprint': footprint } : {}),
    };
  }

  async function sessionHeaders(requireFingerprint) {
    const token = await accessToken();
    return {
      Accept: 'application/json',
      ['Authorization']: `Bearer ${token}`,
      ...deviceHeaders(requireFingerprint),
    };
  }

  async function getJson(url, init, controller, requireFingerprint = true) {
    if (isStopped(controller)) throw cancellationError(controller);
    const headers = await sessionHeaders(requireFingerprint);
    const response = await fetchApi()(apiUrl(url), {
      credentials: 'include',
      cache: 'no-store',
      ...init,
      headers: { ...headers, ...(init && init.headers) },
    });
    if (!response.ok) {
      const error = new Error(`E*TRADE request failed (${response.status})`);
      error.status = response.status;
      error.sessionExpired = response.status === 401 || response.status === 403;
      error.blocked = error.sessionExpired || response.status === 409 || response.status === 429;
      if (error.sessionExpired) accessTokenCache = null;
      if (error.blocked && controller && typeof controller.stop === 'function') {
        controller.stop(error.sessionExpired
          ? 'E*TRADE session expired; reload Documents and try again'
          : 'E*TRADE refused the request; the run was stopped');
      }
      throw error;
    }
    return response.json();
  }

  async function postJson(url, body, controller) {
    return getJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, controller, true);
  }

  function validateMetadata(payload) {
    if (!payload || !Array.isArray(payload.accountList)
      || !Array.isArray(payload.documentMetaDataList)
      || !Array.isArray(payload.docTypeDateFilterList)) {
      throw new Error('E*TRADE returned malformed document metadata');
    }
    return payload;
  }

  async function getMetadata(controller) {
    if (!metadataCache) {
      metadataCache = validateMetadata(await getJson(METADATA_URL, {}, controller, false));
    }
    return metadataCache;
  }

  async function getMetadataWhenReady() {
    const attempts = 20;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await getMetadata();
      } catch (error) {
        const waitingForPageRequest = error && error.sessionExpired && !error.status;
        if (!waitingForPageRequest || attempt === attempts) throw error;
        await app.sleep(500);
      }
    }
    throw new Error('E*TRADE document metadata did not become ready');
  }

  function availableYears(metadata, docType) {
    const group = metadata.docTypeDateFilterList.find((entry) => (
      Array.isArray(entry.docTypes) && entry.docTypes.includes(docType)
    ));
    return [...new Set((group && group.dateFilters ? group.dateFilters : [])
      .map((entry) => String(entry.dateFilterName || ''))
      .filter((value) => /^\d{4}$/.test(value)))]
      .sort((a, b) => Number(b) - Number(a));
  }

  function allAvailableYears(metadata) {
    return [...new Set(DOC_TYPES.flatMap((entry) => availableYears(metadata, entry.code)))]
      .sort((a, b) => Number(b) - Number(a));
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

  function shortHash(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function toIsoDate(value) {
    const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }

  function optionalAttributes(raw) {
    return new Map((Array.isArray(raw.optionalAttributeList) ? raw.optionalAttributeList : [])
      .filter((entry) => entry && entry.fieldName)
      .map((entry) => [entry.fieldName, entry.displayValue]));
  }

  function accountIndex(metadata) {
    return new Map(metadata.accountList
      .filter((account) => account && account.keyAccount)
      .map((account) => [String(account.keyAccount), account.accountDisplayValue]));
  }

  function documentDescriptor(raw, attributes) {
    if (raw.documentTypeName === 'TradeConfirmations') {
      return [attributes.get('ActionType'), attributes.get('Symbol')]
        .filter(Boolean).join('-') || 'Trade-Confirmation';
    }
    if (raw.documentTypeName === 'TaxDocuments') {
      return attributes.get('AdditionalInformation') || raw.documentTitle || 'Tax-Document';
    }
    if (raw.documentTypeName === 'GeneralCorrespondence') {
      return raw.documentTitle || raw.documentDisplayName || 'Correspondence';
    }
    return 'Statement';
  }

  function buildDocument(raw, accounts) {
    if (!raw || !DOC_TYPE_INDEX.has(raw.documentTypeName) || !raw.documentId || !raw.keyAccountNo) {
      return null;
    }
    const attributes = optionalAttributes(raw);
    const rawDate = raw.documentTypeName === 'TaxDocuments'
      ? raw.documentLoadDate
      : raw.documentDate;
    if (!rawDate) return null;
    const date = toIsoDate(rawDate) || 'undated';
    const year = /^\d{4}/.test(date) ? date.slice(0, 4) : 'Undated';
    const accountName = accounts.get(String(raw.keyAccountNo));
    const accountFolder = sanitizeSegment(
      accountName,
      `Account-${shortHash(raw.keyAccountNo)}`,
    );
    const descriptor = sanitizeSegment(documentDescriptor(raw, attributes), 'Document');
    const suffix = shortHash([
      raw.documentTypeName, raw.keyAccountNo, raw.documentId, rawDate,
    ].join('|'));
    const label = DOC_TYPE_INDEX.get(raw.documentTypeName).label;
    return {
      provider: PROVIDER_ID,
      id: `${raw.documentTypeName}:${raw.keyAccountNo}:${raw.documentId}:${rawDate || ''}`,
      title: `${date} ${label}`,
      category: raw.documentTypeName,
      date,
      account: accountName || 'Unknown account',
      filename: `ETrade/${accountFolder}/${FOLDERS[raw.documentTypeName]}/${year}/${date}_${descriptor}_${suffix}.pdf`,
      metadata: {
        docType: raw.documentTypeName,
        documentId: String(raw.documentId),
        keyAccountNo: String(raw.keyAccountNo),
        date: String(rawDate || ''),
        docSeq: String(attributes.get('Sequence') || '0'),
        totalSeq: String(attributes.get('TotalSegments') || '0'),
      },
    };
  }

  function searchBody(docType, year, pageNum) {
    const filters = [
      { filterName: 'KeyAccountNo', values: ['All'] },
      { filterName: 'DocType', values: [docType] },
    ];
    if (docType !== 'TaxDocuments') {
      filters.push({ filterName: 'DocSubType', values: ['All'] });
    }
    return {
      TimeFrame: year,
      endDate: '',
      filters,
      pageNum: String(pageNum),
      sortBy: [
        { fieldName: docType === 'TaxDocuments' ? 'LoadDate' : 'DocDate', sortOrder: 'DESC' },
        { fieldName: 'KeyAccountNo', sortOrder: 'DESC' },
      ],
      startDate: '',
    };
  }

  function parseFound(value) {
    const result = Number.parseInt(String(value), 10);
    if (!Number.isInteger(result) || result < 0) {
      throw new Error('E*TRADE returned an invalid document count');
    }
    return result;
  }

  async function discoverDocuments(options = {}, report, controller) {
    const metadata = await getMetadata(controller);
    const selected = Array.isArray(options.docTypes) && options.docTypes.length
      ? [...new Set(options.docTypes)]
      : DOC_TYPES.map((entry) => entry.code);
    if (selected.some((type) => !DOC_TYPE_INDEX.has(type))) {
      throw new TypeError('options.docTypes contains an unsupported E*TRADE document type');
    }
    const years = allAvailableYears(metadata);
    const fromYear = String(options.fromYear || years[years.length - 1] || '');
    const toYear = String(options.toYear || years[0] || '');
    if (!/^\d{4}$/.test(fromYear) || !/^\d{4}$/.test(toYear)) {
      throw new TypeError('E*TRADE year range must use four-digit years');
    }
    if (fromYear > toYear) throw new RangeError('The From year must not be after the To year');

    const accounts = accountIndex(metadata);
    const documents = new Map();
    const pauseMs = options.paginationDelayMs === undefined ? 500 : options.paginationDelayMs;
    if (!Number.isFinite(pauseMs) || pauseMs < 0) {
      throw new RangeError('paginationDelayMs must be a non-negative number');
    }
    let requestCount = 0;

    for (const docType of selected) {
      const typeYears = availableYears(metadata, docType)
        .filter((year) => year >= fromYear && year <= toYear)
        .sort((a, b) => Number(b) - Number(a));
      for (const year of typeYears) {
        let pageNum = 1;
        let received = 0;
        let expectedTotal = null;
        const queryIds = new Set();
        while (true) {
          if (isStopped(controller)) throw cancellationError(controller);
          if (requestCount > 0 && pauseMs > 0) {
            await app.sleep(Math.round(pauseMs * (0.75 + Math.random() * 0.5)));
          }
          notify(report, 'provider-progress', `Searching ${DOC_TYPE_INDEX.get(docType).label}, ${year}, page ${pageNum}…`);
          const payload = await postJson(SEARCH_URL, searchBody(docType, year, pageNum), controller);
          const rawDocuments = Array.isArray(payload.defaultDocumentList)
            ? payload.defaultDocumentList
            : [];
          const total = parseFound(payload.numFound);
          if (expectedTotal !== null && total !== expectedTotal) {
            throw new Error('E*TRADE changed the document count during pagination');
          }
          expectedTotal = total;
          received += rawDocuments.length;
          for (const raw of rawDocuments) {
            const document = buildDocument(raw, accounts);
            if (!document) throw new Error('E*TRADE returned an incomplete document listing');
            queryIds.add(document.id);
            documents.set(document.id, document);
          }
          requestCount += 1;
          if (rawDocuments.length === 0 || received >= total) break;
          pageNum += 1;
          if (pageNum > MAX_PAGES) throw new Error('E*TRADE pagination exceeded its safety limit');
        }
        if (queryIds.size !== expectedTotal) {
          throw new Error(`E*TRADE reported ${expectedTotal} documents but returned ${queryIds.size} unique documents`);
        }
      }
    }

    return [...documents.values()].sort((a, b) => (
      b.date.localeCompare(a.date) || a.filename.localeCompare(b.filename)
    ));
  }

  function decodeBase64(value) {
    const encoded = String(value || '').replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
    if (!encoded) throw new Error('E*TRADE returned an empty document');
    let binary;
    try {
      binary = root.atob(encoded);
    } catch (error) {
      throw new Error('E*TRADE returned invalid base64 document data', { cause: error });
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function looksLikePdf(bytes) {
    return bytes.length >= 5
      && bytes[0] === 0x25
      && bytes[1] === 0x50
      && bytes[2] === 0x44
      && bytes[3] === 0x46
      && bytes[4] === 0x2d;
  }

  async function downloadDocument(document, report, controller) {
    if (isStopped(controller)) throw cancellationError(controller);
    const metadata = document && document.metadata;
    if (!metadata || !DOC_TYPE_INDEX.has(metadata.docType)
      || !metadata.documentId || !metadata.keyAccountNo || !metadata.date) {
      throw new Error('E*TRADE document metadata is incomplete');
    }
    const payload = await postJson(`${API_ROOT}/document/${metadata.docType}.pdf`, {
      docDetails: [{
        date: metadata.date,
        documentId: metadata.documentId,
        keyAccountNo: metadata.keyAccountNo,
      }],
      docSeq: String(metadata.docSeq || '0'),
      docType: metadata.docType,
      fileType: 'pdf',
      totalSeq: String(metadata.totalSeq || '0'),
    }, controller);
    const bytes = decodeBase64(payload.documentStream);
    if (!looksLikePdf(bytes)) throw new Error('E*TRADE response is not a PDF');
    notify(report, 'provider-progress', `Received ${document.title}.`);
    return { data: bytes, contentType: 'application/pdf', filename: document.filename };
  }

  async function loadState() {
    const [settings, metadata] = await Promise.all([
      storage().loadSettings(),
      getMetadataWhenReady(),
    ]);
    return { ...(settings || {}), metadata };
  }

  function appendYearOptions(select, years, selected) {
    for (const year of years) {
      const option = document.createElement('option');
      option.value = year;
      option.textContent = year;
      option.selected = year === selected;
      select.appendChild(option);
    }
  }

  function renderControls(container, state = {}) {
    container.textContent = '';
    const metadata = state.metadata;
    const years = metadata ? allAvailableYears(metadata) : [];
    if (years.length === 0) throw new Error('E*TRADE did not advertise any document years');
    const latest = years[0];
    const defaultFrom = years.includes(String(Number(latest) - 1))
      ? String(Number(latest) - 1)
      : latest;
    const fromYear = years.includes(state.fromYear) ? state.fromYear : defaultFrom;
    const toYear = years.includes(state.toYear) ? state.toYear : latest;

    const range = document.createElement('div');
    range.className = 'row';
    for (const [name, label, value] of [
      ['fromYear', 'From year', fromYear],
      ['toYear', 'To year', toYear],
    ]) {
      const field = document.createElement('label');
      field.textContent = label;
      const select = document.createElement('select');
      select.name = name;
      appendYearOptions(select, years, value);
      field.appendChild(select);
      range.appendChild(field);
    }
    container.appendChild(range);

    const selected = Array.isArray(state.docTypes) && state.docTypes.length
      ? state.docTypes
      : DOC_TYPES.map((entry) => entry.code);
    const types = document.createElement('div');
    types.className = 'row';
    for (const docType of DOC_TYPES) {
      const field = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.code = docType.code;
      input.checked = selected.includes(docType.code);
      field.appendChild(input);
      field.appendChild(document.createTextNode(docType.label));
      types.appendChild(field);
    }
    container.appendChild(types);

    const note = document.createElement('div');
    note.className = 'fsd-provider-status';
    note.textContent = 'Years come from E*TRADE and all accounts are included. Trade confirmations can make the run much longer.';
    container.appendChild(note);
  }

  async function readOptions(container) {
    const fromYear = container.querySelector('select[name="fromYear"]').value;
    const toYear = container.querySelector('select[name="toYear"]').value;
    if (fromYear > toYear) throw new RangeError('The From year must not be after the To year');
    const docTypes = Array.from(container.querySelectorAll('input[type="checkbox"][data-code]'))
      .filter((input) => input.checked)
      .map((input) => input.dataset.code);
    if (docTypes.length === 0) throw new Error('Choose at least one document type');
    await storage().saveSettings({ fromYear, toYear, docTypes });
    return {
      fromYear,
      toYear,
      docTypes,
      delayMs: 1600,
      jitterRatio: 0.7,
      attempts: 2,
    };
  }

  function findMountPoint() {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
    return headings.find((element) => /^(documents|statements|tax documents)$/i.test((element.textContent || '').trim()))
      || null;
  }

  /** @type {FsdProvider} */
  const provider = {
    id: PROVIDER_ID,
    label: 'E*TRADE',
    matches(url) {
      if (typeof url !== 'string') return false;
      try {
        const parsed = new URL(url);
        return parsed.origin === PAGE_ORIGIN && parsed.pathname === '/etx/pxy/accountdocs';
      } catch (error) {
        return false;
      }
    },
    isSupportedPage() {
      return provider.matches(root.location ? root.location.href : '');
    },
    findMountPoint,
    loadState,
    renderControls,
    readOptions,
    requiresDateRange: false,
    docTypes: DOC_TYPES,
    discoverDocuments,
    downloadDocument,
  };

  provider.helpers = {
    DOC_TYPES,
    METADATA_URL,
    SEARCH_URL,
    TOKEN_URL,
    accessToken,
    accountIndex,
    allAvailableYears,
    availableYears,
    buildDocument,
    decodeBase64,
    looksLikePdf,
    optionalAttributes,
    requestCoordinates,
    pageSessionValue,
    deviceHeaders,
    sanitizeSegment,
    searchBody,
    shortHash,
    toIsoDate,
  };

  app.providers.etrade = provider;
})(globalThis);
