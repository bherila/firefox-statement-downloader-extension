'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtime = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'core/runtime.js'), 'utf8'), runtime);
const { amz } = runtime.FinancialStatementDownloader;
const assets = ['background.js', 'content.js', 'options.html', 'options.js', 'options.css', 'popup.html', 'popup.js', 'popup.css', 'core', 'providers', 'README.md', 'docs'];

function buildManifest(template = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))) {
  const expanded = JSON.stringify(template)
    .replaceAll('__AMZ_HOST__', amz.host)
    .replaceAll('__REPORTS_STORAGE_HOST__', amz.reportsStorageHost);
  if (/__[A-Z_]+__/.test(expanded)) throw new Error('Unexpanded manifest placeholder');
  return JSON.parse(expanded);
}

function build(outputDir = path.join(root, 'dist')) {
  outputDir = path.resolve(outputDir);
  const staging = path.join(outputDir, 'unpacked');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const asset of assets) fs.cpSync(path.join(root, asset), path.join(staging, asset), { recursive: true });
  fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(buildManifest(), null, 2)}\n`);
  const archive = path.join(outputDir, 'firefox-statement-downloader-extension.zip');
  // Recreate the ZIP so removed/renamed assets cannot survive an earlier build.
  fs.rmSync(archive, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', archive, 'manifest.json', ...assets], { cwd: staging });
  return { staging, archive };
}

module.exports = { amz, assets, buildManifest, build };
if (require.main === module) build();
