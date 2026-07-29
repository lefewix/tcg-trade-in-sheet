"use strict";

// TCG Sales CSV - product page UI. No fetching here; the service worker does it all.

let PID, SLUG;
function readUrl() {
  PID = (location.pathname.match(/\/product\/(\d+)/) || [])[1];
  SLUG = (location.pathname.match(/\/product\/\d+\/([^/?#]+)/) || [])[1] || "";
}

function send(msg) { return chrome.runtime.sendMessage(msg); }

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

// ponytail: six inline glyphs instead of an icon package. A zero-build content script
// has no bundler to tree-shake @phosphor-icons, and the whole set below is 8 lines.
// Uniform 24-grid, 1.6 stroke, currentColor.
const ICONS = {
  check: ["M20 6.6 9.2 17.4 4 12.2"],
  warn: ["M12 9.3v4.2", "M12 16.8h.01",
         "M10.6 4 2.6 17.9a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4L13.4 4a1.6 1.6 0 0 0-2.8 0Z"],
  close: ["M17.5 6.5 6.5 17.5", "M6.5 6.5l11 11"],
  copy: ["M9 8.6h9a1.6 1.6 0 0 1 1.6 1.6v9a1.6 1.6 0 0 1-1.6 1.6h-9A1.6 1.6 0 0 1 7.4 19.2v-9A1.6 1.6 0 0 1 9 8.6Z",
         "M4.8 15.4A1.6 1.6 0 0 1 3.2 13.8v-9A1.6 1.6 0 0 1 4.8 3.2h9a1.6 1.6 0 0 1 1.6 1.6"],
  download: ["M12 3.6v11.2", "M16.2 10.6 12 14.8 7.8 10.6", "M4 19.8h16"],
  trash: ["M4.6 6.9h14.8", "M10 10.9v6", "M14 10.9v6",
          "M6.7 6.9l.8 11.9a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.8-11.9",
          "M9.5 6.9V5a1.4 1.4 0 0 1 1.4-1.4h2.2A1.4 1.4 0 0 1 14.5 5v1.9"]
};

function icon(name, size) {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24", width: size || 16, height: size || 16,
    fill: "none", stroke: "currentColor", "stroke-width": "1.6",
    "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true", focusable: "false", class: "tsc-i"
  });
  for (const d of ICONS[name]) svg.appendChild(svgEl("path", { d }));
  return svg;
}

// The brand mark: three cards stood on a shelf, rising left to right. Same geometry as
// logo.svg / the extension icons, so the panel and the toolbar read as one thing.
function mark(size) {
  const svg = svgEl("svg", {
    viewBox: "0 0 128 128", width: size, height: size,
    "aria-hidden": "true", focusable: "false", class: "tsc-mark"
  });
  const bars = [
    { x: 14, y: 72, h: 42, f: "#3a3745" },
    { x: 49, y: 52, h: 62, f: "#6b6580" },
    { x: 84, y: 24, h: 90, f: "#8b5cf6" }
  ];
  for (const b of bars) {
    svg.appendChild(svgEl("rect", { x: b.x, y: b.y, width: 30, height: b.h, rx: 6, fill: b.f }));
  }
  svg.appendChild(svgEl("rect", { x: 10, y: 118, width: 108, height: 8, rx: 4,
    fill: "rgba(255,255,255,.16)" }));
  return svg;
}

// ============================================================================
// THE ONLY DOM-DERIVED DATA IN THIS EXTENSION.
// Everything else comes from the API. When TCGplayer redesigns the product page,
// this function is what breaks - and nothing else. Keep it in one piece.
// ============================================================================
let metaCache = null;
function scrapePageMeta() {
  if (metaCache) return metaCache;

  // name (and sku = productId) from the ld+json Product block
  let name = "";
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent);
      const p = Array.isArray(parsed)
        ? parsed.find(x => x && x["@type"] === "Product")
        : parsed;
      if (p && p["@type"] === "Product" && p.name) { name = p.name; break; }
    } catch (e) { /* malformed block, try the next one */ }
  }

  // set from the breadcrumb, falling back to the URL slug
  const crumbs = Array.from(document.querySelectorAll('[class*="breadcrumb"] a'))
    .map(a => a.textContent.trim())
    .filter(Boolean);
  const set = crumbs.length ? crumbs[crumbs.length - 1] : SLUG;

  // "Card Number / Rarity: 13/108 / Ultra Rare"  ->  "13/108"
  const m = document.body.innerText.match(/Card Number\s*\/\s*Rarity:\s*(.+)/);
  const number = m ? m[1].split(" / ")[0].trim() : "";

  const meta = {
    name: name || SLUG,
    set: set || SLUG,
    number,
    url: location.origin + location.pathname
  };
  // Only cache a complete scrape. A miss here means the details block had not
  // rendered yet, and caching that would make the gap permanent for this page.
  if (name && number) metaCache = meta;
  return meta;
}
// ============================================================================

function mount(node) {
  const header = document.querySelector(".price-guide__points-header");
  if (header) { header.insertAdjacentElement("afterend", node); return; }
  (document.querySelector(".product-details__price-guide") || document.body).appendChild(node);
}

// TCGplayer hydrates the price-guide section after first paint. On a fast load the
// content script can mount into markup the framework then throws away, so the panel
// silently vanishes. Rather than guess at timing, watch the DOM and re-mount.
// Also catches client-side navigation between products, which never reloads the page.
let panel, floatRoot, href = location.href;
function keepMounted() {
  let pending = 0;
  const check = () => {
    pending = 0;
    if (location.href !== href) { href = location.href; readUrl(); rebuild(); return; }
    if (!panel) return;
    if (!panel.isConnected) { mount(panel); }
    // mounted on the document.body fallback, but the real anchor showed up late
    else if (panel.parentElement === document.body &&
             document.querySelector(".price-guide__points-header")) { mount(panel); }
    if (floatRoot && !floatRoot.isConnected) document.body.appendChild(floatRoot);
  };
  new MutationObserver(() => { if (!pending) pending = setTimeout(check, 250); })
    .observe(document.documentElement, { childList: true, subtree: true });
}

function rebuild() {
  if (panel) panel.remove();
  panel = null;
  metaCache = null;
  if (PID) init();
}

function start() {
  style();
  floatingUi();
  keepMounted();
  init();
}

// ---------------------------------------------------------------- style
//
// One theme, dark: the panel and the drawer are the same object seen twice, and a dark
// violet surface reads as ours rather than as a piece of TCGplayer's own chrome.
// Every rule is scoped under .tsc-panel / .tsc-root so nothing leaks into the host page.
//
// Shape rule, applied everywhere: containers 14px, controls and inputs 8px,
// chips and badges 7px. Nothing else invents its own radius, and nothing is a pill.
function style() {
  const s = document.createElement("style");
  s.textContent = `
    .tsc-panel,.tsc-root{
      --tsc-ink:#ecebf0; --tsc-ink-2:#c4c0d1; --tsc-mut:#8a879d;
      --tsc-line:#24232c; --tsc-hair:rgba(255,255,255,.08); --tsc-hair-h:rgba(255,255,255,.14);
      --tsc-bg:#17161c; --tsc-sunk:#101014; --tsc-inp:#0c0c10; --tsc-row:#1a1922;
      --tsc-ac:#8b5cf6;
      --tsc-ac-ink:color-mix(in srgb,var(--tsc-ac) 45%,white);
      --tsc-ac-soft:color-mix(in srgb,var(--tsc-ac) 72%,white);
      --tsc-ac-hov:color-mix(in srgb,var(--tsc-ac) 85%,white);
      --tsc-ac-tint:color-mix(in srgb,var(--tsc-ac) 16%,transparent);
      --tsc-ac-line:color-mix(in srgb,var(--tsc-ac-soft) 32%,transparent);
      --tsc-warn:#e3bd7e; --tsc-warn-tint:rgba(227,189,126,.14); --tsc-warn-line:rgba(227,189,126,.32);
      --tsc-err:#ff8b8b; --tsc-err-tint:rgba(255,139,139,.14); --tsc-err-line:rgba(255,139,139,.32);
      --tsc-r-box:14px; --tsc-r-ctl:8px; --tsc-r-chip:7px;
      --tsc-shadow:0 4px 16px rgba(8,5,20,.45);
      --tsc-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
      --tsc-mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
      font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;
    }
    .tsc-panel *,.tsc-root *{box-sizing:border-box}
    .tsc-panel :focus-visible,.tsc-root :focus-visible{
      outline:2px solid var(--tsc-ac);outline-offset:2px;border-radius:var(--tsc-r-ctl)}

    /* ---- in-page panel ---- */
    .tsc-panel{border:1px solid var(--tsc-hair);border-radius:var(--tsc-r-box);
      padding:16px;margin:12px 0;color:var(--tsc-ink);
      background-color:var(--tsc-bg);
      background-image:radial-gradient(color-mix(in srgb,var(--tsc-ac) 6%,transparent) 1px,transparent 1.4px);
      background-size:26px 26px;
      font:13px/1.5 var(--tsc-sans);box-shadow:var(--tsc-shadow)}
    .tsc-head{display:flex;align-items:center;gap:9px;margin:0 0 3px}
    .tsc-mark{display:block;flex:none}
    .tsc-title{margin:0;font-size:14px;font-weight:700;letter-spacing:-.02em;
      color:#fff}
    .tsc-sub{margin:0 0 14px 27px;font-size:11.5px;color:var(--tsc-mut)}

    .tsc-groups{display:flex;flex-direction:column;gap:12px}
    .tsc-grp{display:flex;flex-direction:column;gap:7px}
    .tsc-grp-h{display:flex;align-items:baseline;gap:7px;font-size:11px;font-weight:600;
      letter-spacing:.04em;color:var(--tsc-ink-2)}
    .tsc-grp-h em{font-style:normal;font-weight:500;letter-spacing:0;
      font-size:11.5px;color:var(--tsc-mut)}
    .tsc-chips{display:flex;flex-wrap:wrap;gap:6px}

    .tsc-chip{position:relative;overflow:hidden;display:inline-flex;align-items:center;gap:6px;
      padding:6px 11px;border:1px solid var(--tsc-line);border-radius:var(--tsc-r-chip);
      background:#17171c;color:var(--tsc-ink-2);cursor:pointer;
      font:12px/1.15 var(--tsc-sans);font-weight:500;
      transition:background .15s ease,border-color .15s ease,color .15s ease}
    .tsc-chip:hover:not([disabled]){background:var(--tsc-row);border-color:var(--tsc-hair-h);
      color:var(--tsc-ink)}
    .tsc-chip:active:not([disabled]){transform:translateY(1px)}
    .tsc-chip[disabled]{cursor:default}
    .tsc-chip .tsc-i{flex:none}
    .tsc-thin{border-style:dashed;color:var(--tsc-mut)}
    .tsc-ok{background:var(--tsc-ac-tint);border-color:var(--tsc-ac-line);
      border-style:solid;color:var(--tsc-ac-ink)}
    .tsc-err{background:var(--tsc-err-tint);border-color:var(--tsc-err-line);
      border-style:solid;color:var(--tsc-err)}
    /* working state: a bar crossing the chip, so progress reads without a spinner */
    .tsc-busy{color:var(--tsc-mut)}
    .tsc-busy::after{content:"";position:absolute;left:0;bottom:0;height:2px;width:40%;
      background:var(--tsc-ac);animation:tsc-sweep 1.1s ease-in-out infinite}
    @keyframes tsc-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}

    .tsc-skel{height:29px;width:104px;border-radius:var(--tsc-r-chip);background:#1e1d26;
      animation:tsc-fade 1.2s ease-in-out infinite}
    .tsc-skel:nth-child(2){width:128px;animation-delay:.15s}
    .tsc-skel:nth-child(3){width:88px;animation-delay:.3s}
    @keyframes tsc-fade{0%,100%{opacity:.55}50%{opacity:1}}

    .tsc-note{margin:12px 0 0;font-size:11.5px;color:var(--tsc-mut);min-height:1em}
    .tsc-note b{font-weight:600;color:var(--tsc-ink-2)}
    .tsc-alert{margin:2px 0 0;padding:10px 12px;border-radius:var(--tsc-r-ctl);
      background:var(--tsc-warn-tint);border:1px solid var(--tsc-warn-line);
      color:var(--tsc-warn);font-size:12px;font-weight:500}
    .tsc-alert.tsc-bad{background:var(--tsc-err-tint);border-color:var(--tsc-err-line);color:var(--tsc-err)}

    /* ---- floating collection ---- */
    .tsc-root{position:fixed;right:18px;bottom:18px;z-index:2147483000;
      font:13px/1.5 var(--tsc-sans);color:var(--tsc-ink);
      display:flex;flex-direction:column;align-items:flex-end;gap:10px}
    .tsc-pill{display:inline-flex;align-items:center;gap:9px;padding:9px 13px 9px 11px;
      border-radius:var(--tsc-r-ctl);border:1px solid var(--tsc-hair);background:var(--tsc-bg);
      cursor:pointer;font:13px/1 var(--tsc-sans);font-weight:600;color:var(--tsc-ink);
      box-shadow:var(--tsc-shadow);
      transition:background .15s ease,border-color .15s ease}
    .tsc-pill:hover{background:var(--tsc-row);border-color:var(--tsc-hair-h)}
    .tsc-pill:active{transform:translateY(1px)}
    .tsc-badge{min-width:21px;padding:3px 6px;border-radius:6px;background:var(--tsc-ac);
      color:#fff;font:11px/1 var(--tsc-mono);font-weight:700;font-variant-numeric:tabular-nums;
      text-align:center}
    .tsc-badge[data-zero="1"]{background:#2a2833;color:var(--tsc-mut)}

    .tsc-drawer{width:min(436px,calc(100vw - 36px));max-height:min(66vh,600px);
      display:none;flex-direction:column;background:var(--tsc-bg);
      border:1px solid var(--tsc-hair);border-radius:var(--tsc-r-box);
      box-shadow:0 16px 42px rgba(8,5,20,.55);overflow:hidden}
    .tsc-drawer.tsc-open{display:flex}
    .tsc-dhead{display:flex;align-items:center;gap:9px;padding:12px 12px 12px 14px;
      border-bottom:1px solid var(--tsc-hair)}
    .tsc-dhead h2{flex:1;margin:0;font-size:13px;font-weight:700;letter-spacing:-.02em;
      color:#fff}
    .tsc-x{display:inline-flex;border:0;background:none;cursor:pointer;color:var(--tsc-mut);
      padding:4px;border-radius:6px;transition:background .15s ease,color .15s ease}
    .tsc-x:hover{background:var(--tsc-row);color:var(--tsc-ink)}

    /* summary before detail: the number you are actually here for */
    .tsc-sum{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;
      padding:12px 14px;background:var(--tsc-sunk);border-bottom:1px solid var(--tsc-hair)}
    .tsc-sum-k{font-size:11px;color:var(--tsc-mut)}
    .tsc-sum-v{font:16px/1.2 var(--tsc-mono);font-weight:700;font-variant-numeric:tabular-nums;
      letter-spacing:-.02em;color:#fff}
    .tsc-sum:empty{display:none}
    .tsc-sum-r{text-align:right}
    .tsc-sum-r .tsc-sum-v{color:var(--tsc-ac-ink)}

    .tsc-list{overflow:auto;flex:1}
    .tsc-empty{display:flex;flex-direction:column;align-items:center;gap:10px;
      padding:34px 22px;text-align:center;color:var(--tsc-mut)}
    .tsc-empty b{display:block;color:var(--tsc-ink);font-size:13px;font-weight:600}
    .tsc-empty p{margin:3px 0 0;font-size:12px;max-width:26ch}
    .tsc-empty .tsc-mark{opacity:.4}

    .tsc-item{display:grid;grid-template-columns:1fr auto auto auto;align-items:center;
      gap:12px;padding:10px 14px;transition:background .15s ease}
    .tsc-item + .tsc-item{border-top:1px solid var(--tsc-hair)}
    .tsc-item:hover{background:var(--tsc-row)}
    .tsc-t{min-width:0}
    .tsc-n{display:block;font-weight:600;color:var(--tsc-ink);text-decoration:none;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .15s ease}
    .tsc-n:hover{color:var(--tsc-ac-ink);text-decoration:underline}
    .tsc-s{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:11px;
      color:var(--tsc-mut);white-space:nowrap}
    /* the printing and grade truncate first; sample count, language and the staleness
       badge hold their width, because those are the parts you scan for */
    .tsc-s>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .tsc-s>.tsc-keep{flex:none;overflow:visible;font-family:var(--tsc-mono)}
    .tsc-flag{flex:none;display:inline-flex;align-items:center;gap:3px;padding:1px 5px 1px 4px;
      border-radius:6px;background:var(--tsc-warn-tint);border:1px solid var(--tsc-warn-line);
      color:var(--tsc-warn);font:10.5px/1.5 var(--tsc-mono);font-weight:600}
    .tsc-p{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .tsc-usd{font:13px/1.25 var(--tsc-mono);font-weight:600;color:var(--tsc-ink)}
    .tsc-cad{font:11px/1.25 var(--tsc-mono);color:var(--tsc-mut)}
    .tsc-cad.tsc-nofx{color:var(--tsc-warn)}
    /* brighter than the hairlines elsewhere: an input boundary needs to read as a field */
    .tsc-q{width:54px;padding:5px 6px;border:1px solid var(--tsc-line);
      border-radius:var(--tsc-r-ctl);background:var(--tsc-inp);color:var(--tsc-ink);
      font:12px var(--tsc-mono);font-variant-numeric:tabular-nums;text-align:center;
      transition:border-color .15s ease}
    .tsc-q:hover{border-color:var(--tsc-hair-h)}
    .tsc-q:focus{border-color:var(--tsc-ac)}
    .tsc-del{display:inline-flex;border:0;background:none;cursor:pointer;
      color:var(--tsc-mut);padding:4px;border-radius:6px;
      transition:background .15s ease,color .15s ease}
    .tsc-del:hover{background:var(--tsc-err-tint);color:var(--tsc-err)}

    .tsc-foot{display:flex;gap:7px;padding:11px 12px;border-top:1px solid var(--tsc-hair)}
    .tsc-b{display:inline-flex;align-items:center;justify-content:center;gap:7px;flex:1;
      padding:9px 12px;border:1px solid var(--tsc-line);border-radius:var(--tsc-r-ctl);
      background:#17171c;color:var(--tsc-ink-2);cursor:pointer;
      font:12px/1 var(--tsc-sans);font-weight:600;white-space:nowrap;
      transition:background .15s ease,border-color .15s ease,color .15s ease}
    .tsc-b:hover:not([disabled]){border-color:var(--tsc-hair-h);color:var(--tsc-ink)}
    .tsc-b:active:not([disabled]){transform:translateY(1px)}
    .tsc-b[disabled]{opacity:.45;cursor:default}
    .tsc-b.tsc-prim[disabled]:hover{background:var(--tsc-ac)}
    .tsc-b.tsc-prim{background:var(--tsc-ac);border-color:var(--tsc-ac);color:#fff}
    .tsc-b.tsc-prim:hover{background:var(--tsc-ac-hov);border-color:var(--tsc-ac-hov);color:#fff}
    .tsc-b.tsc-danger{flex:0 0 auto;color:var(--tsc-err);padding:9px 11px}
    .tsc-b.tsc-danger:hover{background:var(--tsc-err-tint);border-color:var(--tsc-err-line);
      color:var(--tsc-err)}
    .tsc-b[data-armed="1"]{background:var(--tsc-err);border-color:var(--tsc-err);color:#17161c}

    @media (prefers-reduced-motion:reduce){
      .tsc-panel *,.tsc-root *{animation:none!important;transition:none!important}
      .tsc-chip:active:not([disabled]),.tsc-b:active,.tsc-pill:active{transform:none}
      .tsc-busy::after{width:100%;opacity:.45}
    }
  `;
  document.documentElement.appendChild(s);
}

// ---------------------------------------------------------------- combos

// Grade order, worst last. Fixed - these are the only five TCGplayer uses.
const CONDITIONS = ["Near Mint", "Lightly Played", "Moderately Played",
                    "Heavily Played", "Damaged"];

// Printing and language come from the sales data (they are per-product and there is
// no fixed list). Conditions do NOT: a condition that has not sold in the last 25
// sales still exists, and the server-side condition filter will find it. So cross the
// observed printings with all five grades rather than only what page 1 happens to show.
// Grouping by printing is what the eye needs: one heading, five grades under it,
// always in the same order, so the same grade sits in the same place on every product.
function combos(rows) {
  const groups = new Map();
  const seen = new Set();
  for (const r of rows) {
    const k = `${r.variant}|${r.language}`;
    if (!groups.has(k)) groups.set(k, { variant: r.variant, language: r.language });
    seen.add(`${r.condition}|${r.variant}|${r.language}`);
  }
  return Array.from(groups.values()).map(p => Object.assign({}, p, {
    conditions: CONDITIONS.map(condition => ({
      condition,
      recent: seen.has(`${condition}|${p.variant}|${p.language}`)
    }))
  }));
}

const label = sel => `${sel.condition}, ${sel.variant}`;

// ---------------------------------------------------------------- drawer

let badge, drawer, listBox, sumBox, pill, exportBtns = [];

function setCount(n) {
  if (!badge) return;
  badge.textContent = String(n);
  badge.dataset.zero = n ? "0" : "1";
}

const money = n =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderSummary(rows) {
  sumBox.textContent = "";
  const copies = rows.reduce((n, r) => n + (Number(r.qty) || 1), 0);
  const usd = rows.reduce((n, r) => n + parseFloat(r.avg_usd) * (Number(r.qty) || 1), 0);
  const priced = rows.filter(r => r.cad !== "");
  const cad = priced.reduce((n, r) => n + parseFloat(r.cad) * (Number(r.qty) || 1), 0);

  // Two totals, and they can cover different rows: the CAD side skips anything the FX
  // fetch missed. Say so rather than let the numbers look like they disagree.
  const missing = rows.length - priced.length;

  const left = el("div");
  left.appendChild(el("div", "tsc-sum-k",
    `${rows.length} card${rows.length === 1 ? "" : "s"}, ${copies} cop${copies === 1 ? "y" : "ies"}`));
  left.appendChild(el("div", "tsc-sum-v", money(usd) + " USD"));

  const right = el("div", "tsc-sum-r");
  right.appendChild(el("div", "tsc-sum-k", missing
    ? `Trade-in total, ${missing} row${missing === 1 ? "" : "s"} missing a rate`
    : "Trade-in total"));
  right.appendChild(el("div", "tsc-sum-v", priced.length ? money(cad) + " CAD" : "no rate"));

  sumBox.append(left, right);
}

async function renderList() {
  const res = await send({ type: "list" });
  if (!res.ok) return;
  setCount(res.count);
  listBox.textContent = "";
  // nothing to copy or export until something is in the store
  for (const b of exportBtns) b.disabled = !res.rows.length;

  if (!res.rows.length) {
    sumBox.textContent = "";
    const empty = el("div", "tsc-empty");
    empty.appendChild(mark(34));
    const copy = el("div");
    copy.appendChild(el("b", null, "Nothing collected yet"));
    copy.appendChild(el("p", null,
      "Pick a grade on any product page and it lands here, priced and ready to export."));
    empty.appendChild(copy);
    listBox.appendChild(empty);
    return;
  }

  renderSummary(res.rows);

  for (const row of res.rows) {
    const item = el("div", "tsc-item");

    const text = el("div", "tsc-t");
    const name = el("a", "tsc-n", row.name);
    name.href = row._url || "#";
    name.target = "_blank";
    name.rel = "noreferrer";
    const sub = el("div", "tsc-s");
    sub.appendChild(el("span", null, `${row.printing} · ${row.condition}`));
    if (row._language && row._language !== "English") {
      sub.appendChild(el("span", "tsc-keep", row._language));
    }
    sub.appendChild(el("span", "tsc-keep", `${row._samples || "?"} sales`));
    if (row._stale) {
      const flag = el("span", "tsc-flag");
      flag.appendChild(icon("warn", 11));
      flag.appendChild(document.createTextNode(row._oldest));
      flag.title = "Oldest sale in the average is over 60 days old.";
      sub.appendChild(flag);
    }
    text.append(name, sub);

    const price = el("div", "tsc-p");
    price.appendChild(el("div", "tsc-usd", row.avg_usd + " USD"));
    const cad = el("div", row.cad ? "tsc-cad" : "tsc-cad tsc-nofx",
      row.cad ? row.cad + " CAD" : "no rate");
    if (row._fx_rate) cad.title = `Converted at ${row._fx_rate}, fetched ${row._fx_at}`;
    price.appendChild(cad);

    const qty = el("input", "tsc-q");
    qty.type = "number";
    qty.min = "1";
    qty.step = "1";
    qty.value = String(row.qty || 1);
    qty.setAttribute("aria-label", `Copies of ${row.name} you are trading in`);
    qty.title = "How many copies you are trading in";
    qty.addEventListener("change", async () => {
      const res2 = await send({ type: "setQty", key: row.key, qty: qty.value });
      if (res2.ok) { qty.value = String(res2.qty); renderList(); }
    });

    const del = el("button", "tsc-del");
    del.type = "button";
    del.appendChild(icon("trash", 15));
    del.title = "Remove from collection";
    del.setAttribute("aria-label", `Remove ${row.name}`);
    del.addEventListener("click", async () => {
      await send({ type: "remove", key: row.key });
      renderList();
    });

    item.append(text, price, qty, del);
    listBox.appendChild(item);
  }
}

// Buttons that report their own outcome, then return to their resting label.
function flash(btn, text) {
  const keep = btn.dataset.label;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = "";
    btn.appendChild(icon(btn.dataset.icon, 15));
    btn.appendChild(document.createTextNode(keep));
  }, 1600);
}

function actionButton(cls, iconName, text) {
  const b = el("button", cls);
  b.type = "button";
  b.dataset.icon = iconName;
  b.dataset.label = text;
  b.appendChild(icon(iconName, 15));
  b.appendChild(document.createTextNode(text));
  return b;
}

function floatingUi() {
  const root = floatRoot = el("div", "tsc-root");

  drawer = el("div", "tsc-drawer");
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "Collected cards");

  const head = el("div", "tsc-dhead");
  head.appendChild(mark(17));
  head.appendChild(el("h2", null, "Collected cards"));
  const close = el("button", "tsc-x");
  close.type = "button";
  close.appendChild(icon("close", 16));
  close.setAttribute("aria-label", "Close collection");
  close.addEventListener("click", () => toggleDrawer(false));
  head.appendChild(close);

  sumBox = el("div", "tsc-sum");
  listBox = el("div", "tsc-list");

  const foot = el("div", "tsc-foot");

  const copyBtn = actionButton("tsc-b tsc-prim", "copy", "Copy for Sheets");
  copyBtn.title = "Tab separated. Pastes straight into Google Sheets or Excel.";
  copyBtn.addEventListener("click", async () => {
    const res = await send({ type: "copyText" });
    if (!res.ok) { flash(copyBtn, res.error); return; }
    try {
      await navigator.clipboard.writeText(res.text);
      flash(copyBtn, `Copied ${res.count} row${res.count === 1 ? "" : "s"}`);
    } catch (e) {
      flash(copyBtn, "Clipboard blocked");
    }
  });

  const csvBtn = actionButton("tsc-b", "download", "Export CSV");
  csvBtn.addEventListener("click", async () => {
    const res = await send({ type: "export" });
    flash(csvBtn, res.ok ? "Downloaded" : res.error);
  });

  const clearBtn = actionButton("tsc-b tsc-danger", "trash", "Clear");
  clearBtn.setAttribute("aria-label", "Clear the whole collection");
  clearBtn.addEventListener("click", async () => {
    if (clearBtn.dataset.armed !== "1") {
      clearBtn.dataset.armed = "1";
      clearBtn.textContent = "Delete all?";
      setTimeout(() => {
        if (clearBtn.dataset.armed !== "1") return;
        clearBtn.dataset.armed = "0";
        clearBtn.textContent = "";
        clearBtn.appendChild(icon("trash", 15));
        clearBtn.appendChild(document.createTextNode("Clear"));
      }, 2500);
      return;
    }
    clearBtn.dataset.armed = "0";
    clearBtn.textContent = "";
    clearBtn.appendChild(icon("trash", 15));
    clearBtn.appendChild(document.createTextNode("Clear"));
    await send({ type: "clear" });
    renderList();
  });

  exportBtns = [copyBtn, csvBtn, clearBtn];
  foot.append(copyBtn, csvBtn, clearBtn);
  drawer.append(head, sumBox, listBox, foot);

  pill = el("button", "tsc-pill");
  pill.type = "button";
  pill.setAttribute("aria-expanded", "false");
  pill.appendChild(mark(16));
  pill.appendChild(document.createTextNode("Collected"));
  badge = el("span", "tsc-badge", "0");
  badge.dataset.zero = "1";
  pill.appendChild(badge);
  pill.addEventListener("click", () => toggleDrawer(!drawer.classList.contains("tsc-open")));

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && drawer.classList.contains("tsc-open")) toggleDrawer(false);
  });

  root.append(drawer, pill);
  document.body.appendChild(root);
}

function toggleDrawer(open) {
  drawer.classList.toggle("tsc-open", open);
  pill.setAttribute("aria-expanded", String(open));
  if (open) renderList();
}

// ---------------------------------------------------------------- panel

let noteBox;

function note(text, strong) {
  noteBox.textContent = "";
  if (strong) {
    const b = el("b", null, strong);
    noteBox.append(b, document.createTextNode(" " + text));
  } else {
    noteBox.textContent = text;
  }
}

function addChip(combo, sel, box, have) {
  const chip = el("button", "tsc-chip");
  chip.type = "button";
  const txt = el("span", null, combo.condition);
  chip.appendChild(txt);

  const setState = (cls, glyph) => {
    chip.classList.remove("tsc-ok", "tsc-err", "tsc-busy");
    const old = chip.querySelector(".tsc-i");
    if (old) old.remove();
    if (cls) chip.classList.add(cls);
    if (glyph) chip.appendChild(icon(glyph, 13));
  };

  if (!combo.recent) {
    chip.classList.add("tsc-thin");
    chip.title = "No sale in the last 25. Paging deeper may still find one.";
  }
  if (have.has(`${PID}|${sel.variant}|${sel.condition}|${sel.language}`)) {
    setState("tsc-ok", "check");
    chip.title = "Collected. Click to refresh with a new pull.";
  }

  chip.addEventListener("click", async () => {
    chip.disabled = true;
    chip.setAttribute("aria-busy", "true");
    setState("tsc-busy", null);
    note(`Paging sales for ${label(sel)}.`);
    try {
      const res = await send({
        type: "collect", productId: PID, sel, meta: scrapePageMeta()
      });
      if (res.ok) {
        setState("tsc-ok", "check");
        const detail = [`${res.samples} sale${res.samples === 1 ? "" : "s"} averaged`,
          `${res.rejected} rejected`]
          .concat(res.capped ? ["stopped at the 10 page cap"] : [])
          .concat(res.stale ? ["oldest sale is over 60 days old"] : [])
          .concat(res.noFx ? ["no exchange rate, CAD left blank"] : []);
        chip.title = detail.join(". ") + ".";
        note(detail.join(", ") + ".", label(sel) + ":");
        setCount(res.count);
      } else {
        setState("tsc-err", "warn");
        chip.title = res.error;
        note(res.error + ".", label(sel) + ":");
      }
    } catch (e) {
      setState("tsc-err", "warn");
      chip.title = String(e.message || e);
      note(String(e.message || e), label(sel) + ":");
    } finally {
      chip.removeAttribute("aria-busy");
      chip.disabled = false;
      if (drawer.classList.contains("tsc-open")) renderList();
    }
  });

  box.appendChild(chip);
}

function skeleton(box) {
  box.textContent = "";
  const row = el("div", "tsc-chips");
  for (let i = 0; i < 3; i++) row.appendChild(el("div", "tsc-skel"));
  box.appendChild(row);
}

function alert_(box, text, bad) {
  box.textContent = "";
  box.appendChild(el("p", bad ? "tsc-alert tsc-bad" : "tsc-alert", text));
}

async function init() {
  panel = el("section", "tsc-panel");
  const head = el("div", "tsc-head");
  head.appendChild(mark(18));
  head.appendChild(el("h3", "tsc-title", "Sales to CSV"));
  panel.appendChild(head);
  panel.appendChild(el("p", "tsc-sub",
    "Averages the last 5 matching sales. Shipping excluded."));

  const body = el("div", "tsc-groups");
  skeleton(body);
  panel.appendChild(body);

  noteBox = el("p", "tsc-note");
  noteBox.setAttribute("role", "status");
  noteBox.setAttribute("aria-live", "polite");
  panel.appendChild(noteBox);
  mount(panel);

  let res;
  try {
    res = await send({ type: "firstPage", productId: PID });
  } catch (e) {
    alert_(body, "Could not reach the sales API: " + String(e.message || e), true);
    return;
  }
  if (!res.ok) { alert_(body, "Could not read sales: " + res.error, true); return; }
  setCount(res.count);

  if (res.loggedOut) {
    alert_(body, "Sign in to TCGplayer. Signed out, the sales feed stops at 5 rows.");
    return;
  }

  const groups = combos(res.rows);
  if (!groups.length) { alert_(body, "No recent sales on this product."); return; }

  body.textContent = "";
  const have = new Set(res.haveKeys || []);
  for (const g of groups) {
    const wrap = el("div", "tsc-grp");
    const h = el("div", "tsc-grp-h", g.variant);
    if (g.language !== "English") h.appendChild(el("em", null, g.language));
    wrap.appendChild(h);
    const chips = el("div", "tsc-chips");
    for (const c of g.conditions) {
      addChip(c, { condition: c.condition, variant: g.variant, language: g.language },
        chips, have);
    }
    wrap.appendChild(chips);
    body.appendChild(wrap);
  }
}

// last: everything above uses `let` bindings that must be initialised first
readUrl();
if (PID) start();
