'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { amz, buildManifest, build } = require('../scripts/build.js');

const root = path.resolve(__dirname, '..');
const expectedPermissions = [
  'https://accounts.coinbase.com/*', `${amz.reportsOrigin}/*`,
  'https://digitalservices.fidelity.com/*', 'https://dpservice.fidelity.com/*',
  'https://workplaceservices.fidelity.com/*', 'https://www.wealthfront.com/*',
  'https://connect.meritain.com/*', 'https://ext-web.etrade.com/*',
  'webRequest', 'downloads', 'storage', `${amz.origin}/*`, 'alarms',
];

test('manifest template expands exact narrow origins without widening permissions', () => {
  const template = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  assert.ok(template.includes('__AMZ_HOST__'));
  assert.ok(template.includes('__REPORTS_STORAGE_HOST__'));
  const manifest = buildManifest();
  assert.deepEqual(manifest.permissions, expectedPermissions);
  assert.deepEqual(manifest.optional_permissions, ['https://pfifi.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches.slice(6), [
    '/gp/css/order-history*', '/your-orders/*', '/fopo/order-details*',
    '/uff/your-account/order-details*', '/gc/balance*', '/gp/css/gc/balance*',
  ].map((route) => `${amz.origin}${route}`));
  assert.ok(!JSON.stringify(manifest).includes('__AMZ_HOST__'));
  assert.throws(() => buildManifest({ unknown: '__UNKNOWN_HOST__' }), /Unexpanded/);
});

test('package emits a loadable manifest and includes every unchanged runtime dependency', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsd-build-'));
  try {
    const { staging, archive } = build(outputDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, buildManifest());
    const archived = JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }));
    assert.deepEqual(archived, manifest);
    execFileSync('unzip', ['-t', archive]);
    const names = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    const scripts = [...new Set([...manifest.background.scripts, ...manifest.content_scripts.flatMap((entry) => entry.js)])];
    for (const file of [...scripts, manifest.options_ui.page, 'options.js', 'options.css', manifest.browser_action.default_popup, 'popup.js', 'popup.css']) {
      assert.ok(names.includes(file), `Missing packaged asset: ${file}`);
      assert.deepEqual(fs.readFileSync(path.join(staging, file)), fs.readFileSync(path.join(root, file)));
      if (file.endsWith('.js')) new vm.Script(fs.readFileSync(path.join(staging, file), 'utf8'), { filename: file });
    }
    // Execute the shared configuration and both adapters exactly in manifest order.
    const scope = { URL };
    for (const file of manifest.background.scripts.slice(0, 3)) {
      vm.runInNewContext(fs.readFileSync(path.join(staging, file), 'utf8'), scope);
    }
    const fsd = scope.FinancialStatementDownloader;
    assert.equal(fsd.amz.origin, amz.origin);
    assert.equal(fsd.providers.amz.helpers.pageKind(`${amz.origin}/your-orders/order-details`), 'detail');
    assert.equal(fsd.providers.amzGiftCards.helpers.pageKind(`${amz.origin}/gc/balance`), 'balance');
    // A second build removes stale staged files and stale archive entries.
    fs.writeFileSync(path.join(staging, 'obsolete.js'), 'obsolete');
    build(outputDir);
    assert.ok(!fs.existsSync(path.join(staging, 'obsolete.js')));
    assert.ok(!execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).includes('obsolete.js'));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
