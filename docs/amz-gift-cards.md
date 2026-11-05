# Passive AMZ gift-card balance and activity capture

The gift-card provider reads the current US balance page at `/gc/balance` or
`/gp/css/gc/balance`. It makes no requests, clicks no links, and does not change the
balance, redeem a card, reload funds, or navigate history. Users browse Previous and
Next themselves; each loaded page becomes a source snapshot.

The wire schema from `FSD.amz.giftCardSchema` in `core/runtime.js` preserves the displayed integer-cent balance,
printed activity dates, normalized activity types, signed integer-cent activity amounts,
per-row closing balances, linked order IDs, and observed Previous/Next availability.
`coverage: "visible_page"` explicitly limits each source to the loaded page. Repeated
indistinguishable rows remain repeated; no transaction IDs are invented.

Raw descriptions are deliberately excluded because balance-page load descriptions can
contain redeemable gift-card claim codes. Only a normalized type (`redemption`, `load`,
`refund`, `adjustment`, or `unknown`) is retained. Claim codes, arbitrary descriptions,
addresses, credentials, images, pagination cursors, and request metadata are excluded.
Unknown activity types remain valid unreviewed evidence. Malformed numeric/date rows
produce `unparsed_activity_rows`, so an incomplete snapshot can stay local for review.
Missing balances and unrecognized table layouts do not produce a snapshot.

The provider uses the shared local source queue through `captureAmzGiftCardSnapshot`
and `listAmzGiftCardSnapshots`. The drawer exports JSON through the normal batch
download contract. The source payload has no generated timestamp; first-observed time
belongs to the capture envelope, preventing repeated DOM observations from generating
new payload hashes merely because time passed.

These are source observations, not a gift-card ledger or a claim that a merchant account
has been reconciled. A complete history, overlapping pages, split payments, refunds,
individual-card balances, and expiration terms need their own reviewed workflows.
