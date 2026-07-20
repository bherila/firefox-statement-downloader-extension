(function initializeUi(root) {
  'use strict';

  const FSD = root.FinancialStatementDownloader || {};

  const STYLES = `
    :host { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    button, input, select { font: inherit; }
    .launcher { appearance: none; border: 1px solid #8a8f98; border-radius: 6px; background: #fff;
      color: #15171a; cursor: pointer; font-weight: 600; line-height: 1; padding: 9px 12px; }
    .launcher:hover { background: #f3f5f7; }
    .drawer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    .drawer[hidden] { display: none; }
    .scrim { position: absolute; inset: 0; background: rgba(0,0,0,.28); opacity: 0; transition: opacity .15s; }
    .sheet { position: absolute; top: 0; right: 0; width: min(440px, 100vw); height: 100%; padding: 20px;
      overflow: auto; background: #fff; color: #15171a; box-shadow: -8px 0 32px rgba(0,0,0,.22);
      transform: translateX(100%); transition: transform .15s; }
    .drawer.open { pointer-events: auto; }
    .drawer.open .scrim { opacity: 1; }
    .drawer.open .sheet { transform: translateX(0); }
    .header { display: flex; align-items: start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    h2 { font-size: 18px; line-height: 1.3; margin: 0; }
    .subtitle { color: #5d626b; font-size: 12px; margin-top: 3px; }
    .close { appearance: none; border: 0; background: transparent; color: #444; cursor: pointer; font-size: 24px; line-height: 1; }
    .controls { display: grid; gap: 12px; }
    .controls label { display: grid; gap: 5px; font-size: 13px; }
    .controls input[type="text"], .controls input[type="email"], .controls input[type="number"], .controls select {
      width: 100%; border: 1px solid #b9bdc4; border-radius: 5px; padding: 7px 8px; background: #fff; color: #15171a; }
    .controls .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .controls .row label { display: flex; align-items: center; gap: 5px; }
    .controls .fsd-provider-status { border-radius: 5px; background: #eef4ff; font-size: 12px; padding: 8px; }
    .controls .fsd-provider-status[data-state="warning"] { background: #fff4cf; color: #684f00; }
    .actions { display: flex; gap: 8px; margin: 18px 0 12px; }
    .actions button { appearance: none; border: 1px solid #a7abb2; border-radius: 6px; background: #f6f7f8; cursor: pointer; padding: 8px 11px; }
    .actions .primary { background: #1769e0; border-color: #1769e0; color: #fff; font-weight: 600; }
    button:disabled { cursor: default; opacity: .5; }
    .status { border-radius: 6px; background: #f0f2f4; font-size: 12px; padding: 8px 10px; }
    .status.error { background: #fde8e8; color: #8b1717; }
    .log { border: 1px solid #e0e2e5; border-radius: 6px; background: #fafbfc; font: 11px/1.5 ui-monospace, Menlo, monospace;
      margin-top: 10px; max-height: 260px; overflow: auto; padding: 8px; white-space: pre-wrap; }
    .fallback { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; }
  `;

  function createShadowHost(id) {
    const host = document.createElement('span');
    host.dataset.fsdHost = id;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.appendChild(style);
    return { host, shadow };
  }

  function appendMarkup(shadow, markup) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    shadow.appendChild(template.content.cloneNode(true));
  }

  function mountProvider(provider) {
    let launcher = null;
    let drawer = null;
    let controller = null;
    let destroyed = false;
    let providerReady = false;

    function close() {
      if (!drawer) return;
      const shell = drawer.shadow.querySelector('.drawer');
      shell.classList.remove('open');
      root.setTimeout(() => { shell.hidden = true; }, 160);
    }

    function open() {
      const shell = drawer.shadow.querySelector('.drawer');
      shell.hidden = false;
      root.requestAnimationFrame(() => shell.classList.add('open'));
    }

    function report(event) {
      const status = drawer.shadow.querySelector('.status');
      const log = drawer.shadow.querySelector('.log');
      let message = typeof event === 'string' ? event : event && event.message;
      if (!message && event) {
        const name = event.document && event.document.title;
        const messages = {
          'discovery-start': 'Discovering available documents…',
          'discovery-complete': `Found ${event.count} document(s).`,
          'document-skipped': `Skipped ${name} (already downloaded).`,
          'download-start': `Downloading ${name}…`,
          'download-complete': `Downloaded ${name}.`,
          'download-retry': `Retrying ${name} after ${event.error} (${event.attempt}/${event.attempts})…`,
          'download-failed': `Failed ${name}: ${event.error}`,
          'history-check-failed': `Could not check download history for ${name}: ${event.error}`,
        };
        message = messages[event.type];
      }
      if (!message) return;
      status.textContent = message;
      status.classList.toggle('error', Boolean(event && (event.level === 'error' || event.type === 'download-failed')));
      const line = document.createElement('div');
      line.textContent = message;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    }

    async function start() {
      const startButton = drawer.shadow.querySelector('[data-action="start"]');
      const stopButton = drawer.shadow.querySelector('[data-action="stop"]');
      if (!providerReady) {
        report({ level: 'error', message: 'Provider controls are still loading.' });
        return;
      }
      try {
        const options = await provider.readOptions(drawer.shadow.querySelector('.controls'));
        controller = FSD.createStopController();
        startButton.disabled = true;
        stopButton.disabled = false;
        const summary = await FSD.runBatch({ provider, options, controller, report });
        report(`Finished: ${summary.downloaded} downloaded, ${summary.skipped} skipped, ${summary.failed} failed.`);
      } catch (error) {
        report({ level: 'error', message: `ERROR: ${error.message || error}` });
      } finally {
        controller = null;
        startButton.disabled = false;
        stopButton.disabled = true;
      }
    }

    function buildDrawer() {
      providerReady = false;
      drawer = createShadowHost(`${provider.id}-drawer`);
      drawer.host.style.display = 'contents';
      appendMarkup(drawer.shadow, `
        <div class="drawer" hidden>
          <div class="scrim" data-action="close"></div>
          <section class="sheet" role="dialog" aria-modal="true" aria-label="Bulk download ${provider.label} documents">
            <div class="header">
              <div><h2>Bulk download</h2><div class="subtitle"></div></div>
              <button class="close" data-action="close" aria-label="Close">×</button>
            </div>
            <div class="controls"></div>
            <div class="actions">
              <button class="primary" data-action="start" disabled>Start download</button>
              <button data-action="stop" disabled>Stop</button>
              <button data-action="reset">Reset progress</button>
            </div>
            <div class="status">Ready.</div>
            <div class="log" aria-live="polite"></div>
          </section>
        </div>
      `);
      drawer.shadow.querySelector('.subtitle').textContent = provider.label;
      drawer.shadow.querySelectorAll('[data-action="close"]').forEach((button) => button.addEventListener('click', close));
      drawer.shadow.querySelector('[data-action="start"]').addEventListener('click', start);
      drawer.shadow.querySelector('[data-action="stop"]').addEventListener('click', () => controller && controller.stop());
      drawer.shadow.querySelector('[data-action="reset"]').addEventListener('click', async () => {
        await FSD.createProviderStorage(provider.id).clearDone();
        report('Saved download progress was reset.');
      });
      document.documentElement.appendChild(drawer.host);
      Promise.resolve(provider.loadState ? provider.loadState() : {}).then((state) => {
        provider.renderControls(drawer.shadow.querySelector('.controls'), state || {});
        providerReady = true;
        drawer.shadow.querySelector('[data-action="start"]').disabled = false;
      }).catch((error) => {
        providerReady = false;
        report({ level: 'error', message: `Unable to load settings: ${error.message || error}` });
      });
    }

    function buildLauncher() {
      const mountPoint = provider.findMountPoint();
      launcher = createShadowHost(`${provider.id}-launcher`);
      appendMarkup(launcher.shadow, '<button class="launcher" type="button">Bulk download</button>');
      launcher.shadow.querySelector('button').addEventListener('click', open);

      if (mountPoint && mountPoint.parentNode) {
        launcher.host.style.marginInlineStart = '8px';
        mountPoint.parentNode.insertBefore(launcher.host, mountPoint.nextSibling);
      } else {
        launcher.host.classList.add('fallback');
        launcher.host.style.position = 'fixed';
        launcher.host.style.right = '18px';
        launcher.host.style.bottom = '18px';
        launcher.host.style.zIndex = '2147483646';
        document.documentElement.appendChild(launcher.host);
      }
    }

    function ensureMounted() {
      if (destroyed) return;
      if (!drawer || !drawer.host.isConnected) buildDrawer();
      if (!launcher || !launcher.host.isConnected) buildLauncher();
    }

    function destroy() {
      destroyed = true;
      if (controller) controller.stop();
      if (launcher) launcher.host.remove();
      if (drawer) drawer.host.remove();
    }

    ensureMounted();
    return { ensureMounted, destroy };
  }

  FSD.mountProvider = mountProvider;
  root.FinancialStatementDownloader = FSD;
})(globalThis);
