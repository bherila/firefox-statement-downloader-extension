(function registerWealthfrontProvider(root) {
  'use strict';

  const app = root.FinancialStatementDownloader = root.FinancialStatementDownloader || {};
  app.providers = app.providers || {};

  const PROVIDER_ID = 'wealthfront';
  const MAX_PAGES = 250;
  const PAGE_CHANGE_TIMEOUT_MS = 15000;
  const DOWNLOAD_TIMEOUT_MS = 120000;
  const knownPageNumbers = new Map();
  const CATEGORY_DEFINITIONS = [
    {
      id: 'tax-documents',
      label: 'Tax documents',
      folder: 'tax-documents',
      pattern: /\b(?:tax|1099(?:-[a-z]+)?|1098|5498|k-?1|w-?2)\b/i,
    },
    {
      id: 'trade-confirmations',
      label: 'Trade confirmations',
      folder: 'trade-confirmations',
      pattern: /\b(?:trade|transaction)\s+confirm(?:ation)?s?\b|\bconfirmations?\b/i,
    },
    {
      id: 'statements',
      label: 'Statements',
      folder: 'statements',
      pattern: /\bstatements?\b|\bmonthly\s+(?:account\s+)?summary\b/i,
    },
  ];

  function browserApi() {
    if (!root.browser || !root.browser.runtime) {
      throw new Error('Firefox browser API is unavailable');
    }
    return root.browser;
  }

  function normalizeWhitespace(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function normalizeIdentityText(value) {
    return normalizeWhitespace(value).toLowerCase();
  }

  function hashText(value) {
    // FNV-1a, expressed with Math.imul so results are stable in page and Node contexts.
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function classifyCategory(value) {
    const text = normalizeWhitespace(value);
    const definition = CATEGORY_DEFINITIONS.find((candidate) => candidate.pattern.test(text));
    return definition ? definition.id : null;
  }

  function stripUrlNoise(value) {
    const raw = normalizeWhitespace(value);
    if (!raw) return '';
    try {
      const url = new URL(raw, 'https://www.wealthfront.com/');
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:utm_|source$|ref$|cache|_)/i.test(key)) {
          url.searchParams.delete(key);
        }
      }
      return url.href;
    } catch (error) {
      return raw.split('#')[0];
    }
  }

  function stableRowSignature(row) {
    const record = row || {};
    const identity = [
      normalizeIdentityText(record.category),
      normalizeIdentityText(record.date),
      normalizeIdentityText(record.account),
      normalizeIdentityText(record.title),
      stripUrlNoise(record.href),
      normalizeIdentityText(record.locatorText),
    ].join('|');
    const fallback = identity.replace(/\|/g, '')
      ? identity
      : normalizeIdentityText(record.text);
    return `row-${hashText(fallback)}`;
  }

  function paginationSignature(rowSignatures) {
    if (!Array.isArray(rowSignatures)) {
      throw new TypeError('rowSignatures must be an array');
    }
    return `page-${hashText(rowSignatures.map(normalizeIdentityText).join('|'))}`;
  }

  function sanitizeFilenamePart(value, fallback) {
    const cleaned = normalizeWhitespace(value)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/[. ]+$/g, '')
      .slice(0, 120);
    return cleaned || fallback;
  }

  function normalizeDate(value) {
    const text = normalizeWhitespace(value);
    let match = text.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
    if (match) {
      return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    }
    match = text.match(/\b(0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])[-/](20\d{2})\b/);
    if (match) {
      return `${match[3]}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
    }
    const namedMonth = text.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+([0-3]?\d),?\s+(20\d{2})\b/i);
    if (namedMonth) {
      const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
        .indexOf(namedMonth[0].slice(0, 3).toLowerCase()) + 1;
      return `${namedMonth[2]}-${String(month).padStart(2, '0')}-${String(namedMonth[1]).padStart(2, '0')}`;
    }
    match = text.match(/\b(20\d{2})\b/);
    return match ? match[1] : '';
  }

  function buildFilename(document) {
    const record = document || {};
    const definition = CATEGORY_DEFINITIONS.find((candidate) => candidate.id === record.category);
    const folder = definition ? definition.folder : 'documents';
    const date = sanitizeFilenamePart(normalizeDate(record.date) || record.date, 'undated');
    const account = record.account ? ` - ${sanitizeFilenamePart(record.account, 'account')}` : '';
    const title = sanitizeFilenamePart(record.title, 'Document').replace(/\.pdf$/i, '');
    return `Wealthfront/${folder}/${date}${account} - ${title}.pdf`;
  }

  function selectedCategories(options) {
    const source = options || {};
    const categories = [];
    if (source.wantStatements !== false) categories.push('statements');
    if (source.wantTradeConfirmations !== false) categories.push('trade-confirmations');
    if (source.wantTaxDocuments !== false) categories.push('tax-documents');
    if (categories.length === 0) {
      throw new Error('Select at least one Wealthfront document type');
    }
    return categories;
  }

  function normalizeOptions(options) {
    const source = options || {};
    const parsedDelay = Number(source.delayMs);
    return {
      wantStatements: source.wantStatements !== false,
      wantTradeConfirmations: source.wantTradeConfirmations !== false,
      wantTaxDocuments: source.wantTaxDocuments !== false,
      delayMs: Number.isFinite(parsedDelay) ? Math.max(0, Math.round(parsedDelay)) : 250,
      categories: selectedCategories(source),
    };
  }

  function elementIsVisible(element) {
    if (!element || !element.isConnected) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (typeof root.getComputedStyle === 'function') {
      const style = root.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return !element.getBoundingClientRect || Boolean(element.getBoundingClientRect().width || element.getBoundingClientRect().height);
  }

  function tableRows(table) {
    const rows = [...table.querySelectorAll('tbody tr, [role="row"]')];
    return rows.filter((row) => row.querySelector('td, [role="cell"], a[href], button, [role="button"]'));
  }

  function tableScore(table) {
    const heading = normalizeIdentityText([
      table.getAttribute('aria-label'),
      table.querySelector('caption') && table.querySelector('caption').textContent,
      [...table.querySelectorAll('thead th, [role="columnheader"]')].map((cell) => cell.textContent).join(' '),
    ].join(' '));
    const rows = tableRows(table);
    const sample = normalizeIdentityText(rows.slice(0, 5).map((row) => row.textContent).join(' '));
    let score = rows.length;
    if (/document|statement|confirmation|tax/.test(heading)) score += 30;
    if (/date|description|type|account/.test(heading)) score += 10;
    if (/statement|confirmation|tax|1099/.test(sample)) score += 20;
    if (rows.some((row) => row.querySelector('a[href], button, [role="button"]'))) score += 10;
    return score;
  }

  function findDocumentTable() {
    if (!root.document) return null;
    const scope = root.document.querySelector('main, [role="main"]') || root.document;
    const candidates = [...scope.querySelectorAll('table, [role="table"]')]
      .map((table) => ({ table, score: tableScore(table) }))
      .filter((candidate) => candidate.score >= 20)
      .sort((left, right) => right.score - left.score);
    return candidates.length ? candidates[0].table : null;
  }

  function headerMap(table) {
    const headers = [...table.querySelectorAll('thead th, [role="columnheader"]')];
    const map = {};
    headers.forEach((header, index) => {
      const text = normalizeIdentityText(header.textContent);
      if (/date|period|year/.test(text) && map.date === undefined) map.date = index;
      if (/document|description|type|name/.test(text) && map.title === undefined) map.title = index;
      if (/account|portfolio/.test(text) && map.account === undefined) map.account = index;
    });
    return map;
  }

  function bestAction(row) {
    const candidates = [...row.querySelectorAll('a[href], button, [role="button"]')];
    return candidates
      .map((element, index) => {
        const text = normalizeIdentityText([
          element.textContent,
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ].join(' '));
        const href = element.tagName === 'A' ? element.getAttribute('href') || '' : '';
        let score = -index / 100;
        if (/download|view|open|pdf|statement|confirmation|tax|1099/.test(text)) score += 20;
        if (href && !/^#|^javascript:/i.test(href)) score += 10;
        return { element, score };
      })
      .sort((left, right) => right.score - left.score)[0]?.element || null;
  }

  function usableDirectUrl(action) {
    if (!action || action.tagName !== 'A') return null;
    const raw = normalizeWhitespace(action.getAttribute('href'));
    if (!raw || /^#|^javascript:|^blob:/i.test(raw)) return null;
    let url;
    try {
      url = new URL(raw, root.location && root.location.href);
    } catch (error) {
      return null;
    }
    if (!/^https?:$/.test(url.protocol)) return null;
    const semanticText = normalizeIdentityText([
      action.textContent,
      action.getAttribute('aria-label'),
      action.getAttribute('title'),
      action.getAttribute('download'),
      url.pathname,
    ].join(' '));
    return action.hasAttribute('download') || /\.pdf(?:$|[?#])|download|document|statement|confirmation|tax/.test(semanticText)
      ? url.href
      : null;
  }

  function describeRow(row, table, pageNumber) {
    const cells = [...row.querySelectorAll('td, [role="cell"]')];
    const headings = headerMap(table);
    const text = normalizeWhitespace(row.textContent);
    const action = bestAction(row);
    if (!action) return null;
    const actionText = normalizeWhitespace([
      action.textContent,
      action.getAttribute('aria-label'),
      action.getAttribute('title'),
    ].join(' '));
    const title = normalizeWhitespace(
      headings.title !== undefined && cells[headings.title]
        ? cells[headings.title].textContent
        : actionText || text
    );
    const dateSource = headings.date !== undefined && cells[headings.date]
      ? cells[headings.date].textContent
      : text;
    const date = normalizeDate(dateSource);
    const account = normalizeWhitespace(
      headings.account !== undefined && cells[headings.account]
        ? cells[headings.account].textContent
        : ''
    );
    const category = classifyCategory(`${title} ${text}`);
    if (!category) return null;
    const href = action.tagName === 'A' ? action.getAttribute('href') || '' : '';
    const identity = { category, date, account, title, href, locatorText: actionText, text };
    const rowSignature = stableRowSignature(identity);
    const raw = {
      id: rowSignature,
      title: title || `${CATEGORY_DEFINITIONS.find((item) => item.id === category).label} ${date}`,
      category,
      date: date || undefined,
      account: account || undefined,
      filename: buildFilename({ category, date, account, title }),
      metadata: {
        pageNumber,
        rowSignature,
        href: href ? stripUrlNoise(href) : '',
        directUrl: usableDirectUrl(action),
        locatorText: actionText,
      },
    };
    return typeof app.normalizeDocument === 'function'
      ? app.normalizeDocument(PROVIDER_ID, raw)
      : Object.assign({ provider: PROVIDER_ID }, raw);
  }

  function scanCurrentPage(pageNumber) {
    const table = findDocumentTable();
    if (!table) {
      throw new Error('Could not find Wealthfront document table');
    }
    const described = tableRows(table)
      .map((row) => ({ row, descriptor: describeRow(row, table, pageNumber) }))
      .filter((entry) => entry.descriptor);
    return {
      table,
      entries: described,
      signature: paginationSignature(described.map((entry) => entry.descriptor.metadata.rowSignature)),
    };
  }

  function paginationControl(direction, table) {
    const scope = (table && (table.closest('[data-testid*="document"], section, article') || table.parentElement)) || root.document;
    const rel = direction === 'next' ? 'next' : 'prev';
    const words = direction === 'next' ? /^(?:next|older|›|»|>|→)$/i : /^(?:previous|prev|newer|‹|«|<|←)$/i;
    const semantic = direction === 'next' ? /next|older|forward/i : /previous|prev|newer|back/i;
    const candidates = [...scope.querySelectorAll('a, button, [role="button"]')];
    return candidates.find((element) => normalizeIdentityText(element.getAttribute('rel')) === rel) ||
      candidates.find((element) => semantic.test(normalizeWhitespace([
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
      ].join(' ')))) ||
      candidates.find((element) => words.test(normalizeWhitespace(element.textContent)));
  }

  function controlIsDisabled(control) {
    return !control || Boolean(control.disabled) ||
      control.getAttribute('aria-disabled') === 'true' ||
      /\b(?:disabled|inactive)\b/i.test(control.className || '') ||
      (control.tagName === 'A' && !control.getAttribute('href') && !control.getAttribute('role'));
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

  async function waitFor(predicate, timeoutMs, message, controller) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (isStopped(controller)) return false;
      const result = predicate();
      if (result) return result;
      if (!await sleepUnlessStopped(100, controller)) return false;
    }
    throw new Error(message);
  }

  async function clickPageControl(direction, beforeSignature, controller) {
    if (isStopped(controller)) return false;
    const current = scanCurrentPage(0);
    const control = paginationControl(direction, current.table);
    if (controlIsDisabled(control)) return false;
    control.click();
    const changed = await waitFor(() => {
      try {
        return scanCurrentPage(0).signature !== beforeSignature;
      } catch (error) {
        return false;
      }
    }, PAGE_CHANGE_TIMEOUT_MS, `Timed out waiting for Wealthfront ${direction} page`, controller);
    return Boolean(changed);
  }

  async function rewindToFirstPage(controller) {
    const seen = new Set();
    for (let index = 0; index < MAX_PAGES; index += 1) {
      if (isStopped(controller)) return false;
      const page = scanCurrentPage(0);
      if (seen.has(page.signature)) {
        throw new Error('Wealthfront pagination repeated while finding the first page');
      }
      seen.add(page.signature);
      const previous = paginationControl('previous', page.table);
      if (controlIsDisabled(previous)) {
        knownPageNumbers.set(page.signature, 1);
        return true;
      }
      if (!await clickPageControl('previous', page.signature, controller)) return false;
    }
    throw new Error(`Wealthfront pagination exceeded the ${MAX_PAGES}-page safety limit`);
  }

  async function returnToDocumentPage(document, controller) {
    if (isStopped(controller)) return null;
    const metadata = document.metadata || {};
    let current = scanCurrentPage(0);
    let found = current.entries.find((entry) => entry.descriptor.metadata.rowSignature === metadata.rowSignature);
    if (found) return found;

    // Rows are downloaded in discovery order. Remembering the signatures observed
    // during discovery normally turns movement between adjacent small pages into a
    // single click instead of rewinding the whole table for every document.
    let currentPageNumber = knownPageNumbers.get(current.signature);
    const targetPageNumber = Number(metadata.pageNumber);
    if (Number.isInteger(currentPageNumber) && Number.isInteger(targetPageNumber) && targetPageNumber > 0) {
      while (currentPageNumber !== targetPageNumber) {
        if (isStopped(controller)) return null;
        const direction = currentPageNumber < targetPageNumber ? 'next' : 'previous';
        const control = paginationControl(direction, current.table);
        if (controlIsDisabled(control)) break;
        if (!await clickPageControl(direction, current.signature, controller)) return null;
        currentPageNumber += direction === 'next' ? 1 : -1;
        current = scanCurrentPage(currentPageNumber);
        knownPageNumbers.set(current.signature, currentPageNumber);
        found = current.entries.find((entry) => entry.descriptor.metadata.rowSignature === metadata.rowSignature);
        if (found) return found;
      }
    }

    // If the site changed page contents after discovery, fall back to a bounded
    // signature search rather than trusting a stale numeric page position.
    if (!await rewindToFirstPage(controller)) return null;
    const seen = new Set();
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      if (isStopped(controller)) return null;
      const page = scanCurrentPage(pageNumber);
      knownPageNumbers.set(page.signature, pageNumber);
      if (seen.has(page.signature)) break;
      seen.add(page.signature);
      const found = page.entries.find((entry) => entry.descriptor.metadata.rowSignature === metadata.rowSignature);
      if (found) return found;
      const next = paginationControl('next', page.table);
      if (controlIsDisabled(next)) break;
      if (!await clickPageControl('next', page.signature, controller)) return null;
    }
    throw new Error(`Could not return to Wealthfront document row ${metadata.rowSignature || document.id}`);
  }

  function preparationOverlays() {
    if (!root.document) return [];
    const selectors = [
      '[aria-busy="true"]',
      '[role="progressbar"]',
      '.loading-overlay',
      '[class*="loading"][class*="overlay"]',
      '[data-testid*="loading"]',
      '[data-testid*="progress"]',
      '[class*="modal"] [class*="spinner"]',
    ];
    return [...new Set([...root.document.querySelectorAll(selectors.join(','))])]
      .filter(elementIsVisible)
      .filter((element) => /prepar|load|generat|download|progress|spinner/i.test([
        element.textContent,
        element.className,
        element.getAttribute('aria-label'),
        element.getAttribute('data-testid'),
      ].join(' ')));
  }

  async function waitForOverlayLifecycle(existingOverlays, appearanceGraceMs = 1500, controller) {
    const baseline = new Set(existingOverlays || []);
    const started = Date.now();
    let appeared = [];
    while (Date.now() - started < appearanceGraceMs) {
      if (isStopped(controller)) return false;
      appeared = preparationOverlays().filter((element) => !baseline.has(element));
      if (appeared.length) break;
      if (!await sleepUnlessStopped(100, controller)) return false;
    }
    if (!appeared.length) return false;
    const cleared = await waitFor(
      () => appeared.every((element) => !elementIsVisible(element)),
      DOWNLOAD_TIMEOUT_MS,
      'Timed out waiting for Wealthfront to prepare the document',
      controller
    );
    return Boolean(cleared);
  }

  function notify(report, stage, message, details) {
    if (typeof report === 'function') {
      report(Object.assign({ type: stage, provider: PROVIDER_ID, stage, message }, details || {}));
    }
  }

  const provider = {
    id: PROVIDER_ID,
    label: 'Wealthfront',

    isSupportedPage() {
      const location = root.location;
      return Boolean(location &&
        (location.hostname === 'www.wealthfront.com' || location.hostname === 'dashboard.wealthfront.com') &&
        /\/(?:[^/]+\/)*(?:documents?|statements?|tax(?:-documents?)?)(?:\/|$)/i.test(location.pathname));
    },

    findMountPoint() {
      if (!root.document) return null;
      const table = findDocumentTable();
      const scope = table && (table.closest('section, article, main, [role="main"]') || table.parentElement);
      return (scope && scope.querySelector('h1, h2, h3')) ||
        root.document.querySelector('main h1, main h2, [role="main"] h1, [role="main"] h2') ||
        table || root.document.body;
    },

    renderControls(container, state) {
      const settings = (state && state.settings) || {};
      container.innerHTML = `
        <div class="fsd-provider-status">All matching pages in Wealthfront's document table will be scanned.</div>
        <div class="row">
          <label><input type="checkbox" data-field="wantStatements"> Statements</label>
          <label><input type="checkbox" data-field="wantTradeConfirmations"> Trade confirmations</label>
          <label><input type="checkbox" data-field="wantTaxDocuments"> Tax documents</label>
        </div>
        <label>Delay between downloads (ms) <input type="number" data-field="delayMs" min="0" step="100"></label>
      `;
      for (const name of ['wantStatements', 'wantTradeConfirmations', 'wantTaxDocuments']) {
        container.querySelector(`[data-field="${name}"]`).checked = settings[name] !== false;
      }
      container.querySelector('[data-field="delayMs"]').value = settings.delayMs == null ? 250 : settings.delayMs;
    },

    readOptions(container) {
      return normalizeOptions({
        wantStatements: container.querySelector('[data-field="wantStatements"]').checked,
        wantTradeConfirmations: container.querySelector('[data-field="wantTradeConfirmations"]').checked,
        wantTaxDocuments: container.querySelector('[data-field="wantTaxDocuments"]').checked,
        delayMs: container.querySelector('[data-field="delayMs"]').value,
      });
    },

    async loadState() {
      const storage = app.createProviderStorage(PROVIDER_ID);
      return { settings: await storage.loadSettings() };
    },

    async discoverDocuments(options, report, controller) {
      if (!provider.isSupportedPage()) {
        throw new Error('Open Wealthfront’s documents page before starting a bulk download');
      }
      const normalized = normalizeOptions(options);
      await app.createProviderStorage(PROVIDER_ID).saveSettings({
        wantStatements: normalized.wantStatements,
        wantTradeConfirmations: normalized.wantTradeConfirmations,
        wantTaxDocuments: normalized.wantTaxDocuments,
        delayMs: normalized.delayMs,
      });
      if (isStopped(controller)) return [];

      if (!await rewindToFirstPage(controller)) return [];
      const documents = [];
      const documentIds = new Set();
      const pageSignatures = new Set();
      for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
        if (isStopped(controller)) break;
        const page = scanCurrentPage(pageNumber);
        knownPageNumbers.set(page.signature, pageNumber);
        if (pageSignatures.has(page.signature)) {
          notify(report, 'pagination-complete', `Stopped at repeated Wealthfront page ${pageNumber}`, { pageNumber });
          break;
        }
        pageSignatures.add(page.signature);
        for (const entry of page.entries) {
          if (isStopped(controller)) break;
          const document = entry.descriptor;
          document.metadata.pageSignature = page.signature;
          if (normalized.categories.includes(document.category) && !documentIds.has(document.id)) {
            documents.push(document);
            documentIds.add(document.id);
          }
        }
        notify(report, 'pagination-page', `Scanned Wealthfront page ${pageNumber}`, {
          pageNumber,
          count: page.entries.length,
        });
        const next = paginationControl('next', page.table);
        if (controlIsDisabled(next)) break;
        if (pageNumber === MAX_PAGES) {
          throw new Error(`Wealthfront pagination exceeded the ${MAX_PAGES}-page safety limit`);
        }
        if (!await clickPageControl('next', page.signature, controller)) break;
      }
      notify(report, 'discovered', `Found ${documents.length} Wealthfront documents`, { count: documents.length });
      return documents;
    },

    async downloadDocument(document, report, controller) {
      if (!document || document.provider !== PROVIDER_ID || !document.metadata || !document.metadata.rowSignature) {
        throw new Error('Invalid Wealthfront document descriptor');
      }
      if (isStopped(controller)) throw cancellationError(controller);
      if (document.metadata.directUrl) {
        return { url: document.metadata.directUrl, filename: document.filename };
      }
      if (!provider.isSupportedPage()) {
        throw new Error('Return to Wealthfront’s documents page to continue downloading');
      }

      notify(report, 'locating', `Returning to ${document.title}`, { document });
      const entry = await returnToDocumentPage(document, controller);
      if (isStopped(controller)) throw cancellationError(controller);
      if (!entry) throw new Error(`Could not return to the Wealthfront row for ${document.title}`);
      const action = bestAction(entry.row);
      if (!action) {
        throw new Error(`Could not find the download control for ${document.title}`);
      }

      const watch = await browserApi().runtime.sendMessage({ action: 'startDownloadWatch', extension: '.pdf' });
      if (!watch || watch.ok === false || !watch.watchId) {
        throw new Error(watch && watch.error ? watch.error : 'Could not start the download watcher');
      }
      const cancelWatch = () => browserApi().runtime.sendMessage({
        action: 'cancelDownloadWatch',
        watchId: watch.watchId,
      }).catch(() => {});
      try {
        if (isStopped(controller)) throw cancellationError(controller);
        const existingOverlays = preparationOverlays();
        action.click();
        notify(report, 'preparing', `Waiting for Wealthfront to prepare ${document.title}`, { document });
        await waitForOverlayLifecycle(existingOverlays, 1500, controller);
        if (isStopped(controller)) throw cancellationError(controller);
        const finishPromise = browserApi().runtime.sendMessage({
          action: 'finishDownloadWatch', watchId: watch.watchId, timeoutMs: DOWNLOAD_TIMEOUT_MS,
        }).then((value) => ({ value }), (error) => ({ error }));
        const outcome = await Promise.race([
          finishPromise,
          waitForStop(controller).then(() => ({ stopped: true })),
        ]);
        if (outcome.stopped || isStopped(controller)) throw cancellationError(controller);
        if (outcome.error) throw outcome.error;
        const result = outcome.value;
        if (!result || result.ok === false) {
          throw new Error(result && result.error ? result.error : 'Wealthfront download was not detected');
        }
        return { downloaded: true, downloadId: result.downloadId, filename: result.filename || document.filename };
      } catch (error) {
        await cancelWatch();
        throw error;
      }
    },

    helpers: {
      normalizeWhitespace,
      classifyCategory,
      stableRowSignature,
      paginationSignature,
      normalizeDate,
      sanitizeFilenamePart,
      buildFilename,
      selectedCategories,
    },
  };

  app.providers.wealthfront = provider;
})(globalThis);
