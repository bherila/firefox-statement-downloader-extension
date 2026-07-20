(function registerFidelityProvider(root) {
  'use strict';

  const app = root.FinancialStatementDownloader = root.FinancialStatementDownloader || {};
  app.providers = app.providers || {};

  const PROVIDER_ID = 'fidelity';
  const CATEGORY_LABELS = {
    statements: 'Statements',
    'trade-confirmations': 'Trade confirmations',
    'tax-documents': 'Tax documents',
  };
  const SUPPORTED_HOSTS = new Set([
    'digital.fidelity.com',
    'oltx.fidelity.com',
    'statements.fidelity.com',
  ]);
  const DOCUMENT_PATH = /(?:documents?|dochub|statements?|tax(?:forms?|documents?)?|trade[-_/ ]?confirmations?)/i;
  const BUSY_SELECTOR = [
    '[aria-busy="true"]',
    '[role="progressbar"]',
    '[data-testid*="loading" i]',
    '[data-testid*="spinner" i]',
    '[class*="loading" i]',
    '[class*="spinner" i]',
    '[class*="overlay" i]',
  ].join(',');

  /*
   * Live calibration notes:
   * - The year chooser is assumed to be either a native select containing
   *   four-digit options or an aria-haspopup button whose popup uses role=option/menuitem.
   * - Document categories are assumed to use native options, role=tab, or controls
   *   with aria-controls/data-testid tab semantics.
   * - Each downloadable item is assumed to contain an anchor/button in a row-like
   *   tr, role=row, li, article, or data-testid/class containing "document".
   * These semantic assumptions deliberately avoid Fidelity's generated class names,
   * but they need to be checked against the signed-in Documents page.
   */

  function browserApi() {
    if (!root.browser || !root.browser.runtime) {
      throw new Error('Firefox browser API is unavailable');
    }
    return root.browser;
  }

  function providerStorage() {
    if (typeof app.createProviderStorage !== 'function') {
      throw new Error('provider storage is unavailable');
    }
    return app.createProviderStorage(PROVIDER_ID);
  }

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function extractYear(value) {
    const match = compactText(value).match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/);
    return match ? Number(match[1]) : null;
  }

  function extractYears(values) {
    const years = new Set();
    for (const value of values || []) {
      const year = extractYear(value);
      if (year !== null) years.add(year);
    }
    return Array.from(years).sort((left, right) => right - left);
  }

  function classifyCategory(value) {
    const text = compactText(value).toLowerCase();
    if (/\b(?:trade\s*)?confirmations?\b/.test(text)) return 'trade-confirmations';
    if (/\b(?:tax|1099|w-?2|k-?1|5498)\b/.test(text)) return 'tax-documents';
    if (/\bstatements?\b/.test(text)) return 'statements';
    return null;
  }

  function normalizeDate(value) {
    const text = compactText(value);
    let match = text.match(/\b((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;

    match = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.]((?:19|20)\d{2})\b/);
    if (match) return `${match[3]}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;

    const months = {
      jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
      apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
      aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
      october: 10, nov: 11, november: 11, dec: 12, december: 12,
    };
    match = text.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/);
    if (match && months[match[1].toLowerCase()]) {
      return `${match[3]}-${String(months[match[1].toLowerCase()]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
    }
    return null;
  }

  function sanitizeFilenamePart(value, fallback) {
    const clean = compactText(value)
      .replace(/\.pdf\b/ig, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s*-\s*-+/g, ' - ')
      .replace(/^[-.\s]+|[-.\s]+$/g, '')
      .slice(0, 120);
    return clean || fallback;
  }

  function buildFilename(details) {
    const year = extractYear(details.year) || extractYear(details.date) || 'unknown-year';
    const category = CATEGORY_LABELS[details.category] ? details.category : 'documents';
    const date = normalizeDate(details.date) || '';
    const title = sanitizeFilenamePart(details.title, CATEGORY_LABELS[details.category] || 'Document');
    const account = sanitizeFilenamePart(details.account, '');
    const parts = [date, title, account].filter(Boolean);
    return `Fidelity/${category}/${year}/${parts.join(' - ')}.pdf`;
  }

  function hashText(value) {
    let hash = 0x811c9dc5;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function stableHrefIdentity(value) {
    const raw = compactText(value);
    if (!raw) return '';
    try {
      const url = new root.URL(raw, 'https://digital.fidelity.com/');
      url.hash = '';
      const retained = [];
      for (const [key, parameterValue] of url.searchParams) {
        if (/^(?:token|access_?token|auth(?:orization)?|signature|sig|expires?|expiry|x-amz-.+|policy|key-pair-id|credential|session(?:id)?|nonce|timestamp|ts|utm_.+|gclid|fbclid|source|ref|tracking(?:id)?|cache(?:bust)?|_)$/i.test(key)) {
          continue;
        }
        retained.push([key, parameterValue]);
      }
      retained.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
      url.search = '';
      for (const [key, parameterValue] of retained) url.searchParams.append(key, parameterValue);
      return url.href;
    } catch (error) {
      return raw.split('#')[0];
    }
  }

  function stableDocumentId(details) {
    const hrefIdentity = stableHrefIdentity(details.href);
    const identity = [
      details.category,
      extractYear(details.year) || extractYear(details.date) || '',
      normalizeDate(details.date) || compactText(details.date).toLowerCase(),
      compactText(details.title).toLowerCase(),
      compactText(details.account).toLowerCase(),
      hrefIdentity,
    ].join('|');
    return `${details.category || 'document'}:${extractYear(details.year) || 'unknown'}:${hashText(identity)}`;
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

  async function finishWatchedDownload(watchId, timeoutMs, controller) {
    const finishPromise = browserApi().runtime.sendMessage({
      action: 'finishDownloadWatch', watchId, timeoutMs,
    }).then((value) => ({ value }), (error) => ({ error }));
    const outcome = await Promise.race([
      finishPromise,
      waitForStop(controller).then(() => ({ stopped: true })),
    ]);
    if (outcome.stopped || isStopped(controller)) {
      await browserApi().runtime.sendMessage({ action: 'cancelDownloadWatch', watchId }).catch(() => {});
      const error = cancellationError(controller);
      error.watchCancelled = true;
      throw error;
    }
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }

  function visible(element) {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
    if (typeof root.getComputedStyle !== 'function') return true;
    const style = root.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function mainElement() {
    return root.document.querySelector('main, [role="main"]') || root.document.body;
  }

  function pageSnapshot() {
    return hashText(compactText(mainElement().textContent).slice(0, 12000));
  }

  function pageIsBusy() {
    return Array.from(root.document.querySelectorAll(BUSY_SELECTOR)).some(visible);
  }

  async function waitForPageSettled(previousSnapshot, timeoutMs = 5000, controller) {
    const startedAt = Date.now();
    let stableCount = 0;
    let lastSnapshot = pageSnapshot();
    while (Date.now() - startedAt < timeoutMs) {
      if (!await sleepUnlessStopped(125, controller)) return false;
      const nextSnapshot = pageSnapshot();
      const changed = !previousSnapshot || nextSnapshot !== previousSnapshot;
      stableCount = !pageIsBusy() && nextSnapshot === lastSnapshot ? stableCount + 1 : 0;
      if (stableCount >= 2 && (changed || Date.now() - startedAt >= 650)) return true;
      lastSnapshot = nextSnapshot;
    }
    if (pageIsBusy()) throw new Error('Fidelity documents page did not finish loading');
    return true;
  }

  function semanticLabel(element) {
    if (!element) return '';
    const labelledBy = element.getAttribute('aria-labelledby');
    const externalLabel = labelledBy
      ? labelledBy.split(/\s+/).map((id) => root.document.getElementById(id)).filter(Boolean).map((node) => node.textContent).join(' ')
      : '';
    const wrappingLabel = element.closest && element.closest('label');
    return compactText([
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      externalLabel,
      wrappingLabel && wrappingLabel.textContent,
      element.textContent,
      element.id,
      element.getAttribute('name'),
      element.getAttribute('data-testid'),
    ].filter(Boolean).join(' '));
  }

  function nativeYearSelect() {
    const selects = Array.from(root.document.querySelectorAll('select'));
    return selects
      .map((select) => {
        const years = extractYears(Array.from(select.options || []).map((option) => `${option.value} ${option.textContent}`));
        const score = years.length * 10 + (/year/i.test(semanticLabel(select)) ? 5 : 0);
        return { select, years, score };
      })
      .filter((candidate) => candidate.years.length > 0)
      .sort((left, right) => right.score - left.score)[0] || null;
  }

  function customYearButton() {
    const candidates = Array.from(root.document.querySelectorAll('button[aria-haspopup], [role="button"][aria-haspopup]'));
    return candidates.find((button) => /year/i.test(semanticLabel(button)) || extractYear(semanticLabel(button)) !== null) || null;
  }

  function popupYearOptions() {
    return Array.from(root.document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"]'))
      .map((element) => ({ element, year: extractYear(semanticLabel(element)) }))
      .filter((candidate) => candidate.year !== null && visible(candidate.element));
  }

  function detectAvailableYears(documentRoot) {
    const documentObject = documentRoot || root.document;
    if (!documentObject || !documentObject.querySelectorAll) return [];
    const values = [];
    for (const option of documentObject.querySelectorAll('select option, [role="option"], [role="menuitem"], [role="menuitemradio"]')) {
      values.push(`${option.value || ''} ${option.textContent || ''}`);
    }
    return extractYears(values);
  }

  async function openCustomYearOptions(controller) {
    const button = customYearButton();
    if (!button) return [];
    let options = popupYearOptions();
    if (options.length === 0) {
      button.click();
      const startedAt = Date.now();
      while (options.length === 0 && Date.now() - startedAt < 2000) {
        if (!await sleepUnlessStopped(75, controller)) break;
        options = popupYearOptions();
      }
    }
    return options;
  }

  async function availableYears(controller) {
    const native = nativeYearSelect();
    if (native) return native.years;
    const wasOpen = popupYearOptions().length > 0;
    const popup = await openCustomYearOptions(controller);
    const years = extractYears(popup.map((candidate) => candidate.year));
    const button = customYearButton();
    if (!wasOpen && button && popup.length > 0) {
      button.click();
    }
    return years;
  }

  function dispatchSelection(element) {
    element.dispatchEvent(new root.Event('input', { bubbles: true }));
    element.dispatchEvent(new root.Event('change', { bubbles: true }));
  }

  async function selectYear(year, controller) {
    if (isStopped(controller)) return false;
    const native = nativeYearSelect();
    if (native) {
      const option = Array.from(native.select.options).find((item) => extractYear(`${item.value} ${item.textContent}`) === year);
      if (!option) return false;
      if (native.select.value !== option.value) {
        const snapshot = pageSnapshot();
        native.select.value = option.value;
        dispatchSelection(native.select);
        if (!await waitForPageSettled(snapshot, 5000, controller)) return false;
      }
      return true;
    }

    const button = customYearButton();
    if (!button) return extractYear(mainElement().textContent) === year;
    if (extractYear(semanticLabel(button)) === year) return true;
    const options = await openCustomYearOptions(controller);
    if (isStopped(controller)) return false;
    const option = options.find((candidate) => candidate.year === year);
    if (!option) return false;
    const snapshot = pageSnapshot();
    option.element.click();
    return waitForPageSettled(snapshot, 5000, controller);
  }

  function nativeCategorySelect(category) {
    for (const select of root.document.querySelectorAll('select')) {
      const options = Array.from(select.options || []);
      const representedCategories = new Set(options.map((item) => classifyCategory(`${item.value} ${item.textContent}`)).filter(Boolean));
      if (representedCategories.size < 2 && !/(?:document|category|type)/i.test(semanticLabel(select))) continue;
      const option = options.find((item) => classifyCategory(`${item.value} ${item.textContent}`) === category);
      if (option) return { select, option };
    }
    return null;
  }

  function categoryControl(category) {
    const selectors = [
      '[role="tab"]',
      '[aria-controls]',
      'nav button',
      'nav a',
      '[data-testid*="tab" i]',
      '[class*="tab" i] button',
      '[class*="tab" i] a',
    ].join(',');
    return Array.from(root.document.querySelectorAll(selectors)).find((element) => {
      const label = semanticLabel(element);
      return classifyCategory(label) === category &&
        !/\b(?:download|view|open|pdf)\b/i.test(label) &&
        !element.closest('tr, [role="row"], [data-testid*="document" i]');
    }) || null;
  }

  async function activateCategory(category, controller) {
    if (isStopped(controller)) return false;
    const native = nativeCategorySelect(category);
    if (native) {
      if (native.select.value !== native.option.value) {
        const snapshot = pageSnapshot();
        native.select.value = native.option.value;
        dispatchSelection(native.select);
        if (!await waitForPageSettled(snapshot, 5000, controller)) return false;
      }
      return true;
    }

    const control = categoryControl(category);
    if (!control) return false;
    const selected = control.getAttribute('aria-selected') === 'true' ||
      control.getAttribute('aria-current') === 'page' ||
      control.classList.contains('active') || control.classList.contains('selected');
    if (!selected) {
      const snapshot = pageSnapshot();
      control.click();
      if (!await waitForPageSettled(snapshot, 5000, controller)) return false;
    }
    return true;
  }

  function absoluteUrl(href) {
    if (!href || /^(?:javascript:|#)/i.test(href)) return null;
    try {
      return new root.URL(href, root.location.href).href;
    } catch (error) {
      return null;
    }
  }

  function isDirectDownloadUrl(url) {
    if (!url) return false;
    try {
      const parsed = new root.URL(url);
      return /\.pdf$/i.test(parsed.pathname) || /(?:download|documentdownload|document\/download|pdf)/i.test(parsed.pathname);
    } catch (error) {
      return false;
    }
  }

  function rowFor(element) {
    return element.closest('tr, [role="row"], li, article, [data-testid*="document" i], [class*="document" i]') || element.parentElement;
  }

  function nearbyCategory(row) {
    let node = row;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const heading = node.querySelector && node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"]');
      const category = classifyCategory(`${semanticLabel(node)} ${heading ? heading.textContent : ''}`);
      if (category) return category;
    }
    return null;
  }

  function candidateTitle(element, row, category) {
    const explicit = compactText(element.getAttribute('aria-label') || element.getAttribute('title'));
    const heading = row && row.querySelector && row.querySelector('h2, h3, h4, [role="heading"], [data-testid*="title" i]');
    const actionText = compactText(element.textContent);
    const rowText = compactText(row && row.textContent);
    const genericAction = /^(?:view|download|open|pdf|view pdf|download pdf)$/i.test(actionText);
    if (explicit && !/^(?:view|download|open)(?: pdf)?$/i.test(explicit)) return explicit;
    if (heading && compactText(heading.textContent)) return compactText(heading.textContent);
    if (!genericAction && actionText.length > 2) return actionText;
    const withoutAction = compactText(rowText.replace(actionText, ''));
    return withoutAction.slice(0, 160) || CATEGORY_LABELS[category] || 'Fidelity document';
  }

  function candidateAccount(row) {
    if (!row || !row.querySelector) return '';
    const account = row.querySelector('[data-testid*="account" i], [class*="account" i], [aria-label*="account" i]');
    return account ? compactText(account.textContent || account.getAttribute('aria-label')) : '';
  }

  function candidateElements() {
    const scope = mainElement();
    return Array.from(scope.querySelectorAll('a[href], button, [role="button"]')).filter((element) => {
      if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
      if (element.closest('[role="tablist"], nav') || element.matches('[aria-haspopup]')) return false;
      const row = rowFor(element);
      const text = compactText(`${semanticLabel(element)} ${row && row.textContent}`);
      const href = absoluteUrl(element.getAttribute('href'));
      return Boolean(
        (href && isDirectDownloadUrl(href)) ||
        /\b(?:download|view|open|pdf|statement|confirmation|tax\s+(?:form|document))\b/i.test(text)
      );
    });
  }

  function normalizedDocument(raw) {
    return typeof app.normalizeDocument === 'function'
      ? app.normalizeDocument(PROVIDER_ID, raw)
      : Object.assign({ provider: PROVIDER_ID }, raw);
  }

  function collectDocuments(year, category, categoryWasActivated) {
    const documents = [];
    const seenRows = new Set();
    for (const element of candidateElements()) {
      const row = rowFor(element);
      const rowText = compactText(row && row.textContent);
      const inferredCategory = classifyCategory(rowText) || nearbyCategory(row);
      const documentCategory = inferredCategory || (categoryWasActivated ? category : null);
      if (documentCategory !== category) continue;

      const href = absoluteUrl(element.getAttribute('href'));
      const actionText = compactText(semanticLabel(element));
      const title = candidateTitle(element, row, category);
      const date = normalizeDate(rowText) || normalizeDate(title);
      const account = candidateAccount(row);
      const rowKey = hashText(rowText.toLowerCase());
      const dedupeKey = `${rowKey}|${href ? stableHrefIdentity(href) : actionText}`;
      if (seenRows.has(dedupeKey)) continue;
      seenRows.add(dedupeKey);

      const details = { category, year, date: date || `${year}`, title, account, href };
      const raw = {
        id: stableDocumentId(details),
        title,
        category,
        filename: buildFilename(details),
        metadata: {
          year,
          directUrl: isDirectDownloadUrl(href) ? href : null,
          href: href ? href.replace(root.location.origin, '') : null,
          actionText,
          rowKey,
        },
      };
      if (date) raw.date = date;
      if (account) raw.account = account;
      documents.push(normalizedDocument(raw));
    }
    return documents;
  }

  function normalizeOptions(input) {
    const options = input || {};
    const startYear = Number(options.startYear);
    const endYear = Number(options.endYear);
    if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear < 1900 || endYear > 2099) {
      throw new Error('Select valid four-digit Fidelity years');
    }
    if (startYear > endYear) throw new Error('From year must not be later than To year');

    const categories = [];
    if (options.wantStatements !== false) categories.push('statements');
    if (options.wantTradeConfirmations !== false) categories.push('trade-confirmations');
    if (options.wantTaxDocuments !== false) categories.push('tax-documents');
    if (categories.length === 0) throw new Error('Select at least one Fidelity document type');
    return { startYear, endYear, categories };
  }

  function field(container, name) {
    const element = container.querySelector(`[data-field="${name}"]`);
    if (!element) throw new Error(`Missing Fidelity control: ${name}`);
    return element;
  }

  function createYearControl(name, years, value) {
    if (years.length === 0) {
      return `<input type="number" data-field="${name}" min="1900" max="2099" value="${value || ''}">`;
    }
    return `<select data-field="${name}">${years.map((year) =>
      `<option value="${year}"${year === value ? ' selected' : ''}>${year}</option>`).join('')}</select>`;
  }

  function findDocumentElement(document) {
    const metadata = document.metadata || {};
    const candidates = candidateElements();
    if (metadata.href) {
      const hrefMatch = candidates.find((element) => {
        const href = absoluteUrl(element.getAttribute('href'));
        return href && (href === metadata.href || href.replace(root.location.origin, '') === metadata.href);
      });
      if (hrefMatch) return hrefMatch;
    }
    const rowMatch = candidates.find((element) => hashText(compactText(rowFor(element).textContent).toLowerCase()) === metadata.rowKey);
    if (rowMatch) return rowMatch;
    return candidates.find((element) => compactText(semanticLabel(element)) === metadata.actionText) || null;
  }

  const provider = {
    id: PROVIDER_ID,
    label: 'Fidelity Investments',

    isSupportedPage() {
      const location = root.location;
      if (!location || !SUPPORTED_HOSTS.has(location.hostname)) return false;
      return DOCUMENT_PATH.test(`${location.pathname} ${location.search} ${location.hash}`);
    },

    findMountPoint() {
      if (!root.document) return null;
      const headings = root.document.querySelectorAll('main h1, main h2, [role="main"] h1, [role="main"] h2');
      return Array.from(headings).find((heading) => /documents?|statements?|tax|confirmations?/i.test(compactText(heading.textContent))) ||
        root.document.querySelector('main h1, main h2, [role="main"] h1, [role="main"] h2') ||
        root.document.querySelector('main, [role="main"]') || root.document.body;
    },

    renderControls(container, state) {
      const settings = state && state.settings || {};
      const years = state && state.availableYears || [];
      const currentYear = new Date().getFullYear();
      const startYear = settings.startYear || (years.length ? Math.min(...years) : currentYear);
      const endYear = settings.endYear || (years.length ? Math.max(...years) : currentYear);
      container.innerHTML = `
        <div class="fsd-provider-status">Fidelity changes the page once per selected year and document type. Keep this tab open while discovery runs.</div>
        <div class="row">
          <label>From year ${createYearControl('startYear', years.slice().sort(), startYear)}</label>
          <label>To year ${createYearControl('endYear', years.slice().sort(), endYear)}</label>
        </div>
        <div class="row">
          <label><input type="checkbox" data-field="wantStatements"> Statements</label>
          <label><input type="checkbox" data-field="wantTradeConfirmations"> Trade confirmations</label>
          <label><input type="checkbox" data-field="wantTaxDocuments"> Tax documents</label>
        </div>
      `;
      field(container, 'wantStatements').checked = settings.wantStatements !== false;
      field(container, 'wantTradeConfirmations').checked = settings.wantTradeConfirmations !== false;
      field(container, 'wantTaxDocuments').checked = settings.wantTaxDocuments !== false;
    },

    readOptions(container) {
      return normalizeOptions({
        startYear: field(container, 'startYear').value,
        endYear: field(container, 'endYear').value,
        wantStatements: field(container, 'wantStatements').checked,
        wantTradeConfirmations: field(container, 'wantTradeConfirmations').checked,
        wantTaxDocuments: field(container, 'wantTaxDocuments').checked,
      });
    },

    async loadState() {
      const storage = providerStorage();
      const [settings, years] = await Promise.all([storage.loadSettings(), availableYears()]);
      return { settings, availableYears: years };
    },

    async discoverDocuments(options, report, controller) {
      const normalized = normalizeOptions(options);
      const settings = {
        startYear: normalized.startYear,
        endYear: normalized.endYear,
        wantStatements: normalized.categories.includes('statements'),
        wantTradeConfirmations: normalized.categories.includes('trade-confirmations'),
        wantTaxDocuments: normalized.categories.includes('tax-documents'),
      };
      await providerStorage().saveSettings(settings);
      if (isStopped(controller)) return [];

      const detectedYears = await availableYears(controller);
      if (isStopped(controller)) return [];
      const years = detectedYears.filter((year) => year >= normalized.startYear && year <= normalized.endYear).sort((a, b) => b - a);
      if (years.length === 0) {
        throw new Error('No requested years were found in Fidelity’s year menu; the year selector needs live calibration');
      }

      const documents = new Map();
      for (const year of years) {
        if (isStopped(controller)) break;
        if (!await selectYear(year, controller)) {
          if (isStopped(controller)) break;
          throw new Error(`Fidelity year ${year} could not be selected; the year selector needs live calibration`);
        }
        for (const category of normalized.categories) {
          if (isStopped(controller)) break;
          notify(report, 'discovering', `Inspecting Fidelity ${CATEGORY_LABELS[category].toLowerCase()} for ${year}…`, { year, category });
          const categoryWasActivated = await activateCategory(category, controller);
          if (isStopped(controller)) break;
          for (const document of collectDocuments(year, category, categoryWasActivated)) {
            if (isStopped(controller)) break;
            documents.set(document.id, document);
          }
        }
      }
      notify(report, 'discovered', `Found ${documents.size} Fidelity documents`, { count: documents.size });
      return Array.from(documents.values());
    },

    async downloadDocument(document, report, controller) {
      const metadata = document && document.metadata;
      if (!document || document.provider !== PROVIDER_ID || !metadata || !CATEGORY_LABELS[document.category]) {
        throw new Error('Invalid Fidelity document descriptor');
      }
      if (isStopped(controller)) throw cancellationError(controller);
      if (metadata.directUrl) return { url: metadata.directUrl, filename: document.filename };

      if (!await selectYear(metadata.year, controller)) {
        if (isStopped(controller)) throw cancellationError(controller);
        throw new Error(`Unable to restore Fidelity year ${metadata.year}`);
      }
      await activateCategory(document.category, controller);
      if (isStopped(controller)) throw cancellationError(controller);
      const element = findDocumentElement(document);
      if (!element) throw new Error(`Unable to find Fidelity document control for ${document.title}`);

      const started = await browserApi().runtime.sendMessage({ action: 'startDownloadWatch', extension: '.pdf' });
      if (!started || started.ok === false || !started.watchId) {
        throw new Error(started && started.error ? started.error : 'Unable to start Fidelity download watcher');
      }
      const cancelWatch = () => browserApi().runtime.sendMessage({
        action: 'cancelDownloadWatch',
        watchId: started.watchId,
      }).catch(() => {});
      try {
        if (isStopped(controller)) throw cancellationError(controller);
        element.click();
        notify(report, 'preparing', `Waiting for Fidelity to prepare ${document.title}…`, { document });
        const finished = await finishWatchedDownload(started.watchId, 120000, controller);
        if (!finished || finished.ok === false) {
          throw new Error(finished && finished.error ? finished.error : 'Fidelity download did not start');
        }
        return { downloaded: true, downloadId: finished.downloadId, filename: finished.filename };
      } catch (error) {
        if (!error.watchCancelled) await cancelWatch();
        throw error;
      }
    },
  };

  provider.helpers = {
    extractYear,
    extractYears,
    classifyCategory,
    normalizeDate,
    buildFilename,
    stableHrefIdentity,
    stableDocumentId,
    finishWatchedDownload,
  };
  app.providers.fidelity = provider;
})(globalThis);
