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

// Logged out, the endpoint silently caps at 5 rows and ignores paging.
function looksLoggedOut(page) {
  return page.totalResults <= 5 && page.nextPage !== "Yes";
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

async function collectSales(productId, sel, fetchPage) {
  fetchPage = fetchPage || fetchSalesPage;
  const matched = [];
  let rejected = 0, offset = 0, pages = 0, capped = false;

  for (;;) {
    const page = await fetchPage(productId, offset, [sel.condition]);
    pages++;
    for (const row of page.data || []) {
      if (matchesSelection(row, sel)) matched.push(row);
      else rejected++;
    }
    if (matched.length >= SAMPLES) break;
    if (page.nextPage !== "Yes") break;
    if (pages >= MAX_PAGES) { capped = true; break; }
    offset += PAGE_SIZE;
  }

  return { matched, rejected, pages, capped };
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

  const used = matched
    .slice()
    .sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate))
    .slice(0, SAMPLES);

  // BUSINESS RULES - do not "improve" these:
  //   1. sale-row quantity is IGNORED. A quantity-3 sale is ONE sample, not three.
  //      (The `qty` column is a different thing: how many copies YOU are trading in.)
  //   2. shippingPrice is EXCLUDED. The average is purchasePrice only.
  // Plain arithmetic mean. Not median, not trimmed, not weighted.
  const avg = used.reduce((sum, r) => sum + r.purchasePrice, 0) / used.length;

  // Sorted descending, so the last one is the oldest. UTC from the API - never the
  // UI's localized display, which disagrees by up to a day.
  const oldest = used[used.length - 1].orderDate;
  const ageDays = (now - new Date(oldest).getTime()) / 86400000;

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
    _oldest: new Date(oldest).toISOString().slice(0, 10),
    _stale: ageDays > STALE_DAYS,
    _fx_rate: rate === null ? "" : rate.toFixed(4),
    _fx_at: rate === null ? "" : fx.at,
    _url: meta.url
  };
}

// ---------------------------------------------------------------- output

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// delim "," -> CSV file. delim "\t" -> clipboard text that pastes straight into
// Google Sheets / Excel cells with no import dialog.
function toDelimited(rows, delim) {
  const esc = delim === "\t"
    ? v => String(v === null || v === undefined ? "" : v).replace(/[\t\r\n]+/g, " ")
    : csvCell;
  return [COLUMNS.join(delim)]
    .concat(rows.map(r => COLUMNS.map(c => esc(r[c])).join(delim)))
    .join("\r\n");
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

async function getPct() {
  const got = await chrome.storage.local.get(PCT_KEY);
  const n = Number(got[PCT_KEY]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PCT;
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
    return { ok: false, error: `no sale matched this printing and grade, ${res.rejected} rejected` };
  }

  const row = buildRow(meta, sel, res.matched, await getFx());
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
    let mode = "added";
    if (prev) {
      const q = Math.max(1, Math.round(Number(prev.qty) || 1));
      if (msg.mode === "bump") { row.qty = q + 1; mode = "incremented"; }
      else { row.qty = q; mode = "refreshed"; }
      if (prev._pct !== undefined) row._pct = prev._pct;
    }
    store[key] = Object.assign(row, { _addedAt: new Date().toISOString() });
    return { mode, qty: row.qty, count: Object.keys(store).length };
  });

  return {
    ok: true,
    key,
    mode: out.mode,
    qty: out.qty,
    samples: row._samples,
    rejected: res.rejected,
    capped: res.capped,
    stale: row._stale,
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
      const res = await collect({ productId, sel, meta, mode: "refresh" }, fetchPage);
      if (res.ok) refreshed++; else failed++;
    } catch (e) {
      failed++;
    }
  }

  return { ok: true, refreshed, failed, count: Object.keys(await loadStore()).length };
}

async function exportCsv() {
  const rows = listRows(await loadStore());
  if (!rows.length) return { ok: false, error: "nothing collected yet" };
  await chrome.downloads.download({
    url: "data:text/csv;charset=utf-8," + encodeURIComponent(toDelimited(rows, ",")),
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
    // Undo works by handing the drawer the whole prior store and taking it back
    // verbatim. Restoring a diff would drift the moment a refresh lands in between.
    case "remove":
      return withStore(store => {
        const prev = Object.assign({}, store);
        const name = store[msg.key] && store[msg.key].name;
        delete store[msg.key];
        return { ok: true, prev, name, count: Object.keys(store).length };
      });
    case "restore":
      return withStore(store => {
        for (const k of Object.keys(store)) delete store[k];
        Object.assign(store, msg.store || {});
        return { ok: true, count: Object.keys(store).length };
      });
    case "export":
      return exportCsv();
    case "copyText": {
      const rows = listRows(await loadStore());
      if (!rows.length) return { ok: false, error: "nothing collected yet" };
      return { ok: true, text: toDelimited(rows, "\t"), count: rows.length };
    }
    case "clear":
      return withStore(store => {
        const prev = Object.assign({}, store);
        const n = Object.keys(store).length;
        for (const k of Object.keys(store)) delete store[k];
        return { ok: true, prev, cleared: n, count: 0 };
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
    COLUMNS, MAX_PAGES, PAGE_SIZE, SAMPLES, STALE_DAYS, DEFAULT_PCT,
    matchesSelection, collectSales, buildRow, toDelimited, looksLoggedOut,
    getFx, collect, handle, fetchSalesPage, refreshAll, listRows, clampPct
  };
}
