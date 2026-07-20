(() => {
  const REPORT_TYPES = {
    account: {
      label: 'Account statements',
      requestKey: 'account',
      buildScope: () => ({ accountId: 'ALL' }),
      folder: 'account',
    },
    fills: {
      label: 'Fill statements',
      requestKey: 'fills',
      buildScope: () => ({ productId: 'ALL' }),
      folder: 'fill',
    },
  };

  let stopRequested = false;
  let running = false;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function monthRange(startYear, startMonth, endYear, endMonth) {
    const months = [];
    let y = startYear;
    let m = startMonth;
    while (y < endYear || (y === endYear && m <= endMonth)) {
      months.push({ year: y, month: m });
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    return months;
  }

  function isoStartOfMonth(year, month) {
    return `${year}-${pad2(month)}-01T00:00:00.000Z`;
  }

  function isoEndOfMonth(year, month) {
    // Date.UTC(year, month, 0) rolls back to the last day of `month` (1-indexed) because
    // day 0 of month N is the last day of month N-1 in JS's Date arithmetic.
    return new Date(Date.UTC(year, month, 0)).toISOString();
  }

  async function generateReport(template, typeKey, year, month) {
    const type = REPORT_TYPES[typeKey];
    const body = {
      format: 'PRO_REPORT_FORMAT_PDF',
      email: template.email,
      profile_id: template.profile_id,
      proof_token: template.proof_token || '',
      [type.requestKey]: {
        ...type.buildScope(),
        startDate: isoStartOfMonth(year, month),
        endDate: isoEndOfMonth(year, month),
      },
    };
    const res = await fetch('https://accounts.coinbase.com/v1/statements/generate-pro-report', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`generate-pro-report HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    if (!json.id) {
      throw new Error('generate-pro-report response missing id');
    }
    return json.id;
  }

  async function pollUntilComplete(id, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fetch(`https://accounts.coinbase.com/v1/statements/pro-report/${id}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const err = new Error(`pro-report poll HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const json = await res.json();
      if (json.status === 'PRO_REPORT_STATUS_COMPLETED' && json.file_url) {
        return json.file_url;
      }
      if (json.status && json.status.includes('FAIL')) {
        throw new Error(`report generation failed: ${json.status}`);
      }
      await sleep(800);
    }
    throw new Error('timed out waiting for report to complete');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Retries with exponential backoff; a 429 (rate limited) backs off harder than other errors,
  // since hammering generate-pro-report is exactly what triggers it.
  async function withRetry(fn, { attempts = 4, baseDelayMs = 3000 } = {}, onRetry) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) {
          break;
        }
        const isRateLimited = err.status === 429;
        const delay = isRateLimited ? baseDelayMs * Math.pow(2, i + 2) : baseDelayMs * Math.pow(2, i);
        if (onRetry) {
          onRetry(err, delay, i + 1, attempts - 1);
        }
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  async function loadTemplate() {
    const stored = await browser.storage.local.get('template');
    return stored.template || null;
  }

  async function saveTemplate(email, profileId) {
    const template = { email, profile_id: profileId, proof_token: '' };
    await browser.storage.local.set({ template });
    return template;
  }

  async function loadDoneSet() {
    const stored = await browser.storage.local.get('done');
    return new Set(Object.keys(stored.done || {}));
  }

  async function markDone(key) {
    const stored = await browser.storage.local.get('done');
    const done = stored.done || {};
    done[key] = true;
    await browser.storage.local.set({ done });
  }

  async function clearDoneSet() {
    await browser.storage.local.set({ done: {} });
  }

  async function loadSettings() {
    const stored = await browser.storage.local.get('settings');
    return stored.settings || null;
  }

  async function saveSettings(settings) {
    await browser.storage.local.set({ settings });
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'cb-pro-dl-panel';
    panel.innerHTML = `
      <div class="cb-pro-dl-header">Coinbase Pro Statement Downloader</div>
      <div class="cb-pro-dl-row cb-pro-dl-status" id="cb-pro-dl-template-status">Checking calibration…</div>
      <div class="cb-pro-dl-row cb-pro-dl-manual">
        <input type="email" id="cb-pro-dl-email" placeholder="email (auto-detected)">
        <input type="text" id="cb-pro-dl-profile" placeholder="profile_id (auto-detected)">
        <button id="cb-pro-dl-save-template">Save</button>
      </div>
      <div class="cb-pro-dl-row">
        <label>From <input type="number" id="cb-pro-dl-start-year" placeholder="yyyy" style="width:4.5em"> -
          <input type="number" id="cb-pro-dl-start-month" placeholder="mm" min="1" max="12" style="width:3em"></label>
      </div>
      <div class="cb-pro-dl-row">
        <label>To <input type="number" id="cb-pro-dl-end-year" placeholder="yyyy" style="width:4.5em"> -
          <input type="number" id="cb-pro-dl-end-month" placeholder="mm" min="1" max="12" style="width:3em"></label>
      </div>
      <div class="cb-pro-dl-row">
        <label><input type="checkbox" id="cb-pro-dl-type-account" checked> Account statements</label>
        <label><input type="checkbox" id="cb-pro-dl-type-fills" checked> Fill statements</label>
      </div>
      <div class="cb-pro-dl-row">
        <label>Delay between requests (ms) <input type="number" id="cb-pro-dl-delay-ms" placeholder="3000" min="1000" step="500" style="width:5em"></label>
      </div>
      <div class="cb-pro-dl-row">
        <button id="cb-pro-dl-start">Start</button>
        <button id="cb-pro-dl-stop" disabled>Stop</button>
        <button id="cb-pro-dl-reset">Reset progress</button>
      </div>
      <div class="cb-pro-dl-log" id="cb-pro-dl-log"></div>
    `;
    document.body.appendChild(panel);
    return panel;
  }

  function log(panel, message) {
    const el = panel.querySelector('#cb-pro-dl-log');
    const line = document.createElement('div');
    line.textContent = message;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  async function refreshTemplateStatus(panel) {
    const template = await loadTemplate();
    const status = panel.querySelector('#cb-pro-dl-template-status');
    if (template) {
      status.textContent = `Calibrated: ${template.email} / ${template.profile_id}`;
      status.className = 'cb-pro-dl-row cb-pro-dl-status cb-pro-dl-ok';
      panel.querySelector('#cb-pro-dl-email').value = template.email;
      panel.querySelector('#cb-pro-dl-profile').value = template.profile_id;
    } else {
      status.textContent = 'Not calibrated — click any PDF/CSV link once on this page, or fill in manually below.';
      status.className = 'cb-pro-dl-row cb-pro-dl-status cb-pro-dl-warn';
    }
    return template;
  }

  async function isAlreadyOnDisk(filename) {
    try {
      const result = await browser.runtime.sendMessage({ action: 'checkDownloaded', relPath: filename });
      return Boolean(result && result.exists);
    } catch (e) {
      return false;
    }
  }

  async function runBatch(panel) {
    const template = await loadTemplate();
    if (!template) {
      log(panel, 'ERROR: no template captured yet. Click a PDF/CSV link once, or fill in email + profile_id manually.');
      return;
    }
    const startYear = parseInt(panel.querySelector('#cb-pro-dl-start-year').value, 10);
    const startMonth = parseInt(panel.querySelector('#cb-pro-dl-start-month').value, 10);
    const endYear = parseInt(panel.querySelector('#cb-pro-dl-end-year').value, 10);
    const endMonth = parseInt(panel.querySelector('#cb-pro-dl-end-month').value, 10);
    if (!startYear || !startMonth || !endYear || !endMonth) {
      log(panel, 'ERROR: fill in the From/To year and month fields.');
      return;
    }
    const wantAccount = panel.querySelector('#cb-pro-dl-type-account').checked;
    const wantFills = panel.querySelector('#cb-pro-dl-type-fills').checked;
    const typeKeys = [...(wantAccount ? ['account'] : []), ...(wantFills ? ['fills'] : [])];
    if (typeKeys.length === 0) {
      log(panel, 'ERROR: select at least one statement type.');
      return;
    }
    const delayMs = Math.max(1000, parseInt(panel.querySelector('#cb-pro-dl-delay-ms').value, 10) || 3000);

    await saveSettings({ startYear, startMonth, endYear, endMonth, wantAccount, wantFills, delayMs });

    const months = monthRange(startYear, startMonth, endYear, endMonth);
    const doneSet = await loadDoneSet();

    stopRequested = false;
    running = true;
    panel.querySelector('#cb-pro-dl-start').disabled = true;
    panel.querySelector('#cb-pro-dl-stop').disabled = false;
    log(panel, `Starting batch: ${months.length} months x ${typeKeys.length} type(s), ${delayMs}ms between requests.`);

    for (const { year, month } of months) {
      if (stopRequested) {
        log(panel, 'Stopped by user.');
        break;
      }
      for (const typeKey of typeKeys) {
        if (stopRequested) {
          break;
        }
        const key = `${typeKey}:${year}-${pad2(month)}`;
        const filename = `CoinbaseProStatements/${REPORT_TYPES[typeKey].folder}/${year}-${pad2(month)}.pdf`;
        if (doneSet.has(key)) {
          log(panel, `skip (already done): ${key}`);
          continue;
        }
        if (await isAlreadyOnDisk(filename)) {
          await markDone(key);
          doneSet.add(key);
          log(panel, `skip (file already on disk): ${key}`);
          continue;
        }
        try {
          const onRetry = (err, delay, attempt, maxAttempt) => {
            log(panel, `  retry ${attempt}/${maxAttempt} for ${key} after "${err.message}" — waiting ${Math.round(delay / 1000)}s`);
          };
          const id = await withRetry(() => generateReport(template, typeKey, year, month), {}, onRetry);
          const fileUrl = await withRetry(() => pollUntilComplete(id), {}, onRetry);
          const result = await browser.runtime.sendMessage({ action: 'download', url: fileUrl, filename });
          if (result && result.ok) {
            await markDone(key);
            doneSet.add(key);
            log(panel, `done: ${key} -> ${filename}`);
          } else {
            log(panel, `FAILED (download): ${key} — ${result && result.error}`);
          }
        } catch (err) {
          log(panel, `FAILED: ${key} — ${err.message || err}`);
        }
        await sleep(delayMs);
      }
    }

    running = false;
    panel.querySelector('#cb-pro-dl-start').disabled = false;
    panel.querySelector('#cb-pro-dl-stop').disabled = true;
    log(panel, 'Batch finished.');
  }

  function wirePanel(panel) {
    panel.querySelector('#cb-pro-dl-save-template').addEventListener('click', async () => {
      const email = panel.querySelector('#cb-pro-dl-email').value.trim();
      const profileId = panel.querySelector('#cb-pro-dl-profile').value.trim();
      if (!email || !profileId) {
        log(panel, 'ERROR: both email and profile_id are required to save manually.');
        return;
      }
      await saveTemplate(email, profileId);
      await refreshTemplateStatus(panel);
      log(panel, 'Template saved manually.');
    });

    panel.querySelector('#cb-pro-dl-start').addEventListener('click', () => {
      if (!running) {
        runBatch(panel);
      }
    });

    panel.querySelector('#cb-pro-dl-stop').addEventListener('click', () => {
      stopRequested = true;
    });

    panel.querySelector('#cb-pro-dl-reset').addEventListener('click', async () => {
      await clearDoneSet();
      log(panel, 'Progress reset — all months will be re-downloaded on next Start.');
    });

    browser.storage.onChanged.addListener((changes) => {
      if (changes.template) {
        refreshTemplateStatus(panel);
      }
    });
  }

  async function restoreSettings(panel) {
    const settings = await loadSettings();
    if (!settings) {
      panel.querySelector('#cb-pro-dl-delay-ms').value = 3000;
      return;
    }
    panel.querySelector('#cb-pro-dl-start-year').value = settings.startYear || '';
    panel.querySelector('#cb-pro-dl-start-month').value = settings.startMonth || '';
    panel.querySelector('#cb-pro-dl-end-year').value = settings.endYear || '';
    panel.querySelector('#cb-pro-dl-end-month').value = settings.endMonth || '';
    panel.querySelector('#cb-pro-dl-type-account').checked = settings.wantAccount !== false;
    panel.querySelector('#cb-pro-dl-type-fills').checked = settings.wantFills !== false;
    panel.querySelector('#cb-pro-dl-delay-ms').value = settings.delayMs || 3000;
  }

  const panel = buildPanel();
  wirePanel(panel);
  refreshTemplateStatus(panel);
  restoreSettings(panel);
})();
