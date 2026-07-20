# Financial Statement Downloader for Firefox

A Firefox extension for bulk-downloading statements and related financial documents from
supported institutions. Coinbase Pro is currently supported; Fidelity Investments and
Wealthfront support is being added through separate institution adapters.

## How it works

Coinbase's Statements > Other tab, when you click a "PDF" link, does this under the hood:

1. `POST https://accounts.coinbase.com/v1/statements/generate-pro-report` with a body like
   `{"format":"PRO_REPORT_FORMAT_PDF","email":...,"profile_id":...,"account":{"accountId":"ALL","startDate":...,"endDate":...},"proof_token":""}`
   (or `"fills":{"productId":"ALL",...}` for fill statements), returning `{"id": "..."}`.
2. Polls `GET https://accounts.coinbase.com/v1/statements/pro-report/{id}` until
   `status` is `PRO_REPORT_STATUS_COMPLETED` and `file_url` is populated (a presigned
   `gdax-reports.s3.amazonaws.com` URL).
3. Navigates the tab to `file_url`.

This extension replicates steps 1-2 directly via `fetch()` from the content script (same
origin as `accounts.coinbase.com`, so your session cookies apply automatically) for every
month in a date range you choose, then saves each resulting PDF via the `downloads` API
instead of navigating anywhere — no per-row clicking, no "Load more" pagination needed.

`profile_id` and `email` are captured automatically the first time you click any PDF/CSV
link on the Statements page yourself (a background script passively observes that one
request). You can also type them in manually in the panel if you'd rather not click anything
first — `profile_id` is visible in any `generate-pro-report` request body in DevTools' Network
tab.

## Install (temporary, for personal use)

1. Open Firefox, go to `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on…" and select `manifest.json` from this directory (or, if
   you've built a zip — see below — select that instead).
3. Navigate to `https://accounts.coinbase.com/statements/pro`, log in, and click the
   "Other" tab (where Coinbase Pro Account/Fill Statements live).
4. A small panel appears in the top-right corner.

Note: temporary add-ons are unloaded when Firefox restarts — reload it via the same
`about:debugging` page if needed.

## Build

No bundler or transpilation — this is plain JS loaded directly by the manifest. The only
"build" step is zipping the four extension files up for distribution/loading as a single
file instead of a directory:

```bash
pnpm run build   # writes dist/coinbase-statement-downloader.zip
pnpm run clean   # removes dist/
```

## Use

1. If the panel says "Not calibrated", click any PDF or CSV link on the page once (it
   fails harmlessly if there's nothing to show — this is just to let the extension observe
   the request), or fill in Email + profile_id manually and click Save.
2. Fill in the From/To year and month fields (e.g. From `2018` `12` to `2023` `11`).
3. Check "Account statements" and/or "Fill statements".
4. Leave "Delay between requests" at its default (3000ms) unless you know the API tolerates
   faster calls — this is deliberately conservative since `generate-pro-report` rate-limits
   (HTTP 429) if hit too quickly. On a 429 the batch backs off exponentially (harder than for
   other errors) and retries a few times before giving up on that month and moving on.
5. Click Start. Progress logs in the panel; each completed month is downloaded to your
   default Downloads folder under `CoinbaseProStatements/account/yyyy-mm.pdf` or
   `CoinbaseProStatements/fill/yyyy-mm.pdf`.
6. Click Stop at any time. Your From/To range, checkboxes, and delay are remembered for next
   time. Months already downloaded are skipped on re-run two ways: an internal per-month
   record in extension storage, and (as a fallback, in case that record is missing or you'd
   already saved a file manually) a real check against your Downloads history for a matching
   file. "Reset progress" clears the internal record if you want to force everything to
   re-download.

After downloading, move the `CoinbaseProStatements` folder wherever you actually want to
keep the PDFs (e.g. a cloud-synced statements archive) — the extension can only write into
the browser's configured Downloads directory.

## Notes / limitations

- Firefox-only (uses `browser.*` APIs and Manifest V2, which Firefox continues to support).
- No bundler/build step — load the directory as-is.
- This calls Coinbase's own authenticated API on your behalf, from your own logged-in
  session, at a polite pace (small delay between requests). It does not store or transmit
  your credentials anywhere; everything runs locally in the browser.
