"use strict";

// TCG Sales CSV - service worker.
//
// ALL network I/O lives here. The content script never fetches: the product page's
// CSP and MV3's content-script CORS rules make page-side fetches unreliable.
//
// Cookie path in use: fetch(..., credentials: "include") straight from this worker.
// Chrome attaches tcgplayer.com session cookies to extension-initiated requests when
// the host is in host_permissions. If that ever stops holding, every response comes
// back logged-out-shaped and looksLoggedOut() below catches it.

const API = "https://mpapi.tcgplayer.com/v2/product";

const PAGE_SIZE = 25;   // server cap; a larger `limit` is ignored
const MAX_PAGES = 10;   // a rare condition on a busy product must not spin forever
const SAMPLES = 5;
const STALE_DAYS = 60;
const LOW_SAMPLES = 3;  // fewer than this and the price is one or two sales' opinion
const STORE_KEY = "rows";
const PCT_KEY = "pct";
const SAVED_KEY = "saved";   // name -> { rows, at, count }: whole buylists, snapshotted
const DEFAULT_PCT = 100;

// Exported columns. Everything else a stored row carries is underscore-prefixed and
// stays out of the spreadsheet (language, staleness flag, source URL, timestamp).
const COLUMNS = ["name", "set", "number", "printing", "condition", "avg_usd", "cad", "qty"];

// How much to trust the row. A $400 card priced off ONE sale from months ago must not
// print identically to one backed by five recent sales, so the confidence signals the
// worker already collects ship with the numbers instead of dying in the store.
//   samples - how many sales went into avg_usd (fewer than 3 is thin)
//   oldest  - date of the oldest sale in that average
const TRUST_COLUMNS = ["samples", "oldest"];

// What actually leaves the extension. `cad` is market price; the three trade columns are
// what you would pay. Both numbers ship, explicitly labelled, because a sheet carrying
// only market price gets quoted at market price and the whole margin walks out the door.
//   pct         - the percent applied to this row (its override, else the house rate)
//   trade_cad   - market cad * pct/100, one copy, ROUNDED TO THE CENT
//   trade_total - that rounded unit * qty
const TRADE_COLUMNS = ["pct", "trade_cad", "trade_total"];
const EXPORT_COLUMNS = COLUMNS.concat(TRUST_COLUMNS, TRADE_COLUMNS);

// ---------------------------------------------------------------- sales API

// The page's own condition dropdown drives this filter server-side. Sending it means
// a rare condition comes back on page 1 instead of hiding 200 rows deep, which is the
// difference between finding 5 samples and hitting the 10-page cap.
//
// It is an OPTIMISATION ONLY. matchesSelection() below is still the authority on every
// row, so a filter the server ignores or applies loosely cannot corrupt anything - it
// just means more paging. If the endpoint rejects string conditions the way `variants`
// does, the first 400 turns it off for the rest of the worker session.
let serverConditionFilter = true;

async function fetchSalesPage(productId, offset, conditions) {
  const useFilter = serverConditionFilter && conditions && conditions.length > 0;
  const res = await fetch(`${API}/${productId}/latestsales`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conditions: useFilter ? conditions : [],
      languages: [],
      // Always empty: `variants` wants numeric IDs and 400s on strings. Printing is
      // filtered client-side in matchesSelection().
      variants: [],
      listingType: "All",
      limit: PAGE_SIZE,
      offset
    })
  });
  if (res.status === 400 && useFilter) {
    serverConditionFilter = false;
    return fetchSalesPage(productId, offset, null);
  }
  if (!res.ok) throw new Error(`latestsales ${res.status}`);
  return res.json();
}

// Logged out, the endpoint silently caps at EXACTLY 5 rows and ignores paging. That is a
// signature, not a threshold: a product with 3 lifetime sales also reports no next page,
// and calling that "signed out" hard-blocks the panel with a wrong explanation.
//
// So the test is the truncation shape - totalResults pinned at the cap, a full page of 5
// delivered, no next page. Anything under 5 is a genuinely quiet product. Even a true hit
// is only a suspicion (a product with exactly 5 sales looks identical), so the caller
// still renders the chips and merely says so.
const PAGE_CAP_LOGGED_OUT = 5;

function looksLoggedOut(page) {
  const n = (page.data || []).length;
  return page.totalResults === PAGE_CAP_LOGGED_OUT &&
         n >= PAGE_CAP_LOGGED_OUT &&
         page.nextPage !== "Yes";
}

// Exact match on typed fields. The listingType check IS the "ignore listings with
// extra text under the condition" rule - no blacklist, no fuzzy match, no parsing
// of display labels like "NM Holofoil".
function matchesSelection(row, sel) {
  return row.condition === sel.condition &&
         row.variant === sel.variant &&
         row.language === sel.language &&
         row.listingType === "ListingWithoutPhotos";
}

// ---------------------------------------------------------------- field guards
//
// The API's shape is not a promise. A null purchasePrice averages to NaN, a string one
// coerces to a plausible-looking number that is really garbage, and a malformed orderDate
// makes new Date(...).toISOString() throw a raw RangeError in the user's face. None of
// those may reach a price you quote at a counter, so a sale that cannot be read as a real
// number and a real date is dropped before it ever enters the average.
const NUMERIC = /^-?\d+(\.\d+)?$/;

// number, or a string that is entirely a number. NOT Number(x): Number(null) is 0 and
// Number("") is 0, which is exactly the plausible fake this guard exists to stop.
function salePrice(row) {
  const v = row && row.purchasePrice;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === "string" && NUMERIC.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

// A parseable date is not a plausible one. The window is sorted newest-first and cut at
// five, so ONE row dated next year sorts to the top and IS the price - a single garbage
// timestamp turned a $10.00 average into $2007.80 with no staleness flag, because the
// row it displaced was never in the window to be judged. A sale that has not happened
// yet, or that predates the hobby, is as unusable as a null price.
const FUTURE_SKEW_MS = 86400000;            // 1 day: timezone and clock skew, nothing more
const MAX_AGE_MS = 3650 * 86400000;         // ~10 years

function saleTime(row, now) {
  const v = row && row.orderDate;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  now = now || Date.now();
  if (t > now + FUTURE_SKEW_MS) return null;
  if (t < now - MAX_AGE_MS) return null;
  return t;
}

function isUsableSale(row, now) {
  return salePrice(row) !== null && saleTime(row, now) !== null;
}

async function collectSales(productId, sel, fetchPage) {
  fetchPage = fetchPage || fetchSalesPage;
  const matched = [];
  let rejected = 0, invalid = 0, offset = 0, pages = 0, capped = false;

  for (;;) {
    const page = await fetchPage(productId, offset, [sel.condition]);
    pages++;
    for (const row of page.data || []) {
      if (!matchesSelection(row, sel)) { rejected++; continue; }
      // matched the selection but the numbers are unreadable: counted apart from
      // `rejected` so the message can say which of the two happened.
      if (!isUsableSale(row)) { invalid++; continue; }
      matched.push(row);
    }
    if (matched.length >= SAMPLES) break;
    if (page.nextPage !== "Yes") break;
    if (pages >= MAX_PAGES) { capped = true; break; }
    offset += PAGE_SIZE;
  }

  return { matched, rejected, invalid, pages, capped };
}

// ---------------------------------------------------------------- FX
//
// This tool hands somebody a price in CAD, so a single point of failure in the currency
// conversion means a customer at the counter and a blank column. Two providers, tried in
// order, and the winner is persisted - MV3 kills the worker after ~30s idle, so a
// module-level variable was a cache that never survived to be used.
//
// `date` is the rate's OWN date, not when we fetched it. Frankfurter is ECB data,
// published on weekdays only, so a Sunday fetch legitimately returns Friday's rate. The
// difference matters when somebody asks what a sheet was priced at.
const FX_KEY = "fx";
const FX_TTL_MS = 12 * 3600 * 1000;

function isoDay(t) {
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

const FX_PROVIDERS = [
  {
    src: "er-api",
    url: "https://open.er-api.com/v6/latest/USD",
    read: j => ({
      rate: j && j.rates && j.rates.CAD,
      date: j && j.time_last_update_utc ? isoDay(Date.parse(j.time_last_update_utc)) : ""
    })
  },
  {
    src: "frankfurter",
    url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD",
    read: j => ({ rate: j && j.rates && j.rates.CAD, date: (j && j.date) || "" })
  }
];

// No module-level memo on purpose: chrome.storage.local IS the cache, so a worker that
// was just restarted reads the same rate the previous one fetched instead of hitting the
// network again (or, when both providers are down, handing back a blank).
async function readFxCache() {
  try {
    const got = await chrome.storage.local.get(FX_KEY);
    const c = got[FX_KEY];
    return c && typeof c.rate === "number" && c.rate > 0 ? c : null;
  } catch (e) {
    return null;
  }
}

async function getFx(now) {
  now = now || Date.now();
  const cached = await readFxCache();
  if (cached && now - Date.parse(cached.at) < FX_TTL_MS) return cached;

  for (const p of FX_PROVIDERS) {
    try {
      const res = await fetch(p.url);
      const json = await res.json();
      const got = p.read(json);
      if (typeof got.rate !== "number" || !Number.isFinite(got.rate) || got.rate <= 0) {
        throw new Error("no CAD rate");
      }
      const fx = {
        rate: got.rate,
        at: new Date(now).toISOString(),
        date: got.date || isoDay(now),
        src: p.src
      };
      try { await chrome.storage.local.set({ [FX_KEY]: fx }); } catch (e) { /* non-fatal */ }
      return fx;
    } catch (e) { /* fall through to the next provider */ }
  }

  // Everything down. A cache past its TTL is still a real rate somebody once fetched, and
  // it ships with its own date so the sheet can say how old it is - that beats a blank
  // column at a counter. With nothing cached at all, cad stays an empty string:
  // never 0, never 1.0, never a hardcoded rate.
  if (cached) return Object.assign({}, cached, { expired: true });
  return { rate: null, at: "", date: "", src: "" };
}

// ---------------------------------------------------------------- row build

// The set and number are the ONLY DOM-derived data in the extension (scrapePageMeta in
// content.js), and the heuristics there fail SILENTLY: a redesigned breadcrumb hands back
// an empty set, a moved details block an empty or garbled number, and the wrong text ends
// up on a customer-facing sheet with nothing flagging it. A plausible card number is one
// unbroken token ("223/197", "13", "SV045"); anything with spaces - or an empty set -
// marks the row so the drawer can say "check the set and number" instead of exporting a
// guess. Underscore-prefixed, so the flag itself stays out of the spreadsheet.
const NUMBER_SHAPE = /^\S+$/;

function metaLooksWrong(meta) {
  const set = meta && typeof meta.set === "string" ? meta.set.trim() : "";
  const number = meta && typeof meta.number === "string" ? meta.number.trim() : "";
  return !set || !NUMBER_SHAPE.test(number);
}

function buildRow(meta, sel, matched, fx, now) {
  now = now || Date.now();

  // Unreadable rows are dropped here as well as in collectSales, so a caller that hands
  // buildRow a raw array cannot produce a NaN price either.
  const used = matched
    .filter(r => isUsableSale(r, now))
    .sort((a, b) => saleTime(b, now) - saleTime(a, now))   // newest first
    .slice(0, SAMPLES);                                    // ...so this keeps the MOST RECENT 5

  if (!used.length) {
    throw new Error("no sale had a readable purchase price and order date");
  }

  // BUSINESS RULES - do not "improve" these:
  //   1. sale-row quantity is IGNORED. A quantity-3 sale is ONE sample, not three.
  //      (The `qty` column is a different thing: how many copies YOU are trading in.)
  //   2. shippingPrice is EXCLUDED. The average is purchasePrice only.
  //   3. the samples are the 5 MOST RECENT matching sales - hence the sort above.
  // Plain arithmetic mean. Not median, not trimmed, not weighted.
  const avg = used.reduce((sum, r) => sum + salePrice(r), 0) / used.length;

  // Sorted descending, so the last one is the oldest. UTC from the API - never the
  // UI's localized display, which disagrees by up to a day.
  const oldestAt = saleTime(used[used.length - 1], now);
  const ageDays = (now - oldestAt) / 86400000;

  const rate = fx && typeof fx.rate === "number" ? fx.rate : null;

  return {
    _meta_warn: metaLooksWrong(meta),
    name: meta.name,
    set: meta.set,
    number: meta.number,
    printing: sel.variant,
    condition: sel.condition,
    avg_usd: avg.toFixed(2),   // plain numbers, no "$", no separators
    cad: rate === null ? "" : (avg * rate).toFixed(2),
    qty: 1,
    _samples: used.length,
    _language: sel.language,
    _oldest: new Date(oldestAt).toISOString().slice(0, 10),
    _stale: ageDays > STALE_DAYS,
    _fx_rate: rate === null ? "" : rate.toFixed(4),
    _fx_at: rate === null ? "" : fx.at,
    _fx_date: rate === null ? "" : (fx.date || ""),
    _fx_src: rate === null ? "" : (fx.src || ""),
    _url: meta.url
  };
}

// ---------------------------------------------------------------- output

// A cell whose first character is one of = + - @ is a FORMULA to Excel, Sheets and
// LibreOffice - it executes on open, and card names are attacker-supplied text from a
// marketplace listing. A leading apostrophe forces it back to text in every one of them.
//
// But `+`, `-` and `@` also START REAL CARD NAMES: "+2 Mace", "-1/-1 Counter", "@Ninja".
// Prefixing those corrupted the name on every path out of the tool - the CSV, the
// clipboard, and back again through any spreadsheet the shop keeps. So the leading
// character alone is not the test; what follows it is.
//
// Neutralised:                        Left alone:
//   =anything                           +2 Mace
//   =HYPERLINK(..) @SUM(1,2)            -1/-1 Counter
//   +1+1  -2+3  +A1*2                   @Ninja
//
// `=` and a leading tab/CR are unconditional: `=` never begins a card name, and the
// whitespace leads are stripped by some importers, re-exposing the character behind them.
const ALWAYS_RISKY = /^[=\t\r\n]/;

// sigil then an identifier then "(" - a function call: =HYPERLINK(, @SUM(, +IMPORTXML(
const FORMULA_CALL = /^[=+\-@][A-Za-z_][\w.]*\s*\(/;

// sigil then an expression made only of arithmetic and spreadsheet cell references:
// +1+1, -2+3, -(1+2), +A1*2, @AA10:B4. The one thing it cannot contain is an ordinary
// WORD, and a word is exactly what a card name starting with a sign always carries:
// "Mace", "Counter" and "Ninja" are not one-to-three letters followed by digits.
//
// The two branches are disjoint on their first character - the plain class has no letter
// and no `$`, a reference must start with one - so there is no ambiguity to backtrack
// through on a long hostile name.
const FORMULA_EXPR = /^[+\-@](?:[-+*/^%()0-9.,: ]|\$?[A-Za-z]{1,3}\$?\d+)*$/;

function looksLikeFormula(s) {
  return ALWAYS_RISKY.test(s) || FORMULA_CALL.test(s) || FORMULA_EXPR.test(s);
}

function neutralise(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return looksLikeFormula(s) ? "'" + s : s;
}

function csvCell(v) {
  const s = neutralise(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The clipboard path is not exempt: a name like "=IMPORTXML(...)" pasted into Sheets is
// live there too. Tabs and newlines would split the cell, so they collapse to a space.
function tsvCell(v) {
  return neutralise(v).replace(/[\t\r\n]+/g, " ");
}

// delim "," -> CSV file. delim "\t" -> clipboard text that pastes straight into
// Google Sheets / Excel cells with no import dialog.
function toDelimited(rows, delim, columns) {
  const cols = columns || COLUMNS;
  const esc = delim === "\t" ? tsvCell : csvCell;
  return [cols.map(esc).join(delim)]
    .concat(rows.map(r => cols.map(c => esc(r[c])).join(delim)))
    .join("\r\n");
}

// The percent a row is priced at: its own override when it has one, else the house rate.
// undefined means "no override"; 0 is a real answer and is honoured, exactly as the
// drawer honours it.
function rowPct(row, globalPct) {
  return row._pct === undefined || row._pct === null ? globalPct : row._pct;
}

// You cannot pay a fraction of a cent, so the unit price is rounded ONCE and every other
// number is built from the rounded figure. Rounding the unit for display while
// multiplying the raw one for the total is how a printed sheet stops adding up:
// 12.99 at 65% is 8.44 a copy, and three copies is 25.32, not the 25.33 that
// 8.4435 x 3 gives. A customer-facing document that fails its own arithmetic is
// the one thing this tool cannot do.
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Decorates stored rows with the trust and trade columns so the export carries the market
// price, the price you would actually pay, and how much the number is worth trusting.
// Empty (not 0) when FX is missing, matching how `cad` itself behaves.
function withTrade(rows, globalPct) {
  return rows.map(row => {
    const pct = rowPct(row, globalPct);
    const qty = Math.max(1, Math.round(Number(row.qty) || 1));
    const market = row.cad === "" || row.cad === undefined || row.cad === null
      ? null : Number(row.cad);
    const unit = market === null || !Number.isFinite(market)
      ? null : round2(market * pct / 100);
    return Object.assign({}, row, {
      samples: row._samples === undefined || row._samples === null
        ? "" : String(row._samples),
      oldest: row._oldest || "",
      pct: String(pct),
      trade_cad: unit === null ? "" : unit.toFixed(2),
      trade_total: unit === null ? "" : round2(unit * qty).toFixed(2)
    });
  });
}

// ---------------------------------------------------------------- storage

async function loadStore() {
  const got = await chrome.storage.local.get(STORE_KEY);
  return got[STORE_KEY] || {};
}

function saveStore(store) {
  return chrome.storage.local.set({ [STORE_KEY]: store });
}

// EVERY store mutation goes through here, and nothing else may call saveStore().
//
// Without this, two chips clicked a beat apart both run loadStore -> mutate -> saveStore
// against the same snapshot and the second write drops the first one's row. The mutations
// are queued on one promise chain, so each fn sees the store as the previous fn left it.
// A rejecting fn must not wedge the chain, hence the swallowed catch on `queue`.
let queue = Promise.resolve();

function withStore(fn) {
  const run = queue.then(async () => {
    const store = await loadStore();
    const out = await fn(store);
    await saveStore(store);
    return out;
  });
  queue = run.then(() => {}, () => {});
  return run;
}

// ---------------------------------------------------------------- saved buylists
//
// Snapshots, not references: a saved buylist is a deep copy of the rows as they were,
// so collecting or clearing afterwards cannot reach back into it. Loading is also a
// copy, so editing the loaded buylist does not silently rewrite the save.

async function loadSaved() {
  const got = await chrome.storage.local.get(SAVED_KEY);
  return got[SAVED_KEY] || {};
}

function savedList(saved) {
  return Object.keys(saved)
    .sort((a, b) => String(saved[b].at || "").localeCompare(String(saved[a].at || "")))
    .map(name => ({ name, count: saved[name].count || 0, at: saved[name].at || "" }));
}

const snapshot = obj => JSON.parse(JSON.stringify(obj));

// Newest first. _addedAt is stamped on every write, so the row you just touched is the
// row at the top of the drawer. Key order is the tiebreak for same-millisecond writes.
function listRows(store) {
  return Object.keys(store)
    .sort((a, b) => {
      const d = String(store[b]._addedAt || "").localeCompare(String(store[a]._addedAt || ""));
      return d || a.localeCompare(b);
    })
    .map(key => Object.assign({ key, qty: 1 }, store[key]));
}

// A stored 0 is a real house rate ("we are not paying for these"), not a missing one.
// Per-row 0 was already honoured; coercing the global 0 to 100 made the same keystroke
// mean two different things depending on which box you typed it in.
//
// `set` is the other half of that answer, and it is not cosmetic. DEFAULT_PCT is 100, so
// on a fresh install - or after cleared storage, or on a second machine - every row is
// priced at 100% of market and nothing anywhere says so. Print that and you have handed
// somebody a signed offer at full retail. The house rate is a decision the shop makes
// once; until it has been made, `set` is false and the UI refuses to print.
async function getPctState() {
  const got = await chrome.storage.local.get(PCT_KEY);
  const raw = got[PCT_KEY];
  if (raw === undefined || raw === null || raw === "") return { pct: DEFAULT_PCT, set: false };
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0
    ? { pct: n, set: true }
    : { pct: DEFAULT_PCT, set: false };
}

async function getPct() {
  return (await getPctState()).pct;
}

function clampPct(v) {
  // Number("") is 0, and an empty box is "no answer", not "we pay nothing".
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1000, Math.max(0, Math.round(n * 10) / 10));
}

async function collect(msg, fetchPage) {
  const { productId, sel, meta } = msg;
  const res = await collectSales(productId, sel, fetchPage);
  if (!res.matched.length) {
    return {
      ok: false,
      error: res.invalid
        ? `no usable sale for this printing and grade: ${res.invalid} had an unreadable `
          + `price or date, ${res.rejected} rejected`
        : `no sale matched this printing and grade, ${res.rejected} rejected`
    };
  }

  const fx = await getFx();
  const fxFailed = fx.rate === null;
  let row;
  try {
    row = buildRow(meta, sel, res.matched, fx);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  // Dedup key: productId + printing + condition + language. Re-adding OVERWRITES with
  // the fresh pull. Never silently skip - overwriting is how a stale entry gets
  // refreshed. Only the price data is replaced.
  //
  // mode "bump" (a plain click on an already-collected grade) also adds a copy;
  // anything else - shift-click, refresh-all, an old caller that sends no mode -
  // refreshes the price and leaves qty alone. Your per-row % override always survives.
  //
  // Language is part of the key because a product can sell in more than one: without it
  // a Japanese Holofoil NM pull silently overwrites the English one at the same grade.
  // It stays out of COLUMNS, so the exported spreadsheet is unchanged.
  const key = `${productId}|${row.printing}|${row.condition}|${row._language}`;

  const out = await withStore(store => {
    const prev = store[key];

    // Refresh-all builds its key list outside the queue, so a row deleted while the
    // refresh was paging would be re-created here from a stale snapshot - back from the
    // dead with qty and % wiped. `onlyIfPresent` makes each write re-check inside the
    // queue, where the answer is current.
    if (!prev && msg.onlyIfPresent) {
      return { mode: "gone", count: Object.keys(store).length };
    }

    let mode = "added";
    if (prev) {
      const q = Math.max(1, Math.round(Number(prev.qty) || 1));
      if (msg.mode === "bump") { row.qty = q + 1; mode = "incremented"; }
      else { row.qty = q; mode = "refreshed"; }
      if (prev._pct !== undefined) row._pct = prev._pct;

      // FX outage on a row that already had a rate. Blanking `cad` here is how a
      // refresh-all during an outage used to wipe every CAD price in the collection with
      // no undo. Instead the row keeps its last known rate and re-prices at it, so
      // cad === avg_usd * _fx_rate still holds even though the price moved; _fx_at keeps
      // the ORIGINAL timestamp, which is what tells you the rate is old.
      if (fxFailed && prev._fx_rate) {
        const rate = Number(prev._fx_rate);
        if (Number.isFinite(rate) && rate > 0) {
          row.cad = (Number(row.avg_usd) * rate).toFixed(2);
          row._fx_rate = prev._fx_rate;
          row._fx_at = prev._fx_at || "";
          row._fx_date = prev._fx_date || "";
          row._fx_src = prev._fx_src || "";
          row._fx_stale = true;
        }
      }
    }

    // A refresh is not a touch: re-stamping _addedAt on every refresh reshuffled the
    // whole drawer into whatever order refreshAll happened to walk the keys. Adding a
    // copy still floats the row to the top.
    const addedAt = mode === "refreshed" && prev && prev._addedAt
      ? prev._addedAt
      : new Date().toISOString();

    store[key] = Object.assign(row, { _addedAt: addedAt });
    return { mode, qty: row.qty, count: Object.keys(store).length };
  });

  if (out.mode === "gone") {
    return { ok: false, skipped: true, key, error: "row was removed during the refresh" };
  }

  return {
    ok: true,
    key,
    mode: out.mode,
    qty: out.qty,
    samples: row._samples,
    rejected: res.rejected,
    invalid: res.invalid,
    capped: res.capped,
    stale: row._stale,
    fxFailed,
    noFx: row.cad === "",
    count: out.count
  };
}

// Progress and cancellation for the long-running refresh. A 50-row collection is 50
// sequential paging runs; with no progress and no way out, the only honest option the
// user had was to close the tab.
//
// State is PER-RUN, not module-global: with shared flags, Cancel pressed in one tab
// stopped a refresh started in another, and progress redirected to whichever tab asked
// last. `refreshRun` holds the ONE live run - a second "refreshAll" while it runs is
// refused with { busy: true } instead of interleaving - and cancellation targets the
// live run by id, so a Cancel left over from a finished run cannot kill the next one.
//
// The run's progress is also persisted to chrome.storage.local per row (REFRESH_KEY:
// { id, done, total, failedKeys, ... , finished }). MV3 can kill the worker mid-run,
// and a long run can outlive the single sendResponse callback; without the record, a
// 40-of-50 refresh reported as TOTAL failure and the failedKeys - the whole point of
// the run - evaporated with the worker. The caller gets { started: true, runId }
// straight away, progress streams as broadcasts, and the final result travels BOTH as
// a "refreshDone" broadcast and as the persisted record ("refreshStatus" reads it), so
// partial success is never reported as no success.
const REFRESH_KEY = "refreshRun";
let refreshRun = null;   // { id, cancel, tab, promise } - the one live run, or null

// chrome.runtime.sendMessage from a service worker reaches extension pages, NOT content
// scripts - a content script is only addressable through chrome.tabs.sendMessage with
// its tab id, which the onMessage listener below hands us from `sender`.
function broadcast(run, msg) {
  try {
    if (!run || run.tab === null || typeof chrome === "undefined" ||
        !chrome.tabs || !chrome.tabs.sendMessage) return;
    const p = chrome.tabs.sendMessage(run.tab, msg);
    if (p && p.catch) p.catch(() => {});   // the tab closed or navigated: not our problem
  } catch (e) { /* same */ }
}

async function saveRefreshRecord(rec) {
  try { await chrome.storage.local.set({ [REFRESH_KEY]: rec }); } catch (e) { /* non-fatal */ }
}

async function readRefreshRecord() {
  try { return (await chrome.storage.local.get(REFRESH_KEY))[REFRESH_KEY] || null; }
  catch (e) { return null; }
}

// Re-pull every collected row at today's rate. Sequential on purpose: the sales API is
// the bottleneck and a burst of parallel paging is how you get rate limited.
async function runRefresh(run, fetchPage) {
  const store = await loadStore();
  const keys = Object.keys(store);
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;   // deleted while the refresh was running
  let fxFailed = 0;  // re-priced against a stale rate because FX was down
  // WHICH rows failed, not just how many: "47 done, 3 failed" leaves you to find the 3
  // by eye across a drawer of 50.
  const failedKeys = [];
  let cancelled = false;
  let done = 0;

  const record = finished => ({
    id: run.id, at: new Date().toISOString(), done, total: keys.length,
    refreshed, failed, skipped, fxFailed, failedKeys: failedKeys.slice(),
    cancelled, finished: !!finished
  });

  await saveRefreshRecord(record(false));
  broadcast(run, { type: "refreshProgress", runId: run.id, done: 0, total: keys.length });

  for (const key of keys) {
    if (run.cancel) { cancelled = true; break; }
    const row = store[key];
    const productId = key.split("|")[0];
    const sel = {
      condition: row.condition,
      variant: row.printing,
      language: row._language || "English"
    };
    const meta = { name: row.name, set: row.set, number: row.number, url: row._url };
    try {
      const res = await collect(
        { productId, sel, meta, mode: "refresh", onlyIfPresent: true }, fetchPage);
      if (res.ok) {
        refreshed++;
        if (res.fxFailed) fxFailed++;
      } else if (res.skipped) {
        skipped++;
      } else {
        failed++;
        failedKeys.push(key);
      }
    } catch (e) {
      failed++;
      failedKeys.push(key);
    }
    done++;
    // one write per row: if the worker dies on row 41 of 50, the record still names
    // the 40 that finished and every key that failed so far
    await saveRefreshRecord(record(false));
    broadcast(run, { type: "refreshProgress", runId: run.id, done, total: keys.length });
  }

  const result = {
    ok: true,
    runId: run.id,
    refreshed,
    failed,
    failedKeys,
    skipped,
    fxFailed,
    cancelled,
    remaining: keys.length - done,
    // Anything less than a clean sweep is reported, so an FX outage cannot quietly leave
    // the collection priced at yesterday's rate while the button says it worked.
    partial: failed > 0 || fxFailed > 0 || cancelled,
    count: Object.keys(await loadStore()).length
  };

  await saveRefreshRecord(record(true));
  broadcast(run, { type: "refreshDone", runId: run.id, result });
  return result;
}

// Starts a run and answers immediately. The content script drives completion from the
// refreshDone broadcast plus the persisted record, never from this response.
function startRefreshAll(fetchPage, tabId) {
  if (refreshRun) {
    return { ok: false, busy: true, runId: refreshRun.id,
             error: "a refresh is already running" };
  }
  const run = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cancel: false,
    tab: tabId === undefined ? null : tabId
  };
  refreshRun = run;
  run.promise = runRefresh(run, fetchPage)
    .catch(e => ({ ok: false, error: String((e && e.message) || e) }))
    .finally(() => { if (refreshRun === run) refreshRun = null; });
  return { ok: true, started: true, runId: run.id };
}

// Start-and-wait convenience: the same run machinery (including the busy refusal), but
// resolved with the full result. Tests use it; the message path never does.
async function refreshAll(fetchPage) {
  const started = startRefreshAll(fetchPage);
  if (!started.ok) return started;
  return refreshRun.promise;
}

async function exportRows() {
  return withTrade(listRows(await loadStore()), await getPct());
}

// ---------------------------------------------------------------- messages

async function handle(msg, fetchPage, senderTab) {
  switch (msg.type) {
    case "firstPage": {
      const page = await fetchSalesPage(msg.productId, 0);
      const store = await loadStore();
      return {
        ok: true,
        loggedOut: looksLoggedOut(page),
        rows: page.data || [],
        haveKeys: Object.keys(store),
        count: Object.keys(store).length
      };
    }
    case "collect":
      return collect(msg, fetchPage);
    case "refreshAll":
      return startRefreshAll(fetchPage, senderTab);
    case "cancelRefresh":
      // Cancellation is scoped to the live run. A caller naming a runId may only stop
      // that run; a stale Cancel from a finished run falls through harmlessly.
      if (!refreshRun || (msg.runId && msg.runId !== refreshRun.id)) {
        return { ok: false, error: "no such refresh" };
      }
      refreshRun.cancel = true;
      return { ok: true };
    // The persisted progress/result of the latest run, for a drawer that opened after
    // the run started, another tab, or a run whose worker died partway through.
    case "refreshStatus": {
      const rec = await readRefreshRecord();
      return { ok: true, record: rec,
               running: !!(refreshRun && rec && refreshRun.id === rec.id) };
    }
    case "list": {
      const rows = listRows(await loadStore());
      const pct = await getPctState();
      return { ok: true, rows, count: rows.length, pct: pct.pct, pctSet: pct.set };
    }
    case "setQty":
      return withStore(store => {
        if (!store[msg.key]) return { ok: false, error: "gone" };
        store[msg.key].qty = Math.max(1, Math.round(Number(msg.qty) || 1));
        return { ok: true, qty: store[msg.key].qty };
      });
    // Per-row trade-in percent. An empty value clears the override and the row falls
    // back to the global percent - that is the difference between "same as global"
    // and "pinned at a number that happens to equal global today".
    case "setPct":
      return withStore(store => {
        if (!store[msg.key]) return { ok: false, error: "gone" };
        const pct = clampPct(msg.pct);
        if (msg.pct === "" || msg.pct === null || pct === null) delete store[msg.key]._pct;
        else store[msg.key]._pct = pct;
        return { ok: true, pct: store[msg.key]._pct };
      });
    case "setGlobalPct": {
      const pct = clampPct(msg.pct);
      // Blanking the box is not choosing a rate. It used to store DEFAULT_PCT, which
      // would have counted as the first-run decision without anybody making one.
      if (pct === null) {
        const st = await getPctState();
        return { ok: true, pct: st.pct, pctSet: st.set };
      }
      await chrome.storage.local.set({ [PCT_KEY]: pct });
      return { ok: true, pct, pctSet: true };
    }
    // Undo is SURGICAL. It hands back a snapshot plus the exact keys the action removed,
    // and restore puts back only those - never the whole store.
    //
    // Taking the snapshot back verbatim is a data-loss bug: delete a row, collect a
    // different card, hit Undo inside the five seconds, and the newly collected row is
    // silently destroyed because it did not exist when the snapshot was taken. Undo may
    // only ever ADD BACK what it removed.
    case "remove":
      return withStore(store => {
        // A double-click on the trash used to get ok:true twice, and the second toast -
        // carrying a snapshot the row was already missing from - replaced the first,
        // destroying the only undo that could have brought it back.
        if (!Object.prototype.hasOwnProperty.call(store, msg.key)) {
          return { ok: false, error: "gone", count: Object.keys(store).length };
        }
        const prev = Object.assign({}, store);
        const name = store[msg.key].name;
        delete store[msg.key];
        return { ok: true, prev, keys: [msg.key], name, count: Object.keys(store).length };
      });
    case "restore":
      return withStore(store => {
        const snap = msg.store || {};
        // No keys given: the caller is seeding the store (or is an older caller), so the
        // whole snapshot is the candidate set. Either way nothing is ever deleted.
        const keys = Array.isArray(msg.keys) ? msg.keys : Object.keys(snap);
        let restored = 0, kept = 0;
        for (const k of keys) {
          if (!Object.prototype.hasOwnProperty.call(snap, k)) continue;
          // Present again means something NEWER is there - a re-collect, a refresh, a
          // fresh add. Never overwrite it with the snapshot's older copy.
          if (Object.prototype.hasOwnProperty.call(store, k)) { kept++; continue; }
          store[k] = snap[k];
          restored++;
        }
        return { ok: true, restored, kept, count: Object.keys(store).length };
      });
    // The CSV text plus a filename. The content script builds a Blob URL and clicks a
    // download link itself: an MV3 service worker has no URL.createObjectURL, and a
    // data: URL re-encodes the whole sheet into the URL bar's worst format.
    case "csvText": {
      const rows = await exportRows();
      if (!rows.length) return { ok: false, error: "nothing collected yet" };
      return {
        ok: true,
        text: toDelimited(rows, ",", EXPORT_COLUMNS),
        filename: `tcg-sales-${new Date().toISOString().slice(0, 10)}.csv`,
        count: rows.length
      };
    }
    case "copyText": {
      const rows = await exportRows();
      if (!rows.length) return { ok: false, error: "nothing collected yet" };
      return { ok: true, text: toDelimited(rows, "\t", EXPORT_COLUMNS), count: rows.length };
    }
    case "clear":
      return withStore(store => {
        const prev = Object.assign({}, store);
        const keys = Object.keys(store);
        for (const k of keys) delete store[k];
        return { ok: true, prev, keys, cleared: keys.length, count: 0 };
      });
    case "count":
      return { ok: true, count: Object.keys(await loadStore()).length };

    // ---- saved buylists. Reads and writes of the CURRENT rows go through withStore
    // so a save can never race a chip click; the saves map itself is only touched
    // from inside those queued sections or standalone reads.
    case "saveAs": {
      const name = String(msg.name || "").trim().slice(0, 60);
      if (!name) return { ok: false, error: "Name the buylist first" };
      return withStore(async store => {
        const count = Object.keys(store).length;
        if (!count) return { ok: false, error: "Nothing to save" };
        const saved = await loadSaved();
        const replaced = !!saved[name];
        saved[name] = { rows: snapshot(store), at: new Date().toISOString(), count };
        await chrome.storage.local.set({ [SAVED_KEY]: saved });
        return { ok: true, name, count, replaced, saves: savedList(saved) };
      });
    }
    case "listSaved":
      return { ok: true, saves: savedList(await loadSaved()) };
    case "loadSaved":
      return withStore(async store => {
        const s = (await loadSaved())[msg.name];
        if (!s) return { ok: false, error: "No such buylist" };
        const prev = Object.assign({}, store);
        for (const k of Object.keys(store)) delete store[k];
        Object.assign(store, snapshot(s.rows));
        return { ok: true, prev, name: msg.name, count: Object.keys(store).length };
      });
    // Wholesale replacement - the undo of loadSaved. Unlike "restore" it does not
    // merge: undoing a load must bring back exactly the buylist that was showing.
    case "replaceStore":
      return withStore(store => {
        for (const k of Object.keys(store)) delete store[k];
        Object.assign(store, snapshot(msg.store || {}));
        return { ok: true, count: Object.keys(store).length };
      });
    // Serialized like saveAs: this is a read-modify-write of the saves map, and running
    // it outside the queue let a delete racing a queued save clobber the save (or
    // resurrect the deleted buylist) depending on which write landed last.
    case "deleteSaved":
      return withStore(async () => {
        const saved = await loadSaved();
        if (!saved[msg.name]) return { ok: false, error: "No such buylist" };
        delete saved[msg.name];
        await chrome.storage.local.set({ [SAVED_KEY]: saved });
        return { ok: true, saves: savedList(saved) };
      });
  }
  throw new Error("unknown message: " + msg.type);
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // The asking tab's id travels into handle(), so a long refresh can stream its
    // position back to the drawer that started it - and only that drawer.
    const tab = sender && sender.tab ? sender.tab.id : undefined;
    handle(msg, undefined, tab).then(
      sendResponse,
      err => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true; // async response
  });
}

// node-runnable tests import the pure functions from here
if (typeof module !== "undefined") {
  module.exports = {
    COLUMNS, TRADE_COLUMNS, TRUST_COLUMNS, EXPORT_COLUMNS,
    MAX_PAGES, PAGE_SIZE, SAMPLES, STALE_DAYS, LOW_SAMPLES, DEFAULT_PCT,
    matchesSelection, collectSales, buildRow, toDelimited, looksLoggedOut,
    getFx, collect, handle, fetchSalesPage, refreshAll, startRefreshAll, listRows,
    clampPct, metaLooksWrong,
    csvCell, tsvCell, isUsableSale, salePrice, saleTime, withTrade, getPct,
    getPctState, neutralise, round2
  };
}
