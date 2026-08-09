(function registerMeritainProvider(root) {
  'use strict';

  const app = root.FinancialStatementDownloader = root.FinancialStatementDownloader || {};
  app.providers = app.providers || {};

  const PROVIDER_ID = 'meritain';
  const ORIGIN = 'https://connect.meritain.com';
  const TOKEN_URL = `${ORIGIN}/Account/GetToken`;
  const SUMMARY_URL = `${ORIGIN}/api/claims/summary`;
  const DETAILS_URL = `${ORIGIN}/api/claims/details`;
  const DOWNLOAD_URL = `${ORIGIN}/Claim/DownloadDocument`;
  const PAGE_SIZE = 15;
  const CLAIM_TYPES = [
    { code: 'Medical', label: 'Medical EOBs' },
    { code: 'Rx', label: 'Rx EOBs' },
  ];
  const CLAIM_STATUSES = ['Inprocess', 'Processed', 'Awaitinginformation'];

  let accessToken = null;
  let accessTokenExpiresAt = 0;

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

  function sanitizeSegment(value, fallback) {
    const cleaned = String(value === undefined || value === null ? '' : value)
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/ /g, '-');
    return cleaned.replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || fallback;
  }

  function assertDateString(value, field) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new TypeError(`${field} must be a YYYY-MM-DD string`);
    }
    return value;
  }

  function isoToday() {
    return new Date().toISOString().slice(0, 10);
  }

  function toUsDate(isoDate) {
    const [year, month, day] = isoDate.split('-');
    return `${month}/${day}/${year}`;
  }

  function toIsoDate(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  }

  function parseSerializedJson(value) {
    if (typeof value === 'string') {
      return JSON.parse(value);
    }
    return value;
  }

  function pageScripts(doc) {
    if (!doc) return [];
    if (doc.scripts) return Array.from(doc.scripts);
    return Array.from(doc.querySelectorAll ? doc.querySelectorAll('script') : []);
  }

  function readMemberContext(doc = root.document) {
    const tokenElement = doc && doc.querySelector
      ? /** @type {HTMLInputElement|null} */ (doc.querySelector('[name="__RequestVerificationToken"]'))
      : null;
    const verificationToken = tokenElement && tokenElement.value;
    const script = pageScripts(doc).find((candidate) => /apiMemberParameters\s*=/.test(candidate.textContent || ''));
    const match = script && (script.textContent || '').match(/apiMemberParameters\s*=\s*(\{[\s\S]*?\});/);
    let parameters = null;
    if (match) {
      try {
        parameters = JSON.parse(match[1]);
      } catch (error) {
        throw new Error('Meritain member context was not valid JSON', { cause: error });
      }
    }

    const memberId = parameters && (parameters.MemberId || parameters.MemberID);
    const groupId = parameters && (parameters.GroupId || parameters.GroupID);
    const depNo = parameters && parameters.DepNo;
    if (!verificationToken || !memberId || groupId === undefined || depNo === undefined) {
      throw new Error('Open the Meritain member claims page so its session context can be read');
    }
    return {
      verificationToken: String(verificationToken),
      memberId: String(memberId),
      groupId: String(groupId),
      depNo: String(depNo),
    };
  }

  function clearAccessToken() {
    accessToken = null;
    accessTokenExpiresAt = 0;
  }

  async function getAccessToken(force = false) {
    if (!force && accessToken && Date.now() < accessTokenExpiresAt) {
      return accessToken;
    }

    const context = readMemberContext();
    const response = await fetchApi()(TOKEN_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=utf-8',
        __RequestVerificationToken: context.verificationToken,
      },
    });
    if (!response.ok) {
      const error = new Error(`Meritain token request failed (${response.status})`);
      error.status = response.status;
      error.sessionExpired = response.status === 401 || response.status === 403;
      throw error;
    }
    const payload = await response.json();
    if (!payload || typeof payload.token !== 'string' || payload.token.trim() === '') {
      throw new Error('Meritain did not return an API token');
    }
    const lifetimeSeconds = Number(payload.expiration);
    accessToken = payload.token;
    accessTokenExpiresAt = Date.now() + Math.max(30, (Number.isFinite(lifetimeSeconds) ? lifetimeSeconds : 300) - 60) * 1000;
    return accessToken;
  }

  function appendFormValue(form, name, value) {
    if (Array.isArray(value)) {
      value.forEach((entry) => form.append(name, entry === undefined || entry === null ? '' : String(entry)));
      return;
    }
    form.append(name, value === undefined || value === null ? '' : String(value));
  }

  /** @param {{method?: string, body?: any, json?: boolean, controller?: any, responseType?: string}} [options] */
  async function request(url, options = {}) {
    const { method = 'POST', body, json = false, controller, responseType = 'json' } = options;
    if (isStopped(controller)) throw cancellationError(controller);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getAccessToken(attempt === 1);
      const headers = {
        Accept: responseType === 'bytes' ? 'application/pdf' : 'application/json',
        Authorization: `Bearer ${token}`,
        Browser_Date: new Date().toString(),
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (json) headers['Content-Type'] = 'application/json';
      else if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

      const response = await fetchApi()(url, {
        method,
        credentials: 'include',
        headers,
        body,
      });
      if (response.status === 401 || response.status === 403) {
        clearAccessToken();
        if (attempt === 0) continue;
      }
      if (!response.ok) {
        const error = new Error(`Meritain request failed (${response.status})`);
        error.status = response.status;
        error.sessionExpired = response.status === 401 || response.status === 403;
        throw error;
      }
      if (responseType === 'bytes') {
        return new Uint8Array(await response.arrayBuffer());
      }
      return parseSerializedJson(await response.json());
    }
    throw new Error('Meritain request retry loop ended unexpectedly');
  }

  function postForm(url, fields, controller) {
    const form = new URLSearchParams();
    Object.entries(fields).forEach(([name, value]) => appendFormValue(form, name, value));
    return request(url, { body: form, controller });
  }

  function buildSummaryFields(context, options, startingRecord) {
    const fields = {
      'GroupID[]': [context.groupId],
      'ClaimTypes[]': options.docTypes,
      IsPaidByHRA: '',
      'ClaimStatus[]': CLAIM_STATUSES,
      ServiceFromDate: options.all ? '' : toUsDate(options.startDate),
      ServiceToDate: options.all ? '' : toUsDate(options.endDate),
      DepNo: context.depNo,
      MemberID: context.memberId,
      'RecordSetInformation[SortBy]': '',
      'RecordSetInformation[SortOrder]': 'Ascending',
      'RecordSetInformation[RecordSetStartingRecord]': startingRecord,
      'RecordSetInformation[RecordSetMaxCount]': PAGE_SIZE,
    };
    return fields;
  }

  function buildDocument(raw, context) {
    const claimNumber = String(raw.ClaimNumber || '').trim();
    const claimType = String(raw.ClaimType || '').trim();
    if (!claimNumber || !claimType) return null;
    const date = toIsoDate(raw.ServiceFromDate);
    const safeClaimNumber = sanitizeSegment(claimNumber, 'unknown-claim');
    return {
      id: `${claimType}:${claimNumber}:${context.depNo}`,
      title: `${claimType} EOB${date ? ` (${date})` : ''}`,
      category: 'EOB',
      date,
      account: 'Meritain member',
      filename: `Acct.EOB.Meritain/EOB_${safeClaimNumber}.pdf`,
      metadata: {
        claimNumber,
        claimType,
        depNo: context.depNo,
      },
    };
  }

  function disambiguateFilenames(documents) {
    const counts = new Map();
    return documents.map((document) => {
      const count = counts.get(document.filename) || 0;
      counts.set(document.filename, count + 1);
      if (count === 0) return document;
      return {
        ...document,
        filename: document.filename.replace(/\.pdf$/, `-${count + 1}.pdf`),
      };
    });
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
    const all = document.createElement('label');
    const allInput = document.createElement('input');
    allInput.type = 'checkbox';
    allInput.name = 'all';
    allInput.checked = state.all !== false;
    all.appendChild(allInput);
    all.appendChild(document.createTextNode('All available EOBs'));
    container.appendChild(all);

    const range = document.createElement('div');
    range.className = 'row';
    const startValue = state.startDate || `${new Date().getUTCFullYear() - 1}-01-01`;
    const endValue = state.endDate || isoToday();
    for (const [name, label, value] of [['startDate', 'From', startValue], ['endDate', 'To', endValue]]) {
      const field = document.createElement('label');
      field.textContent = label;
      const input = document.createElement('input');
      input.type = 'date';
      input.name = name;
      input.value = value;
      input.disabled = allInput.checked;
      field.appendChild(input);
      range.appendChild(field);
    }
    allInput.addEventListener('change', () => {
      range.querySelectorAll('input').forEach((input) => { input.disabled = allInput.checked; });
    });
    container.appendChild(range);

    const types = document.createElement('div');
    types.className = 'row';
    const selected = Array.isArray(state.docTypes) && state.docTypes.length
      ? state.docTypes
      : CLAIM_TYPES.map((entry) => entry.code);
    CLAIM_TYPES.forEach((entry) => {
      const field = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.codes = entry.code;
      input.checked = selected.includes(entry.code);
      field.appendChild(input);
      field.appendChild(document.createTextNode(entry.label));
      types.appendChild(field);
    });
    container.appendChild(types);

    const note = document.createElement('div');
    note.className = 'fsd-provider-status';
    note.textContent = 'Uses Meritain’s claims API and saves PDFs under Acct.EOB.Meritain.';
    container.appendChild(note);
  }

  async function readOptions(container) {
    const all = container.querySelector('input[name="all"]').checked;
    const startDate = container.querySelector('input[name="startDate"]').value;
    const endDate = container.querySelector('input[name="endDate"]').value;
    if (!all) {
      assertDateString(startDate, 'From date');
      assertDateString(endDate, 'To date');
      if (startDate > endDate) throw new RangeError('The From date must not be after the To date');
    }
    const docTypes = Array.from(container.querySelectorAll('input[type="checkbox"][data-codes]'))
      .filter((input) => input.checked)
      .map((input) => input.dataset.codes);
    if (docTypes.length === 0) throw new Error('Choose at least one EOB type');

    const settings = { all, startDate, endDate, docTypes };
    await storage().saveSettings(settings);
    return { ...settings, delayMs: 1500, jitterRatio: 0.6, attempts: 2 };
  }

  async function discoverDocuments(options = {}, report, controller) {
    const all = options.all !== false;
    const startDate = all ? null : assertDateString(options.startDate, 'options.startDate');
    const endDate = all ? null : assertDateString(options.endDate, 'options.endDate');
    if (!all && startDate > endDate) throw new RangeError('options.startDate must not be after options.endDate');
    const docTypes = Array.isArray(options.docTypes) && options.docTypes.length
      ? options.docTypes
      : CLAIM_TYPES.map((entry) => entry.code);
    if (docTypes.some((type) => !CLAIM_TYPES.some((entry) => entry.code === type))) {
      throw new TypeError('options.docTypes contains an unsupported Meritain claim type');
    }

    const context = readMemberContext();
    const requestOptions = { ...options, all, startDate, endDate, docTypes };
    const documents = [];
    const seen = new Set();
    let startingRecord = 0;
    let totalRecords = null;

    do {
      if (isStopped(controller)) throw cancellationError(controller);
      notify(report, 'discovery-progress', `Searching Meritain EOBs (records ${startingRecord + 1}–${startingRecord + PAGE_SIZE})…`, {
        startingRecord,
      });
      const payload = await postForm(SUMMARY_URL, buildSummaryFields(context, requestOptions, startingRecord), controller);
      const rows = Array.isArray(payload && payload.Data) ? payload.Data : [];
      const reportedTotal = Number(payload && (payload.TotalRecords || payload.TotalDisplayRecords));
      if (Number.isFinite(reportedTotal)) totalRecords = reportedTotal;
      rows.forEach((raw) => {
        if (!raw || !docTypes.includes(raw.ClaimType)) return;
        const document = buildDocument(raw, context);
        if (!document || seen.has(document.id)) return;
        if (!all && document.date && (document.date < startDate || document.date > endDate)) return;
        seen.add(document.id);
        documents.push(document);
      });
      startingRecord += PAGE_SIZE;
      if (rows.length === 0 || rows.length < PAGE_SIZE || (totalRecords !== null && startingRecord >= totalRecords)) break;
    } while (!isStopped(controller));

    if (isStopped(controller)) throw cancellationError(controller);
    notify(report, 'discovery-progress', `Meritain returned ${documents.length} EOB candidates.`, { count: documents.length });
    return disambiguateFilenames(documents);
  }

  function detailIsAvailable(payload) {
    const entity = payload && payload.Entity;
    if (!entity || entity.IsDocumentAvailable === false) return false;
    const documents = Array.isArray(entity.AssociatedDocuments) ? entity.AssociatedDocuments : [];
    if (documents.length === 0) return entity.IsDocumentAvailable !== false;
    return documents.some((document) => document
      && String(document.PlanDocumentType || '').toLowerCase() === 'eob'
      && document.IsDocumentAvailable !== false);
  }

  async function downloadDocument(document, report, controller) {
    if (isStopped(controller)) throw cancellationError(controller);
    const context = readMemberContext();
    const metadata = document.metadata || {};
    const claimNumber = String(metadata.claimNumber || '').trim();
    const claimType = String(metadata.claimType || '').trim();
    if (!claimNumber || !claimType) throw new TypeError('Meritain document metadata is incomplete');

    const detail = await postForm(DETAILS_URL, {
      ClaimType: claimType,
      ClaimNumber: claimNumber,
      DepNo: context.depNo,
    }, controller);
    if (!detailIsAvailable(detail)) {
      throw new Error('Meritain reports that this EOB is not available');
    }

    const planProductType = detail.Entity && detail.Entity.PlanProductType
      ? detail.Entity.PlanProductType
      : claimType;
    const bytes = await request(DOWNLOAD_URL, {
      method: 'POST',
      body: JSON.stringify({
        ClaimDocumentType: 'EOB',
        ClaimNumber: claimNumber,
        PlanProductType: planProductType,
        DepNo: Number(context.depNo),
        MemberID: context.memberId,
      }),
      json: true,
      responseType: 'bytes',
      controller,
    });
    if (bytes.length < 4 || String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') {
      throw new Error('Meritain returned a non-PDF document');
    }
    notify(report, 'download-progress', `Fetched ${document.title}.`);
    return {
      data: Array.from(bytes),
      contentType: 'application/pdf',
      filename: document.filename,
    };
  }

  function findMountPoint() {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
    return headings.find((heading) => /claim summary|claims/i.test(heading.textContent || ''))
      || document.querySelector('#ClaimSummaryGrid, #claimsTable, #claimsSearchDiv')
      || null;
  }

  /** @type {FsdProvider} */
  const provider = {
    id: PROVIDER_ID,
    label: 'Meritain EOBs',
    matches(url) {
      return typeof url === 'string'
        && /^https:\/\/connect\.meritain\.com\/Member\/MemberClaim\/ClaimSummary(?:[/?#]|$)/.test(url);
    },
    isSupportedPage() {
      return provider.matches(root.location ? root.location.href : '');
    },
    requiresDateRange: false,
    docTypes: CLAIM_TYPES,
    renderControls,
    readOptions,
    findMountPoint,
    loadState,
    discoverDocuments,
    downloadDocument,
  };

  provider.helpers = {
    assertDateString,
    buildDocument,
    buildSummaryFields,
    detailIsAvailable,
    disambiguateFilenames,
    parseSerializedJson,
    sanitizeSegment,
    toIsoDate,
    toUsDate,
    CLAIM_STATUSES,
    CLAIM_TYPES,
    PAGE_SIZE,
    SUMMARY_URL,
    DETAILS_URL,
    DOWNLOAD_URL,
    TOKEN_URL,
  };

  app.providers.meritain = provider;
})(globalThis);
