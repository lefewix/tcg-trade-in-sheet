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
- A sale dated in the future (beyond a day of clock skew) or more than ten years ago is
  dropped the same way. The window is the five most recent, so one row dated next year
  would otherwise sort to the top and simply *be* the price.
- Rows older than 60 days, and rows averaged from fewer than 3 sales, are flagged in the
  drawer and counted on the printed sheet. Both are still exported.
- If the exchange-rate fetch fails on a new row, `cad` is left empty. Never 0, never 1.0,
  never a hardcoded rate. On a refresh of a row that already had a rate, the row keeps its
  last known rate and re-prices at it rather than losing its CAD price; the drawer says so
  and Refresh prices reports the run as partial.

## Exchange rate

`open.er-api.com` first, `api.frankfurter.dev` as a fallback, and the winning rate is
cached in `chrome.storage.local` for 12 hours - a module-level variable is a cache that
never survives MV3's idle shutdown to be used. Frankfurter is ECB data, published on
weekdays only, so a weekend rate can legitimately be up to three days old: the rate's own
`date` is carried and displayed, not just the moment it was fetched.

## Exported columns

`name, set, number, printing, condition, avg_usd, cad, qty, samples, oldest, pct,
trade_cad, trade_total`

`cad` is the market price. `pct` is the trade-in percent applied to that row (its own
override, else the house rate), `trade_cad` is what you pay for one copy, and
`trade_total` is that unit **as rounded** times `qty`. Both numbers ship, explicitly
labelled - a sheet carrying only market price gets quoted at market price.

The unit is rounded to the cent once and every total is built from the rounded figure, so
`trade_cad x qty` always equals `trade_total` exactly, on the CSV, the clipboard and the
printed sheet alike.

`samples` and `oldest` are how far to trust the price: a $400 card off one sale from
months ago must not read identically to one backed by five recent sales. Language,
staleness flag, exchange rate and source URL are stored per row but stay out of the
spreadsheet.

Card names come from marketplace listings, so a cell that looks like a formula -
`=HYPERLINK(...)`, `@SUM(...)`, `+1+1`, `-2+3`, a leading tab - is prefixed with an
apostrophe on both the CSV and the clipboard path. The test is what follows the leading
character, not the character itself: `+2 Mace`, `-1/-1 Counter` and `@Ninja` are real
cards and go out untouched.

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
deleted row is a no-op and does not disturb the live undo. When an undo is therefore only
partial it says so ("Restored 11 rows - 1 left as it was") rather than dropping that row's
qty and percent in silence.

Refresh prices re-pulls every collected row at today's rate, keeping qty, per-row percent
and drawer order. It streams its position while it runs, the button doubles as a cancel,
and any row it could not re-pull is flagged in the drawer by name. A row deleted while the
refresh is running stays deleted.

## Trade-in percent

The drawer carries a house rate that every row follows, and any row can override it with
its own percent. The override drives that row's CAD, the trade-in total, the CSV and
clipboard trade columns, and the printable sheet. `0%` means zero in both boxes.

The default is 100%, which is market price - so until the house rate has been set once on
this machine, the drawer says so and Print sheet is refused. A fresh install must not be
able to hand a customer a document offering them full retail.

## Print sheet

Print sheet opens a plain, customer-facing table - card, set, printing, condition, qty,
percent, unit CAD, line total, and the grand total - in a new tab, ready to print. Under
it, the basis for every number on the page: the house rate applied, the exchange rate or
rates used with their own dates, the date range of the sales behind the prices, and how
many lines are thin (fewer than 3 sales) or stale (over 60 days). Rows persist across
days, each with its own rate, so a sheet built over a week says which rates its total
spans. No dependencies: the document is generated in place.

## Tests

```
node test.js
```

No framework, no network. The fixtures are shaped from a live `latestsales` response and
cover the matching rules, the average, paging and the 10-page cap, the exchange-rate
failure and fallback paths, the overwrite behaviour, serialized concurrent writes, qty
increments, refresh-all, and the drawer sort order.

The content script's money arithmetic and its printed document are pure and exported, so
the customer-facing sheet is held to the same standard as the CSV: every line total is
checked against its own rounded unit, and against the footer.

One fixture is deliberately eight sales in scrambled date order: it pins the rule that the
average is the five MOST RECENT matching sales, and it fails if the recency sort or the
five-sample cap is broken. The rest of the suite does not, which is why it is there.
