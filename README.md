# TCG Trade-In Sheet

Chrome extension that turns TCGplayer latest-sales data into a spreadsheet you can take
to a trade-in counter. Pick a printing and grade on any product page, and it averages the
last 5 matching sales, converts to CAD, and collects the row. Export as CSV, or copy
tab-separated straight into Google Sheets.

## Install

1. `chrome://extensions`, turn on Developer mode.
2. Load unpacked, pick this folder.
3. Sign in to TCGplayer. Signed out, the sales endpoint truncates every response to 5 rows.
   The panel warns when a response has that shape, but still shows the chips: a product
   with only a handful of lifetime sales looks the same from the outside.

## What it does

On a product page the panel lists every printing found in recent sales, with all five
grades under each one. Click a grade and the service worker pages the
`/v2/product/{id}/latestsales` endpoint until it has 5 matching sales, or runs out.

A sale counts as matching only when the condition, printing, and language all equal what
you picked, and the listing type is `ListingWithoutPhotos`. That last check is what keeps
listings with extra text under the condition out of the average.

## Rules the average follows

- Plain arithmetic mean of `purchasePrice` across the 5 most recent matching sales. Not
  median, not trimmed, not weighted.
- Shipping is excluded.
- A sale of quantity 3 is one sample, not three. The `qty` column is a separate thing:
  how many copies you are trading in.
- A sale whose `purchasePrice` is not a real number, or whose `orderDate` will not parse,
  is dropped before the average. It is never coerced - a null price silently becoming
  `0.00` is worse than no row at all.
- Rows older than 60 days get flagged in the drawer, and are still exported.
- If the exchange-rate fetch fails on a new row, `cad` is left empty. Never 0, never 1.0,
  never a hardcoded rate. On a refresh of a row that already had a rate, the row keeps its
  last known rate and re-prices at it rather than losing its CAD price; the drawer says so
  and Refresh prices reports the run as partial.

## Exported columns

`name, set, number, printing, condition, avg_usd, cad, qty, pct, trade_cad, trade_total`

`cad` is the market price. `pct` is the trade-in percent applied to that row (its own
override, else the house rate), `trade_cad` is what you pay for one copy, and
`trade_total` is that times `qty`. Both numbers ship, explicitly labelled - a sheet
carrying only market price gets quoted at market price.

Sample count, staleness, exchange rate, and source URL are stored per row but stay out of
the spreadsheet.

Card names come from marketplace listings, so any cell starting with `=`, `+`, `-` or `@`
is prefixed with an apostrophe on both the CSV and the clipboard path. It stays readable
text and does not execute as a formula in Sheets, Excel or LibreOffice.

## Collection

Rows are keyed by product, printing, condition, and language, so the same card in two
languages does not collide. Clicking a grade you already collected re-pulls the price and
adds a copy; shift-click re-pulls the price and leaves the count alone. The drawer lists
newest first and flashes the row it just touched.

Every store write goes through one promise chain in the service worker, so two grades
clicked a beat apart cannot overwrite each other.

Clear and per-row delete both offer an undo for five seconds. Undo only ever adds back the
rows that action removed, and only where nothing has taken their place since - collect a
card during the five seconds and undo leaves it alone. A second click on an already
deleted row is a no-op and does not disturb the live undo.

Refresh prices re-pulls every collected row at today's rate, keeping qty, per-row percent
and drawer order. A row deleted while the refresh is running stays deleted.

## Trade-in percent

The drawer carries a house rate that every row follows, and any row can override it with
its own percent. The override drives that row's CAD, the trade-in total, the CSV and
clipboard trade columns, and the printable sheet. `0%` means zero in both boxes.

## Print sheet

Print sheet opens a plain, customer-facing table - card, set, printing, condition, qty,
unit CAD, line total, and the grand total - in a new tab, ready to print. No dependencies:
the document is generated in place.

## Tests

```
node test.js
```

No framework, no network. The fixtures are shaped from a live `latestsales` response and
cover the matching rules, the average, paging and the 10-page cap, the exchange-rate
failure path, the overwrite behaviour, serialized concurrent writes, qty increments,
refresh-all, and the drawer sort order.

One fixture is deliberately eight sales in scrambled date order: it pins the rule that the
average is the five MOST RECENT matching sales, and it fails if the recency sort or the
five-sample cap is broken. The rest of the suite does not, which is why it is there.
