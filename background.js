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
const FX_URL = "https://open.er-api.com/v6/latest/USD";

const PAGE_SIZE = 25;   // server cap; a larger `limit` is ignored
const MAX_PAGES = 10;   // a rare condition on a busy product must not spin forever
const SAMPLES = 5;
const STALE_DAYS = 60;
const STORE_KEY = "rows";
const PCT_KEY = "pct";
const DEFAULT_PCT = 100;

// Exported columns. Everything else a stored row carries is underscore-prefixed and
// stays out of the spreadsheet (sample count, staleness, FX rate, source URL, timestamp).
const COLUMNS = ["name", "set", "number", "printing", "condition", "avg_usd", "cad", "qty"];

// What actually leaves the extension. `cad` is market price; the three trade columns are
// what you would pay. Both numbers ship, explicitly labelled, because a sheet carrying
// only market price gets quoted at market price and the whole margin walks out the door.
//   pct         - the percent applied to this row (its override, else the house rate)
//   trade_cad   - market cad * pct/100, one copy
//   trade_total - trade_cad * qty
const TRADE_COLUMNS = ["pct", "trade_cad", "trade_total"];
const EXPORT_COLUMNS = COLUMNS.concat(TRADE_COLUMNS);

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

function saleTime(row) {
  const v = row && row.orderDate;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function isUsableSale(row) {
  return salePrice(row) !== null && saleTime(row) !== null;
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

let fxCache = null; // { rate, at } - one successful fetch per worker session

async function getFx() {
  if (fxCache) return fxCache;
  try {
    const res = await fetch(FX_URL);
    const json = await res.json();
    const rate = json && json.rates && json.rates.CAD;
    if (typeof rate !== "number") throw new Error("no CAD rate");
    fxCache = { rate, at: new Date().toISOString() };
    return fxCache;
  } catch (e) {
    // Failures are NOT cached: retry on the next add. cad ends up an empty string.
    // Never 0, never 1.0, never a hardcoded rate.
    return { rate: null, at: "" };
  }
}

// ---------------------------------------------------------------- row build

function buildRow(meta, sel, matched, fx, now) {
  now = now || Date.now();

  // Unreadable rows are dropped here as well as in collectSales, so a caller that hands
  // buildRow a raw array cannot produce a NaN price either.
  const used = matched
    .filter(isUsableSale)
    .sort((a, b) => saleTime(b) - saleTime(a))   // newest first
    .slice(0, SAMPLES);                          // ...so this keeps the MOST RECENT 5

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
  const oldestAt = saleTime(used[used.length - 1]);
  const ageDays = (now - oldestAt) / 86400000;

  const rate = fx && typeof fx.rate === "number" ? fx.rate : null;

  return {
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
    _url: meta.url
  };
}

// ---------------------------------------------------------------- output

// A cell whose first character is one of = + - @ is a FORMULA to Excel, Sheets and
// LibreOffice - it executes on open, and card names are attacker-supplied text from a
// marketplace listing. A leading apostrophe forces it back to text in every one of them.
// Tab/CR at the start get the same treatment: they are stripped by some importers,
// re-exposing the character behind them.
const RISKY_LEAD = /^[=+\-@\t\r]/;

function neutralise(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return RISKY_LEAD.test(s) ? "'" + s : s;
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

// Decorates stored rows with the trade columns so the export carries both the market
// price and the price you would actually pay. Empty (not 0) when FX is missing, matching
// how `cad` itself behaves.
function withTrade(rows, globalPct) {
  return rows.map(row => {
    const pct = rowPct(row, globalPct);
    const qty = Math.max(1, Math.round(Number(row.qty) || 1));
    const market = row.cad === "" || row.cad === undefined || row.cad === null
      ? null : Number(row.cad);
    const unit = market === null || !Number.isFinite(market) ? null : market * pct / 100;
    return Object.assign({}, row, {
      pct: String(pct),
      trade_cad: unit === null ? "" : unit.toFixed(2),
      trade_total: unit === null ? "" : (unit * qty).toFixed(2)
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
async function getPct() {
  const got = await chrome.storage.local.get(PCT_KEY);
  const raw = got[PCT_KEY];
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PCT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PCT;
}

function clampPct(v) {
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

// Re-pull every collected row at today's rate. Sequential on purpose: the sales API is
// the bottleneck and a burst of parallel paging is how you get rate limited.
async function refreshAll(fetchPage) {
  const store = await loadStore();
  const keys = Object.keys(store);
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;   // deleted while the refresh was running
  let fxFailed = 0;  // re-priced against a stale rate because FX was down

  for (const key of keys) {
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
      }
    } catch (e) {
      failed++;
    }
  }

  return {
    ok: true,
    refreshed,
    failed,
    skipped,
    fxFailed,
    // Anything less than a clean sweep is reported, so an FX outage cannot quietly leave
    // the collection priced at yesterday's rate while the button says it worked.
    partial: failed > 0 || fxFailed > 0,
    count: Object.keys(await loadStore()).length
  };
}

async function exportRows() {
  return withTrade(listRows(await loadStore()), await getPct());
}

async function exportCsv() {
  const rows = await exportRows();
  if (!rows.length) return { ok: false, error: "nothing collected yet" };
  await chrome.downloads.download({
    url: "data:text/csv;charset=utf-8,"
      + encodeURIComponent(toDelimited(rows, ",", EXPORT_COLUMNS)),
    filename: `tcg-sales-${new Date().toISOString().slice(0, 10)}.csv`,
    saveAs: false
  });
  return { ok: true, count: rows.length };
}

// ---------------------------------------------------------------- messages

async function handle(msg, fetchPage) {
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
      return refreshAll(fetchPage);
    case "list": {
      const rows = listRows(await loadStore());
      return { ok: true, rows, count: rows.length, pct: await getPct() };
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
      await chrome.storage.local.set({ [PCT_KEY]: pct === null ? DEFAULT_PCT : pct });
      return { ok: true, pct: await getPct() };
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
    case "export":
      return exportCsv();
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
  }
  throw new Error("unknown message: " + msg.type);
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handle(msg).then(
      sendResponse,
      err => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true; // async response
  });
}

// node-runnable tests import the pure functions from here
if (typeof module !== "undefined") {
  module.exports = {
    COLUMNS, TRADE_COLUMNS, EXPORT_COLUMNS,
    MAX_PAGES, PAGE_SIZE, SAMPLES, STALE_DAYS, DEFAULT_PCT,
    matchesSelection, collectSales, buildRow, toDelimited, looksLoggedOut,
    getFx, collect, handle, fetchSalesPage, refreshAll, listRows, clampPct,
    csvCell, tsvCell, isUsableSale, salePrice, saleTime, withTrade, getPct
  };
}
