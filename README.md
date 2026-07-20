# Financial Statement Downloader for Firefox

A Firefox extension for bulk-downloading statements, trade confirmations, and tax
documents from supported financial institutions. It adds a **Bulk download** button to
each institution's document page and runs entirely inside your browser.

## Provider status

| Institution | Documents | Status |
| --- | --- | --- |
| Coinbase Pro | Monthly account and fill statements | Supported |
| Fidelity Investments | Statements, trade confirmations, and tax documents | Adapter in live calibration |
| Wealthfront | Statements, trade confirmations, and tax documents | Adapter in live calibration |

Fidelity and Wealthfront deliberately use separate DOM adapters. Fidelity is organized
around year-specific views; Wealthfront exposes a paginated all-years table and may prepare
a PDF asynchronously after it is clicked. Neither is forced through Coinbase's monthly
report-generation model.

## How it works

The extension has a small shared core for:

- normalized document metadata;
- provider-scoped settings and completed-download state;
- Firefox download-history checks;
- retries, rate-limit backoff, stopping, and progress reporting;
- an in-page launcher and Shadow DOM drawer that are insulated from the host site's CSS.

Each provider owns its page detection, document discovery, pagination, authenticated
download behavior, and filenames under `providers/`.

Coinbase's Statements page generates reports through an authenticated API. The extension
observes one normal Coinbase report request to learn the email and profile ID used by that
API, then generates the selected monthly reports at a conservative pace. Existing users'
legacy Coinbase settings are migrated into provider-scoped extension storage.

## Temporary installation

1. Clone or download this repository.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on…** and choose `manifest.json` from the repository root.
4. Sign in to a supported institution and navigate to its statements/documents page.
5. Use the injected **Bulk download** button.

Temporary add-ons are unloaded when Firefox restarts.

## Development

This is a plain JavaScript Manifest V2 extension with no bundler or runtime dependencies.
Use pnpm; do not use `npm ci`.

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The build is written to `dist/firefox-statement-downloader-extension.zip`. CI runs linting,
type-checking, unit tests, and a verified package build for pull requests and pushes to
`main`.

Provider documents use the following normalized shape:

```js
{
  provider: 'fidelity',
  id: 'stable-provider-owned-id',
  title: 'January 2026 statement',
  category: 'statements', // or trade-confirmations / tax-documents
  filename: 'Fidelity/statements/2026-01.pdf',
  date: '2026-01-31',
  account: 'Brokerage',
  metadata: {}
}
```

## Privacy and safety

- The extension does not ask for, store, or transmit institution passwords.
- Authenticated requests use the session you established directly with the institution.
- Provider settings and completed-document IDs remain in Firefox extension-local storage.
- Downloads go through Firefox's downloads API or the institution's own download control.
- Host permissions are limited to the supported institutions and their known report hosts.

Financial sites change frequently. Review the document count and filenames reported by the
drawer, use conservative delays, and verify downloaded files. This project is independent
and is not affiliated with or endorsed by Coinbase, Fidelity Investments, or Wealthfront.
