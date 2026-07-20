(function registerNetBenefitsProvider(root) {
  'use strict';

  const app = root.FinancialStatementDownloader = root.FinancialStatementDownloader || {};
  app.providers = app.providers || {};

  const PROVIDER_ID = 'netbenefits';
  const ORIGIN = 'https://workplaceservices.fidelity.com';
  const SOD_URL = `${ORIGIN}/mybenefits/savings2/sod/soddetail`;
  const CHART_PATH = '/mybenefits/savings2/sod/chart';
  const TXN_URL = `${ORIGIN}/mybenefits/savings2/transactionhistory/download`;

  // NetBenefits keeps ten years minus a day, to the day, and the window rolls.
  const RETENTION_YEARS = 10;

  const GRANULARITIES = [
    { code: 'MONTHLY', label: 'Monthly' },
    { code: 'QUARTERLY', label: 'Quarterly' },
    { code: 'ANNUAL', label: 'Annual' },
  ];

  const STATEMENT_FOLDER = 'Statements';
  const TXN_FOLDER = 'Transactions';

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
      .replace(/ /g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    return cleaned || fallback;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function toIso(date) {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }

  // The forms speak MM/DD/YYYY, not ISO.
  function toUsDate(iso) {
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y}`;
  }

  function assertDateString(value, field) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new TypeError(`${field} must be a YYYY-MM-DD string`);
    }
    return value;
  }

  function todayIso(now) {
    return toIso(now ? new Date(now) : new Date());
  }

  // The earliest date the server will still answer for. Requesting before this
  // wastes a submission and returns nothing useful.
  function retentionFloor(now) {
    const date = now ? new Date(now) : new Date();
    date.setUTCFullYear(date.getUTCFullYear() - RETENTION_YEARS);
    date.setUTCDate(date.getUTCDate() + 1);
    return toIso(date);
  }

  function lastDayOfMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  // Build the list of periods to generate. Nothing is enumerated from the
  // server here: this provider asks for periods rather than discovering
  // documents, so the period list is the whole of "discovery".
  function periodsInRange(startDate, endDate, granularity) {
    const periods = [];
    const [sy, sm, sd] = startDate.split('-').map(Number);
    const [ey, em, ed] = endDate.split('-').map(Number);
    const clampStart = (iso) => (iso < startDate ? startDate : iso);
    const clampEnd = (iso) => (iso > endDate ? endDate : iso);

    if (granularity === 'ANNUAL') {
      for (let year = sy; year <= ey; year += 1) {
        periods.push({
          label: String(year),
          start: clampStart(`${year}-01-01`),
          end: clampEnd(`${year}-12-31`),
        });
      }
      return periods;
    }

    if (granularity === 'QUARTERLY') {
      for (let year = sy; year <= ey; year += 1) {
        for (let q = 1; q <= 4; q += 1) {
          const firstMonth = (q - 1) * 3 + 1;
          const lastMonth = firstMonth + 2;
          const start = `${year}-${pad2(firstMonth)}-01`;
          const end = `${year}-${pad2(lastMonth)}-${pad2(lastDayOfMonth(year, lastMonth))}`;
          if (end < startDate || start > endDate) continue;
          periods.push({ label: `${year}-Q${q}`, start: clampStart(start), end: clampEnd(end) });
        }
      }
      return periods;
    }

    let year = sy;
    let month = sm;
    while (year < ey || (year === ey && month <= em)) {
      const start = `${year}-${pad2(month)}-01`;
      const end = `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`;
      if (!(end < startDate || start > endDate)) {
        periods.push({ label: `${year}-${pad2(month)}`, start: clampStart(start), end: clampEnd(end) });
      }
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
    void sd; void ed;
    return periods;
  }

  function yearsInRange(startDate, endDate) {
    const years = [];
    for (let year = Number(startDate.slice(0, 4)); year <= Number(endDate.slice(0, 4)); year += 1) {
      years.push(year);
    }
    return years;
  }

  // Everything the forms need is already rendered into the page; reading it
  // live avoids guessing at a CSRF token or hardcoding a plan.
  function readPlanContext(doc = document) {
    const value = (name) => {
      const el = /** @type {HTMLInputElement|null} */ (doc.querySelector(`input[name="${name}"]`));
      return el ? el.value : null;
    };
    const token = value('txntoken');
    const client = value('sodClientId');
    const plan = value('sodPlan');
    const nameEl = doc.querySelector('[class*="planName"], [id*="planName"], h1, h2');
    return {
      txntoken: token,
      sodClientId: client,
      sodPlan: plan,
      planName: nameEl ? nameEl.textContent.trim().slice(0, 60) : null,
    };
  }

  function requirePlanContext(doc) {
    const context = readPlanContext(doc);
    if (!context.txntoken || !context.sodClientId || !context.sodPlan) {
      throw new Error('Open a plan\'s statement page first; the plan and security token were not found');
    }
    return context;
  }

  // Submit through the page's own form into a hidden same-origin iframe.
  //
  // Every legitimate submission on this server-rendered app is a navigation. A
  // fetch() POST is distinguishable by its request metadata, and a long run of
  // those is anomalous where form submissions are not. This keeps the request
  // shape honest while leaving the page in place.
  function submitViaIframe(action, fields, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const name = `fsd-nb-${Math.random().toString(36).slice(2)}`;
      const frame = document.createElement('iframe');
      frame.name = name;
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;';

      const form = document.createElement('form');
      form.method = 'POST';
      form.action = action;
      form.target = name;
      form.style.display = 'none';
      for (const [key, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = value;
        form.appendChild(input);
      }

      let settled = false;
      const cleanUp = () => {
        if (timer) clearTimeout(timer);
        frame.remove();
        form.remove();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanUp();
        reject(new Error('timed out waiting for NetBenefits to respond'));
      }, timeoutMs);

      frame.addEventListener('load', () => {
        if (settled) return;
        settled = true;
        let html;
        try {
          html = frame.contentDocument ? frame.contentDocument.documentElement.outerHTML : '';
        } catch (error) {
          cleanUp();
          reject(new Error('could not read the response frame'));
          return;
        }
        cleanUp();
        resolve(html);
      });

      document.body.appendChild(frame);
      document.body.appendChild(form);
      form.requestSubmit ? form.requestSubmit() : form.submit();
    });
  }

  // Fallback for if the iframe route is refused: submit the real page. Callers
  // lose the in-page run, so this is deliberately not the default.
  function submitViaNavigation(action, fields) {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = action;
    for (const [key, value] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.requestSubmit ? form.requestSubmit() : form.submit();
    return new Promise(() => {});
  }

  const STRATEGIES = { iframe: submitViaIframe, navigate: submitViaNavigation };

  function looksBlocked(html) {
    // The generic soft-block copy, plus the obvious challenge markers.
    return /can't complete this action|cannot complete this action|access denied|unusual activity/i.test(html || '');
  }

  function statementRangeMatches(html, period) {
    // The rendered statement echoes the range it covers; if the server ignored
    // ours, every generated file would silently be the wrong period.
    const us = `${toUsDate(period.start)}`;
    return html.includes(us) || html.includes(period.start);
  }

  async function inlineChart(html) {
    const match = html.match(/<img[^>]+src="([^"]*\/sod\/chart[^"]*)"/i);
    if (!match) return html;
    const url = match[1].startsWith('http') ? match[1] : ORIGIN + match[1];
    try {
      const response = await root.fetch(url, { credentials: 'include' });
      if (!response.ok) return html;
      const buffer = await response.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      const mime = response.headers.get('content-type') || 'image/gif';
      const dataUri = `data:${mime.split(';')[0]};base64,${root.btoa(binary)}`;
      return html.replace(match[1], dataUri);
    } catch (error) {
      // A statement without its chart is still worth keeping.
      return html;
    }
  }

  function encodeText(text) {
    if (typeof root.TextEncoder === 'function') return new root.TextEncoder().encode(text);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }

  function planFolder(context) {
    const name = (context.planName || '').trim();
    // Without a usable name the plan number stands alone rather than being
    // repeated as "89766-50002".
    return name
      ? sanitizeSegment(`${name}-${context.sodPlan}`, String(context.sodPlan))
      : sanitizeSegment(context.sodPlan, 'plan');
  }

  async function discoverDocuments(options = {}, report, controller) {
    // Discovery here is local computation rather than a server sweep, so there
    // is nothing to interrupt mid-flight; honour a stop that arrived first.
    if (isStopped(controller)) throw cancellationError(controller);
    const startRequested = assertDateString(options.startDate, 'options.startDate');
    const endDate = assertDateString(options.endDate, 'options.endDate');
    if (startRequested > endDate) {
      throw new RangeError('options.startDate must not be after options.endDate');
    }

    const granularity = options.granularity || 'MONTHLY';
    if (!GRANULARITIES.some((entry) => entry.code === granularity)) {
      throw new RangeError(`unknown granularity ${granularity}`);
    }

    const floor = retentionFloor(options.now);
    const startDate = startRequested < floor ? floor : startRequested;
    if (startDate !== startRequested) {
      notify(report, 'discovery-progress',
        `Earliest available is ${startDate}; NetBenefits keeps ten years.`, { clampedFrom: startRequested });
    }

    const context = requirePlanContext();
    const folder = planFolder(context);
    notify(report, 'discovery-progress', `Preparing ${context.planName || context.sodPlan}…`);

    const documents = [];
    for (const period of periodsInRange(startDate, endDate, granularity)) {
      documents.push({
        id: `${context.sodPlan}-STMT-${period.label}`,
        title: `${period.label} statement`,
        category: 'STATEMENT',
        date: period.end,
        account: context.planName || context.sodPlan,
        filename: `NetBenefits/${folder}/${STATEMENT_FOLDER}/${period.label}_Statement.html`,
        metadata: { kind: 'statement', period, plan: context.sodPlan, client: context.sodClientId },
      });
    }

    if (options.includeTransactions !== false) {
      for (const year of yearsInRange(startDate, endDate)) {
        const start = year === Number(startDate.slice(0, 4)) ? startDate : `${year}-01-01`;
        const end = year === Number(endDate.slice(0, 4)) ? endDate : `${year}-12-31`;
        documents.push({
          id: `${context.sodPlan}-TXN-${year}`,
          title: `${year} transactions`,
          category: 'TRANSACTIONS',
          date: end,
          account: context.planName || context.sodPlan,
          filename: `NetBenefits/${folder}/${TXN_FOLDER}/${year}_Transactions.csv`,
          metadata: { kind: 'transactions', period: { start, end, label: String(year) }, plan: context.sodPlan },
        });
      }
    }

    notify(report, 'discovery-progress', `Will generate ${documents.length} documents.`, { count: documents.length });
    return documents;
  }

  async function downloadStatement(document_, options) {
    const { period } = document_.metadata;
    // Re-read the token per submission: it may rotate, and a stale one would
    // fail silently partway through a long run.
    const context = requirePlanContext();
    const strategy = STRATEGIES[options.submitStrategy || 'iframe'] || submitViaIframe;

    const html = await strategy(SOD_URL, {
      txntoken: context.txntoken,
      sodReqIndicator: 'HACK',
      dateRange: `${toUsDate(period.start)}-${toUsDate(period.end)}`,
      ytdDateRange: `${toUsDate(period.start.slice(0, 4) + '-01-01')}-${toUsDate(period.end)}`,
      sodPreview: 'N',
      consentReq: 'N',
      sodClientId: context.sodClientId,
      sodPlan: context.sodPlan,
    });

    if (looksBlocked(html)) {
      const error = new Error('NetBenefits declined the request; stopping rather than retrying');
      error.blocked = true;
      throw error;
    }
    if (!statementRangeMatches(html, period)) {
      throw new Error(`returned statement does not cover ${period.label}`);
    }

    const withChart = await inlineChart(html);
    return {
      data: encodeText(withChart),
      contentType: 'text/html',
      filename: document_.filename,
    };
  }

  async function downloadTransactions(document_) {
    const { period } = document_.metadata;
    const context = requirePlanContext();
    // The CSV endpoint answers with a file rather than a page. Submitting it
    // into a frame would hand the browser a download we cannot name, so this
    // one is fetched.
    const body = new URLSearchParams({
      txntoken: context.txntoken,
      timeSelection: 'custom_date_range',
      selectedQuarterText: 'Custom Date Range',
      fromDate: toUsDate(period.start),
      toDate: toUsDate(period.end),
      fileFormatSelection: 'csv_format',
      view: '',
    });
    const response = await root.fetch(TXN_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      const error = new Error(`transaction export failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    if (looksBlocked(text)) {
      const error = new Error('NetBenefits declined the transaction export');
      error.blocked = true;
      throw error;
    }
    return { data: encodeText(text), contentType: 'text/csv', filename: document_.filename };
  }

  async function downloadDocument(document_, report, controller, options = {}) {
    const metadata = document_ && document_.metadata;
    if (!document_ || document_.provider !== PROVIDER_ID || !metadata || !metadata.kind) {
      throw new Error('Invalid NetBenefits document descriptor');
    }
    if (isStopped(controller)) throw cancellationError(controller);
    return metadata.kind === 'transactions'
      ? downloadTransactions(document_)
      : downloadStatement(document_, options);
  }

  function storage() {
    return app.createProviderStorage(PROVIDER_ID);
  }

  async function loadState() {
    return (await storage().loadSettings()) || {};
  }

  function renderControls(container, state = {}) {
    container.textContent = '';

    const range = document.createElement('div');
    range.className = 'row';
    for (const [name, label, value] of [
      ['startDate', 'From', state.startDate || retentionFloor()],
      ['endDate', 'To', state.endDate || todayIso()],
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

    const granularity = document.createElement('label');
    granularity.textContent = 'Statement period';
    const select = document.createElement('select');
    select.name = 'granularity';
    for (const entry of GRANULARITIES) {
      const option = document.createElement('option');
      option.value = entry.code;
      option.textContent = entry.label;
      if ((state.granularity || 'MONTHLY') === entry.code) option.selected = true;
      select.appendChild(option);
    }
    granularity.appendChild(select);
    container.appendChild(granularity);

    const txnRow = document.createElement('div');
    txnRow.className = 'row';
    const txnLabel = document.createElement('label');
    const txn = document.createElement('input');
    txn.type = 'checkbox';
    txn.name = 'includeTransactions';
    txn.checked = state.includeTransactions !== false;
    txnLabel.appendChild(txn);
    txnLabel.appendChild(document.createTextNode('Transaction history (CSV, per year)'));
    txnRow.appendChild(txnLabel);
    container.appendChild(txnRow);

    const note = document.createElement('div');
    note.className = 'fsd-provider-status';
    const context = readPlanContext();
    note.textContent = context.sodPlan
      ? `Statements are generated on request for ${context.planName || 'this plan'}, one plan at a time. Ten years are available.`
      : 'Open a plan\'s statement page first.';
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
    const granularity = container.querySelector('select[name="granularity"]').value;
    const includeTransactions = container.querySelector('input[name="includeTransactions"]').checked;

    await storage().saveSettings({ startDate, endDate, granularity, includeTransactions });
    return {
      startDate,
      endDate,
      granularity,
      includeTransactions,
      // Generating a statement is more work for the server than serving a
      // stored file, so this runs slower than the archive-backed providers.
      delayMs: 2500,
      jitterRatio: 0.6,
      submitStrategy: 'iframe',
    };
  }

  function findMountPoint() {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
    return headings.find((element) => /statement/i.test(element.textContent || '')) || null;
  }

  /** @type {FsdProvider} */
  const provider = {
    id: PROVIDER_ID,
    label: 'Fidelity NetBenefits',
    matches(url) {
      return typeof url === 'string'
        && /^https:\/\/workplaceservices\.fidelity\.com\/mybenefits\/savings2\//.test(url);
    },
    isSupportedPage() {
      return provider.matches(root.location ? root.location.href : '');
    },
    requiresDateRange: true,
    renderControls,
    readOptions,
    findMountPoint,
    loadState,
    discoverDocuments,
    downloadDocument,
  };

  provider.helpers = {
    periodsInRange,
    yearsInRange,
    retentionFloor,
    toUsDate,
    sanitizeSegment,
    readPlanContext,
    planFolder,
    looksBlocked,
    statementRangeMatches,
    encodeText,
    lastDayOfMonth,
    GRANULARITIES,
    SOD_URL,
    TXN_URL,
    CHART_PATH,
  };

  app.providers.netbenefits = provider;
})(globalThis);
