"use strict";
// node test.js
const assert = require("assert");

// minimal chrome.storage.local stub - must exist before background.js is required
global.chrome = {
  storage: {
    local: {
      _d: {},
      async get(k) { return this._d[k] === undefined ? {} : { [k]: this._d[k] }; },
      async set(o) { Object.assign(this._d, o); },
      async remove(k) { delete this._d[k]; }
    }
  }
};

const bg = require("./background.js");

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

  console.log(`\n${passed} assertion groups passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
