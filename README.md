# TCG Trade-In Sheet

Chrome extension that turns TCGplayer latest-sales data into a spreadsheet you can take
to a trade-in counter. Pick a printing and grade on any product page, and it averages the
last 5 matching sales, converts to CAD, and collects the row. Export as CSV, or copy
tab-separated straight into Google Sheets.

## Install

1. `chrome://extensions`, turn on Developer mode.
2. Load unpacked, pick this folder.
3. Sign in to TCGplayer. Signed out, the sales endpoint truncates every response to 5 rows.

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
- Rows older than 60 days get flagged in the drawer, and are still exported.
- If the exchange-rate fetch fails, `cad` is left empty. Never 0, never 1.0, never a
  hardcoded rate.

## Exported columns

`name, set, number, printing, condition, avg_usd, cad, qty`

Sample count, staleness, exchange rate, and source URL are stored per row but stay out of
the spreadsheet.

## Collection

Rows are keyed by product, printing, condition, and language, so the same card in two
languages does not collide. Re-adding a row overwrites it with a fresh pull and keeps the
qty you typed.

## Tests

```
node test.js
```

No framework, no network. The fixture is shaped from a live `latestsales` response and
covers the matching rules, the average, paging and the 10-page cap, the exchange-rate
failure path, and the overwrite behaviour.
