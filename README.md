# Financial Statement Downloader for Firefox

A Firefox extension for bulk-downloading financial documents and passively collecting
Amazon receipts. It runs inside your browser, with optional uploads to Planfina using
your existing signed-in session.

## Provider status

| Institution | Documents | Status |
| --- | --- | --- |
| Coinbase Pro | Monthly account and fill statements | Supported |
| Fidelity Investments | Statements, trade confirmations, account records, and tax forms | Supported |
| Wealthfront | Statements, trade confirmations, and tax forms | Supported |
| E*TRADE | Statements, trade confirmations, tax forms, and correspondence | Needs live verification |
| Fidelity NetBenefits | Generated plan statements and transaction history | Untested against a live plan |
| Meritain Health | Medical and Rx EOB PDFs | Supported |
| Amazon US | Standard, Whole Foods in-store, and Fresh itemized receipts | Passive capture; validated against saved pages |
| Fidelity Credit Card | Card statements | Not supported |

Providers deliberately use separate adapters rather than a shared model.

## Amazon receipts and optional imports

Browse Amazon's order history normally and open order details yourself. The extension
automatically saves item descriptions, ASINs when present, quantities and units, prices,
labeled charges, totals, and printed dates/status. It makes **no Amazon requests**, follows
no links, and does not open orders or invoices. Order-history summaries alone do not contain
the full receipt and are not saved as detailed receipts. Only US English layouts are supported.

Use **Bulk download → Find documents → Download** to export collected receipts as JSON,
or open the extension's settings for an archive export and upload status. Exact repeats
are skipped; changed orders become separate revisions. Missing or unparseable item data
keeps a receipt local for review. Capture includes preloaded item tables, so Fresh's collapsed
carousel does not restrict it to the initially visible products.

In extension settings, **Connect and enable automatic receipt imports** requests optional
access to `pfifi.com` and pins the currently signed-in account. The public browser-import
API stores immutable receipt sources with their itemized data; receipt capture does not
post ledger transactions or run AI. You can also select statement, payslip, utility-bill,
and equity-award files to upload explicitly to the existing import queue for review.
Those document imports may use the destination's configured AI processing.

Login cookies are sent by Firefox; the extension never reads or saves them. CSRF tokens
stay in background memory. An identity-provider login alone may require opening the app
once to establish its session. Normal-profile sessions are supported; private-window capture
is disabled, and container-only logins may require signing in in a normal tab. The receipt
receiver and session-bootstrap endpoints must be available before connecting can succeed.

Imports send up to twenty receipts per request, with at least five seconds between batches.
HTTP 429 responses honor `Retry-After` and retry automatically with increasing, randomized
backoff; the pending receipt batch and retry deadline survive a browser restart. Other failures
and account changes pause imports until you reconnect. Pause prevents starting another batch;
an upload already in flight can finish. Previously pinned records never move to a different account.
Source documents stay local until imports are enabled. Storage holds up to 2,000 revisions;
export before clearing it. Clearing also removes local upload history. Raw HTML, images,
shipping addresses, payment credentials, and the HAR used for calibration are not stored.

The API contract, design, and remaining scope are in [docs/passive-receipts.md](docs/passive-receipts.md).

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

NetBenefits is a generator rather than an archive: no statement exists until one is
requested for a date range, so the extension asks for periods instead of enumerating
documents. Retention is ten years minus a day and rolls daily, so anything not generated
becomes unrecoverable over time. Statements come back as HTML with the balance chart as a
separate image, which is inlined so each saved file stands alone. Submissions go through
the page's own form into a hidden iframe, because every legitimate submission on that
server-rendered app is a navigation and a long run of scripted POSTs is not. Transaction
history exports as CSV; the QIF alternative silently omits transfers and revenue credits.
See `docs/netbenefits-calibration.md`.

Wealthfront needs only two authenticated GETs, both of which return the whole corpus with
no range or page parameter; its documents page paginates in memory, so scraping the table
would page through data the extension can request once. Documents are served directly at
stable URLs, so downloads go straight to the browser. Trade confirmations outnumber
everything else several times over and are offered but not preselected.

E*TRADE advertises the available years separately for each document type. The provider
uses those year lists to query all accounts for statements, trade confirmations, tax
forms, and correspondence, follows pagination until the API's reported total has been
reconciled, and downloads each PDF through the matching document endpoint. Authentication
is bootstrapped from the signed-in Documents page and kept only in memory. Trade
confirmations are included by default but use a conservative randomized request cadence.

Meritain's member claims page exposes a paginated claims API with fifteen records per
request. The provider requests Medical and Rx claims for the selected date range (or all
available records), confirms each EOB through the member's detail API, and downloads the
PDF through Meritain's own authenticated document endpoint. Files use the existing
`Acct.EOB.Meritain/EOB_<claim-number>.pdf` convention so Firefox history and provider
completion state can skip documents already collected. If the PDFs were collected outside
Firefox or its download history has been cleared, **Import existing EOB folder** records the
matching filenames for the currently signed-in member. The import reads only file names—not
PDF contents—and the next document search marks matching EOBs as already complete.
During an active run, the provider refreshes Meritain's normal API token at least every
four minutes as a best-effort session keepalive. Server-enforced absolute timeouts and
explicit refusals are still terminal; the extension does not retry through them.

No provider is forced through Coinbase's monthly report-generation model.

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
Per-file progress reports show the current file, total files, and how many remain.

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

## Contributing safely

Providers are calibrated against real accounts, so real account numbers and plan
identifiers are easy to paste into a test fixture without noticing. This repository is
public, and rewriting history does not reliably remove such a value once pushed.

`pnpm install` installs a pre-commit hook that blocks them. See `AGENTS.md` for how it
works and what to do if hooks are not firing.

## Privacy and safety

- The extension does not ask for, store, or transmit institution passwords.
- Authenticated requests use the session you established directly with the institution.
- Provider settings and completed-document IDs remain in Firefox extension-local storage.
- Downloads go through Firefox's downloads API or the institution's own download control.
- Host permissions are limited to the supported institutions and their known report hosts.

Financial sites change frequently. Review the document count and filenames reported by the
drawer, use conservative delays, and verify downloaded files. This project is independent
and is not affiliated with or endorsed by Coinbase, E*TRADE, Fidelity Investments,
Meritain Health, or Wealthfront.
