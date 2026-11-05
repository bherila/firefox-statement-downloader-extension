# Passive receipt capture and reusable imports

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
   and pause on refusal. A lost receipt acknowledgement is safe to retry because intake
   deduplicates by recipient and SHA-256. Previously pinned sources remain with that recipient.
5. Reuse the public multipart job API for explicitly selected statements and other supported
   documents. Upload is source intake; parsing and review belong to the destination.

## Public browser API client

The client uses the public HTTPS origin `https://pfifi.com`. Requests include browser-managed
credentials, reject redirects, and have a 30-second timeout. Credentials and CSRF tokens
never pass through Amazon content scripts. No identity-provider permissions are needed.

`GET /api/finance/browser-import/session` returns `{user_id, csrf_token}` for the signed-in
owner. The response must not be cached. Receipt uploads require that owner's document-import
permission and refuse a shared finance subject.

`POST /api/finance/browser-import/receipts` accepts multipart `file` (JSON, at most 512 KiB),
`sha256` (lowercase hex digest of exact file bytes), and `expected_user_id`. Send the CSRF
token as `X-CSRF-TOKEN`. Responses contain `{document_id, duplicate, status:"received"}`.
Repeated identical bytes return the original document id; changed bytes create a new source.
The server checks the expected user against the authenticated request before writing.

Receipt schema `amazon.receipt.v1`:

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
This endpoint does not deduplicate pending jobs, so files are sent once with no automatic retry.
If acknowledgement is lost, check Import Center before uploading again.

## Verification and limits

Synthetic DOM fixtures cover standard, Whole Foods, and Fresh layouts; products without
links; weighted grocery quantities; hidden preloaded tables; duplicate accessibility price
text; partial pages; and order-identity transitions. Storage/client/message tests cover
concurrent captures, deduplication, revisions, recipient pinning, refusal, restart, CSRF,
multipart uploads, sender boundaries, and optional permissions. Private browsing is excluded.

Saved-page validation checks item counts against each layout's source item containers. It
does not prove future Amazon layouts will remain stable or that all historical orders have
been visited. No live navigation or authenticated purchase-account requests are part of tests.

Future adapters can supply sources to the same background import client. Directly uploading
every institution's automatic downloads is deferred: a source type, target account, and
successful-download acknowledgement need to be established for each provider. Returns and
refunds remain the printed source evidence; no automatic transaction matching is performed.
