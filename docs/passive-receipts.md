# Passive AMZ source capture and reusable imports

## Plan and implementation

1. Parse only the current order-detail DOM. Standard orders use semantic
   `data-component` markers; Whole Foods uses the item-list and charge-summary widgets;
   Fresh uses the full preloaded item table and charge breakdown. Never fetch, click,
   navigate, or intercept broad network traffic. History pages mount the collection UI.
2. Normalize a small, allowlisted receipt schema. Preserve source labels and printed dates,
   integer cents, counted/weighted quantities, missing values, and warnings. Do not infer
   a ledger account, transaction date, tax treatment, or reconciliation decision.
3. Save revisions in the background, serialized across tabs. Hash only stable source bytes;
   observation time and upload status stay outside the hash. Exact repeats are no-ops.
4. Make uploads opt-in in the extension's own settings, with optional destination permission.
   Pin the recipient when connecting, keep source receipts during outages, serialize sync,
   and pause on authentication failure or account change. Rate limiting uses automatic
   backoff. A lost receipt acknowledgement is safe to retry because intake
   deduplicates by recipient and SHA-256. Previously pinned sources remain with that recipient.
5. Reuse the public multipart job API for explicitly selected statements and other supported
   documents. Upload is source intake; parsing and review belong to the destination.

## Public browser API client

The client uses the public HTTPS origin `https://pfifi.com`. Requests include browser-managed
credentials, reject redirects, and have a 30-second timeout. Credentials and CSRF tokens
never pass through AMZ content scripts. No identity-provider permissions are needed.

`GET /api/finance/browser-import/session` returns `{user_id, user_name, csrf_token}` for the signed-in
owner. The response must not be cached. Receipt uploads require that owner's document-import
permission and refuse a shared finance subject.

`POST /api/finance/browser-import/receipts` accepts multipart `file` (JSON, at most 512 KiB),
`sha256` (lowercase hex digest of exact file bytes), and `expected_user_id`. Send the CSRF
token as `X-CSRF-TOKEN`. Responses contain `{document_id, duplicate, status:"received"}`.
Repeated identical bytes return the original document id; changed bytes create a new source.
The server checks the expected user against the authenticated request before writing.

The extension drains its receipt queue with `POST /api/finance/browser-import/receipts/batch`:
multipart `files[]`, matching `sha256[]`, and `expected_user_id`. A batch holds 1–20 sources,
each at most 512 KiB. The response's `results` contain each source's `sha256`, `document_id`,
`duplicate`, and `status`. Acknowledgements are checked against every expected hash before
local completion is recorded. Every source validates before the first write. Storage failure
may retain earlier source documents; a whole-batch retry safely deduplicates those bytes.

Batches are spaced by at least five seconds. HTTP 429 keeps the batch queued and imports
enabled. Both delta-seconds and HTTP-date `Retry-After` values are honored; the delay is at
least the larger of that value and exponentially increasing backoff (30 seconds initially,
up to one hour), plus upward jitter. Receipt retry deadlines persist across restart and
cannot be bypassed by pausing/reconnecting. Alarms and timers recheck the deadline before
requesting a session or sending bytes. Pause immediately prevents starting another batch,
including after a restart; the batch already in flight may complete.

The receipt wire schema is defined by `FSD.amz.receiptSchema` in `core/runtime.js`:

- `marketplace`, `currency`, `order_id`, `layout`, canonical `source_url`;
- nullable `order_date_text`, `status_text`, and `delivery_date_text` as printed;
- `items`: title, nullable ASIN and canonical product URL, numeric/null quantity,
  nullable quantity unit (`each`, `lb`, `oz`), nullable unit/line prices in integer cents,
  nullable seller and condition;
- `charges`: source label and integer-cent amount, including discounts/refunds;
- nullable integer-cent `total_cents` and a list of `warnings`.

The complete allowed fields are implemented in `core/import-store.js`. Unsupported fields
are discarded locally and rejected by intake. Source metadata is untrusted receipt evidence.
The client does not execute markup from it or embed its URLs as privileged requests.

For explicit file uploads, `POST /api/genai/import/jobs` takes multipart `file`, `job_type`,
and `expected_user_id`, with the same session/CSRF protection. Supported client job types:
`finance_transactions`, `finance_payslip`, `utility_bill`, `equity_award`. The server validates
the expected user and returns `{job_id,status}`. The extension never applies job results.
This endpoint does not deduplicate pending jobs. Only HTTP 429 automatically retries, after
`Retry-After` and increasing backoff, while imports remain enabled for the pinned account.
An uncertain network acknowledgement is not automatically retried: check Import Center
before uploading again.

## Verification and limits

Synthetic DOM fixtures cover standard, Whole Foods, and Fresh layouts; products without
links; weighted grocery quantities; hidden preloaded tables; duplicate accessibility price
text; partial pages; and order-identity transitions. Storage/client/message tests cover
concurrent captures, deduplication, revisions, recipient pinning, refusal, restart, CSRF,
multipart uploads, sender boundaries, optional permissions, batch hash association, persisted
429 deadlines, automatic backoff, immediate pause, and actual provider/batch download completion.
Private browsing is excluded.

Saved-page validation checks item counts against each layout's source item containers. It
does not prove future AMZ layouts will remain stable or that all historical orders have
been visited. No live navigation or authenticated purchase-account requests are part of tests.

Gift-card balance/activity pages now use the same background queue. Their individual
JSON sources use `FSD.amz.giftCardSchema` from the shared runtime configuration and upload to
`POST /api/finance/browser-import/gift-card-snapshots/batch`, using the same indexed
`files[]`, `sha256[]`, expected-user, CSRF, batch limit, and hash-associated result contract.
The singular `/api/finance/browser-import/gift-card-snapshots` endpoint also accepts one
`file`, `sha256`, and `expected_user_id`. Each batch contains one source kind; the scheduler
drains both kinds with shared rate-limit backoff and recipient/pause controls.

Gift-card sources contain the reported current balance, typed activity cells, linked order
IDs, and observed pagination flags. Only `coverage: "visible_page"` is supported. Raw
descriptions, claim codes, account credentials, and pagination cursors are discarded before
storage. There is no invented activity identifier or deduplication of indistinguishable
rows. First-observed time is local capture metadata; remote document creation time is
intake time, not a statement that a balance was observed at that exact time.

The archive export now uses `fsd.source-archive.v1`, with separate `receipts` and
`gift_card_snapshots` arrays. Each entry is an individual supported source. Split an array
into individual JSON files before staging for its corresponding API/MCP import. Source
evidence is independent of a bank transaction or wallet ledger.

Future adapters can supply sources to the same background import client. Directly uploading
every institution's automatic downloads is deferred: a source type, target account, and
successful-download acknowledgement need to be established for each provider. Returns and
refunds remain the printed source evidence; no automatic transaction matching is performed.

### Queue recovery and partial sources

An indexed HTTP 422 validation response quarantines only the identified source as Refused, preserving its reason. Remaining sources continue in later spaced batches. Network failures, timeouts, 5xx responses, and ambiguous source acknowledgements retry with durable backoff; exact-byte source identity makes a retry safe. Authentication (401/419), permission (403), account change (409), and revoked destination access stop sending until resolved. Retry-After and retry deadlines cannot be bypassed by Sync now or reconnecting.

Sources with warnings wait 60 seconds from first capture before sending as partial evidence. A complete receipt observed within that wait suppresses the older unsent partial upload without deleting its local evidence. Gift-card partials require matching page evidence before suppression so visiting a different activity page cannot hide an incomplete observation.

Settings show the destination full name (falling back to its number), queue counts, one prioritized state, and the next action. A mismatched account on Resume requires an explicit recipient choice; previously pinned sources never move. Pause is acknowledged immediately, can show Pausing while the in-flight batch completes, and prevents new batches across restart.
