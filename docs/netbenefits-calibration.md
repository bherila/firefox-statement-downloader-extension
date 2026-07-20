# Fidelity NetBenefits — calibration notes

Findings from a manual HAR capture of a signed-in NetBenefits session. Recorded
here because they were expensive to obtain: NetBenefits blocks automated
browsers, so this could not be explored the way the other providers were.

## Why this provider is different

Retail Fidelity and Wealthfront both serve an *archive* — a finite set of
documents to enumerate and fetch. NetBenefits serves a **generator**: no
statement exists until it is requested for a date range. So the design question
is not "how do we enumerate everything?" but "which periods do we generate?".

Retention is **ten years minus one day, to the day**, and it rolls. Anything not
generated becomes unrecoverable one day at a time, which argues for backfilling
early and re-running periodically.

## Origin and plan identity

Everything lives on `workplaceservices.fidelity.com`. Each plan is identified by
a client/plan pair, and both known plans use the identical flow:

| Plan | Client | Employer | Status |
| --- | --- | --- | --- |
| `50001` | `000000001` | Example Employer | active |
| `50002` | `000000002` | Former Employer | former |

Both appear in the retail account list as WPS accounts but the retail document
APIs return no documents for them, which is why they need their own provider.

## Statements — "SOD" (Statement on Demand)

```
POST /mybenefits/savings2/sod/soddetail
  txntoken=<CSRF>
  sodReqIndicator=HACK
  dateRange=MM/DD/YYYY-MM/DD/YYYY
  ytdDateRange=MM/DD/YYYY-MM/DD/YYYY
  sodPreview=N
  consentReq=N
→ text/html (~41 KB)
```

The page form also carries `beginDateLid`, `endDateLid`, `sodClientId`,
`sodPlan` as inputs. `txntoken` is a CSRF value that must be read from the live
DOM rather than cached; its lifetime is unknown.

The response is **HTML, not PDF** — no `application/pdf` appears anywhere in the
capture. The balance chart is a *separate* request:

```
GET /mybenefits/savings2/sod/chart?dateRange=MM/DD/YYYY-MM/DD/YYYY&id=<epoch-ms>
→ image/gif
```

so saving the HTML alone yields a statement with a broken image. Inline the
chart as a `data:` URI to make each file self-contained.

## Transactions

```
POST /mybenefits/savings2/transactionhistory/download
  txntoken=<CSRF>
  timeSelection=custom_date_range
  fromDate=MM/DD/YYYY&toDate=MM/DD/YYYY
  fileFormatSelection=csv_format | qif_format
→ application/csv | application/qif
```

**Use CSV, not QIF.** For an identical range the CSV returned 11 transactions
and the QIF only 6: QIF emits investment buys alone, silently dropping transfers
and revenue credits and collapsing types into `Buy`. QIF's only unique data is
the ticker symbol and an explicit per-unit price, and the price is derivable
from the CSV's amount and share count. Losing an implied ticker is a far smaller
cost than losing 45% of the transactions.

CSV also carries a plan-name and date-range header that QIF omits.

## Submitting requests

Submit through the page's own form targeting a hidden same-origin iframe, via
`form.requestSubmit()` — not `fetch()`.

Every legitimate submission on this server-rendered app is a navigation. A
`fetch()` POST is distinguishable by its request metadata (`Sec-Fetch-Mode:
cors`, XHR-style `Accept`, no navigation context), and a long run of those to
`/sod/soddetail` is anomalous traffic. Form submission into an iframe produces
the request the browser would make anyway, while keeping the page in place and
avoiding the fragility of driving date pickers across hundreds of iterations.

Re-read `txntoken` from the DOM between submissions rather than caching it, so
token rotation cannot silently break a long run.

## Automation posture

A WebDriver BiDi session sets `navigator.webdriver = true`, and NetBenefits
blocks on it — the retail document center does not. This is why the calibration
above came from a manually captured HAR. Do not attempt to suppress that flag;
if NetBenefits rejects the extension's traffic, that is an answer, not an
obstacle to work around.

## Product decisions

- **Periods**: user selects Monthly, Quarterly, or Annual.
- **Format**: HTML with the chart inlined as a `data:` URI.
- **Transactions**: CSV only, per year, alongside statements.
