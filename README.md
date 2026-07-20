# Financial Statement Downloader for Firefox

A Firefox extension for bulk-downloading statements, trade confirmations, and tax
documents from supported financial institutions. It adds a **Bulk download** button to
each institution's document page and runs entirely inside your browser.

## Provider status

| Institution | Documents | Status |
| --- | --- | --- |
| Coinbase Pro | Monthly account and fill statements | Supported |
| Fidelity Investments | Statements, trade confirmations, account records, and tax forms | Supported |
| Wealthfront | Statements, trade confirmations, and tax forms | Supported |
| Fidelity NetBenefits | Workplace/employer plan documents | Planned |
| Fidelity Credit Card | Card statements | Not supported |

Providers deliberately use separate adapters rather than a shared model.

Retail Fidelity, NetBenefits, and the credit card are three separate archives, not one.
The retail document APIs return nothing for workplace or card accounts even though both
appear in the retail account list, so documents for them have to come from their own
origins. Anything they hold is absent from what this extension collects.

Institutions discard documents after a retention period, and the period differs by
document type rather than applying uniformly. Fidelity keeps statements for about ten
years while serving trade confirmations and account records considerably longer. Anything
older than the wall is unrecoverable, so an existing archive of old documents is worth
more than the tool's output for those years: merge into it, never over it.

Fidelity drives the document center's own JSON APIs instead of its DOM. The rendered
table shows at most ten rows per filter, sorted newest first, with no pagination — so
scraping it cannot reach more than the ten most recent documents of any period, and its
links carry no URL to harvest. The listing API accepts an arbitrary date range and returns
everything in one request. Documents resolve into three scopes: per-account, householded
(one document covering several accounts), and customer-level records with no account at
all. Householded and per-account documents for the same period are distinct files and are
both kept. The document center's Employer category is a link off to NetBenefits rather
than a category it serves, so those documents are not reachable here.

Wealthfront needs only two authenticated GETs, both of which return the whole corpus with
no range or page parameter; its documents page paginates in memory, so scraping the table
would page through data the extension can request once. Documents are served directly at
stable URLs, so downloads go straight to the browser. Trade confirmations outnumber
everything else several times over and are offered but not preselected.

Neither provider is forced through Coinbase's monthly report-generation model.

## How it works

The extension has a small shared core for:

- normalized document metadata;
- provider-scoped settings and completed-download state;
- Firefox download-history checks;
- retries, rate-limit backoff, stopping, and progress reporting;
- an in-page launcher and Shadow DOM drawer that are insulated from the host site's CSS.

Downloading is a two-step flow. Choosing a date range and finding documents lists what
would be fetched, grouped by the folder each file lands in; downloading is only enabled
once that preview exists, and any change to the controls invalidates it. Requests are
spaced with a randomized delay so the cadence is not a fixed signature, and completed
document IDs are recorded so an interrupted run resumes instead of restarting.

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
