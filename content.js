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
  refresh: ["M20.4 12a8.4 8.4 0 1 1-2.5-6", "M20.4 4.2v4.6h-4.6"],
  print: ["M7.4 9V3.6h9.2V9", "M7.4 17.4H5.6A1.6 1.6 0 0 1 4 15.8v-5.2A1.6 1.6 0 0 1 5.6 9h12.8a1.6 1.6 0 0 1 1.6 1.6v5.2a1.6 1.6 0 0 1-1.6 1.6h-1.8",
          "M7.4 14.4h9.2V20H7.4Z"],
  trash: ["M4.6 6.9h14.8", "M10 10.9v6", "M14 10.9v6",
          "M6.7 6.9l.8 11.9a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.8-11.9",
          "M9.5 6.9V5a1.4 1.4 0 0 1 1.4-1.4h2.2A1.4 1.4 0 0 1 14.5 5v1.9"],
  bookmark: ["M7 3.6h10a1.4 1.4 0 0 1 1.4 1.4v15.4L12 16.4 5.6 20.4V5A1.4 1.4 0 0 1 7 3.6Z"],
  folder: ["M4 7a1.6 1.6 0 0 1 1.6-1.6h4.2l2 2.4h6.6A1.6 1.6 0 0 1 20 9.4v8A1.6 1.6 0 0 1 18.4 19H5.6A1.6 1.6 0 0 1 4 17.4Z"]
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
    { x: 14, y: 72, h: 42, f: "#4a4b52" },
    { x: 49, y: 52, h: 62, f: "#8d8390" },
    { x: 84, y: 24, h: 90, f: "#a288a6" }
  ];
  for (const b of bars) {
    svg.appendChild(svgEl("rect", { x: b.x, y: b.y, width: 30, height: b.h, rx: 6, fill: b.f }));
  }
  svg.appendChild(svgEl("rect", { x: 10, y: 118, width: 108, height: 8, rx: 4,
    fill: "rgba(241,227,228,.16)" }));
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

  // This whole scrape is now the FALLBACK - the worker asks the product-details API
  // first (fetchProductMeta in background.js) and only keeps these values when that
  // call fails. Two page layouts are understood:
  //   Pokemon:            "Card Number / Rarity: 13/108 / Ultra Rare"  ->  "13/108"
  //   One Piece / Magic:  "Number: OP14-033" on its own attribute row  ->  "OP14-033"
  const text = document.body.innerText;
  const m = text.match(/Card Number\s*\/\s*Rarity:\s*(.+)/);
  const split = text.match(/^\s*Number:?\s+(\S+)\s*$/m);
  const number = m ? m[1].split(" / ")[0].trim() : (split ? split[1] : "");

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

// The panel sits under the 3M Snapshot block (2025-08 layout). Class names move
// between TCGplayer deploys, so find the block by a *snapshot* class or its visible
// "3M Snapshot" heading, then climb to the price-guide section's direct child so the
// panel lands after the whole block, not inside it. Old points-header kept as fallback.
function mountAnchor() {
  const sect = document.querySelector(".product-details__price-guide");
  let el = (sect || document).querySelector('[class*="snapshot" i]');
  if (!el && sect) {
    for (const h of sect.querySelectorAll("h2,h3,h4,span,div")) {
      if (h.children.length === 0 && /3\s*M(onth)?\s*Snapshot/i.test(h.textContent)) {
        el = h;
        break;
      }
    }
  }
  if (el && sect && sect.contains(el)) {
    while (el.parentElement !== sect) el = el.parentElement;
    return el;
  }
  return el || document.querySelector(".price-guide__points-header");
}

function mount(node) {
  const anchor = mountAnchor();
  if (anchor) { anchor.insertAdjacentElement("afterend", node); return; }
  (document.querySelector(".product-details__price-guide") || document.body).appendChild(node);
}

// TCGplayer hydrates the price-guide section after first paint. On a fast load the
// content script can mount into markup the framework then throws away, so the panel
// silently vanishes. Rather than guess at timing, watch the DOM and re-mount.
// Also catches client-side navigation between products, which never reloads the page.
let panel, floatRoot, href = "";
function keepMounted() {
  let pending = 0;
  const check = () => {
    pending = 0;
    if (location.href !== href) { href = location.href; readUrl(); rebuild(); return; }
    if (!panel) return;
    if (!panel.isConnected) { mount(panel); }
    // mounted on a fallback (body or the bare section), but the real anchor showed up
    // late. "Properly mounted" has exactly one shape - immediately after the anchor -
    // so anything else gets re-mounted the moment the anchor exists.
    else {
      const anchor = mountAnchor();
      if (anchor && panel.previousElementSibling !== anchor) mount(panel);
    }
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

// Set by floatingUi; the worker streams refresh progress/completion and the persisted
// status record, and these are where they land.
let refreshProgress = () => {};
let refreshDone = () => {};
let updateStatus = () => {};
// Pulls the persisted record on demand - a drawer opened after the run started, or
// after the worker that was running it died.
let refreshStatus = () => {};

function start() {
  href = location.href;
  style();
  floatingUi();
  keepMounted();
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(msg => {
      if (!msg) return;
      if (msg.type === "refreshProgress") refreshProgress(msg.runId, msg.done, msg.total);
      if (msg.type === "refreshDone") refreshDone(msg.runId, msg.result);
    });
  }
  // Another tab collecting, deleting or re-rating changes the same store this tab shows.
  // Without this, its badge and an open drawer sat stale until the next click here.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.refreshRun) {
        const rec = changes.refreshRun.newValue;
        updateStatus(rec, !!rec && !rec.finished);
      }
      if (changes.rows || changes.pct) {
        if (changes.rows) setCount(Object.keys(changes.rows.newValue || {}).length);
        if (drawer && drawer.classList.contains("tsc-open")) renderList();
      }
    });
  }
  if (PID) init();
}

// ---------------------------------------------------------------- style
//
// One theme, dark mauve: the panel and the drawer are the same object seen twice, and a
// near-black surface with a single mauve accent reads as ours rather than as a piece of
// TCGplayer's own chrome. Every rule is scoped under .tsc-panel / .tsc-root so nothing
// leaks into the host page.
//
// Shape rule, applied everywhere: containers 14px, controls and inputs 8px,
// chips and badges 7px. Nothing else invents its own radius, and nothing is a pill.
function style() {
  const s = document.createElement("style");
  s.textContent = `
    .tsc-panel,.tsc-root{
      --tsc-ink:#f1e3e4; --tsc-ink-2:#ccbcbc; --tsc-mut:#948a8e;
      --tsc-line:#35363c; --tsc-hair:rgba(241,227,228,.09); --tsc-hair-h:rgba(241,227,228,.16);
      --tsc-bg:#1c1d21; --tsc-sunk:#161719; --tsc-inp:#141518; --tsc-row:#25262b;
      --tsc-ac:#a288a6;
      --tsc-ac-ink:#c9b3cc;
      --tsc-ac-soft:#bb9bb0;
      --tsc-ac-hov:#b299b6;
      --tsc-ac-tint:color-mix(in srgb,var(--tsc-ac) 18%,transparent);
      --tsc-ac-line:color-mix(in srgb,var(--tsc-ac-soft) 35%,transparent);
      --tsc-warn:#d9aa5e; --tsc-warn-tint:rgba(217,170,94,.14); --tsc-warn-line:rgba(217,170,94,.32);
      --tsc-err:#e08d8d; --tsc-err-tint:rgba(224,141,141,.14); --tsc-err-line:rgba(224,141,141,.32);
      --tsc-r-box:14px; --tsc-r-ctl:8px; --tsc-r-chip:7px;
      --tsc-shadow:0 4px 16px rgba(0,0,0,.45);
      --tsc-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
      --tsc-mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
      font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;
    }
    .tsc-panel *,.tsc-root *{box-sizing:border-box}
    .tsc-panel :focus-visible,.tsc-root :focus-visible{
      outline:2px solid var(--tsc-ac);outline-offset:2px;border-radius:var(--tsc-r-ctl)}

    /* ---- in-page panel ---- */
    .tsc-panel{border:1px solid var(--tsc-hair);border-radius:var(--tsc-r-box);
      max-width:480px;padding:16px;margin:12px 0;color:var(--tsc-ink);
      background-color:var(--tsc-bg);
      background-image:radial-gradient(color-mix(in srgb,var(--tsc-ac) 6%,transparent) 1px,transparent 1.4px);
      background-size:26px 26px;
      font:13px/1.5 var(--tsc-sans);box-shadow:var(--tsc-shadow)}
    .tsc-head{display:flex;align-items:center;gap:9px;margin:0 0 3px}
    .tsc-mark{display:block;flex:none}
    .tsc-title{margin:0;font-size:14px;font-weight:700;letter-spacing:-.02em;
      color:var(--tsc-ink)}
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
      background:var(--tsc-inp);color:var(--tsc-ink-2);cursor:pointer;
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

    .tsc-skel{height:29px;width:104px;border-radius:var(--tsc-r-chip);background:#26272c;
      animation:tsc-fade 1.2s ease-in-out infinite}
    .tsc-skel:nth-child(2){width:128px;animation-delay:.15s}
    .tsc-skel:nth-child(3){width:88px;animation-delay:.3s}
    @keyframes tsc-fade{0%,100%{opacity:.55}50%{opacity:1}}

    /* the shift-click affordance, stated where the chips are rather than hidden in a
       title attribute nobody hovers */
    .tsc-hint{margin:2px 0 0;font-size:11px;color:var(--tsc-mut)}
    .tsc-hint b{font-weight:600;color:var(--tsc-ink-2)}

    .tsc-note{margin:12px 0 0;font-size:11.5px;color:var(--tsc-mut);min-height:1em}
    .tsc-note b{font-weight:600;color:var(--tsc-ink-2)}
    .tsc-alert{margin:2px 0 0;padding:10px 12px;border-radius:var(--tsc-r-ctl);
      background:var(--tsc-warn-tint);border:1px solid var(--tsc-warn-line);
      color:var(--tsc-warn);font-size:12px;font-weight:500}
    .tsc-alert.tsc-bad{background:var(--tsc-err-tint);border-color:var(--tsc-err-line);color:var(--tsc-err)}

    /* ---- floating collection ---- */
    /* bottom clears TCGplayer's circular support-chat bubble (~64px + margins),
       which owns the bottom-right corner. The pill sits directly above it. */
    .tsc-root{position:fixed;right:18px;bottom:96px;z-index:2147483000;
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
      color:#1c1d21;font:11px/1 var(--tsc-mono);font-weight:700;font-variant-numeric:tabular-nums;
      text-align:center}
    .tsc-badge[data-zero="1"]{background:#2c2d33;color:var(--tsc-mut)}

    /* undo toast: sits above the drawer, same surface language as everything else */
    .tsc-toast{display:flex;align-items:center;gap:12px;padding:10px 11px 10px 14px;
      max-width:min(436px,calc(100vw - 36px));
      background:var(--tsc-bg);border:1px solid var(--tsc-hair);border-radius:var(--tsc-r-ctl);
      box-shadow:var(--tsc-shadow);font-size:12px;color:var(--tsc-ink-2);
      animation:tsc-rise .16s ease-out;
      transition:opacity .18s ease,transform .18s ease}
    /* exit mirrors the entry: same direction, slightly longer, so the toast reads as
       sinking back where it came from instead of blinking off */
    .tsc-toast.tsc-out{opacity:0;transform:translateY(6px)}
    .tsc-toast-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tsc-undo{flex:none;border:1px solid var(--tsc-line);border-radius:var(--tsc-r-chip);
      background:var(--tsc-inp);color:var(--tsc-ac-ink);cursor:pointer;padding:5px 10px;
      font:12px/1 var(--tsc-sans);font-weight:600;
      transition:background .15s ease,border-color .15s ease}
    .tsc-undo:hover{background:var(--tsc-ac-tint);border-color:var(--tsc-ac-line)}
    .tsc-undo:active{transform:translateY(1px)}
    @keyframes tsc-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

    .tsc-drawer{width:min(560px,calc(100vw - 36px));
      max-height:min(calc(100vh - 120px),720px);
      display:none;flex-direction:column;background:var(--tsc-bg);
      border:1px solid var(--tsc-hair);border-radius:var(--tsc-r-box);
      box-shadow:0 16px 42px rgba(0,0,0,.5);overflow:hidden}
    /* entrance mirrors the toast's tsc-rise: ~160ms ease-out translate+fade. The exit
       runs the same move in reverse via .tsc-out before display goes back to none.
       Both are killed wholesale by the reduced-motion block below. */
    .tsc-drawer.tsc-open{display:flex;animation:tsc-rise .16s ease-out}
    .tsc-drawer.tsc-open.tsc-out{opacity:0;transform:translateY(6px);pointer-events:none;
      transition:opacity .16s ease-out,transform .16s ease-out}
    .tsc-dhead{display:flex;align-items:center;gap:9px;padding:12px 12px 12px 14px;
      border-bottom:1px solid var(--tsc-hair)}
    .tsc-dhead h2{flex:1;margin:0;font-size:13px;font-weight:700;letter-spacing:-.02em;
      color:var(--tsc-ink)}
    /* icon-only buttons: at least 28px square, or the click target is the icon alone */
    .tsc-x{display:inline-flex;align-items:center;justify-content:center;min-width:28px;
      min-height:28px;border:0;background:none;cursor:pointer;color:var(--tsc-mut);
      padding:4px;border-radius:6px;transition:background .15s ease,color .15s ease}
    .tsc-x:hover{background:var(--tsc-row);color:var(--tsc-ink)}

    /* summary before detail: the number you are actually here for */
    .tsc-sum{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;
      padding:12px 14px;background:var(--tsc-sunk);border-bottom:1px solid var(--tsc-hair)}
    .tsc-sum-k{font-size:11px;color:var(--tsc-mut)}
    .tsc-sum-v{font:16px/1.2 var(--tsc-mono);font-weight:700;font-variant-numeric:tabular-nums;
      letter-spacing:-.02em;color:var(--tsc-ink)}
    .tsc-sum:empty{display:none}
    .tsc-sum-r{text-align:right}
    .tsc-sum-r .tsc-sum-v{color:var(--tsc-ac-ink)}

    /* first-run rate banner: sits between the total and the controls, because it is
       the reason the total says what it says */
    .tsc-rate{padding:10px 14px;border-bottom:1px solid var(--tsc-hair);
      background:var(--tsc-warn-tint);color:var(--tsc-warn);font-size:11.5px;line-height:1.45}
    .tsc-rate[hidden]{display:none}
    .tsc-rate b{font-weight:700}

    /* tools strip: the two settings-ish actions, kept out of the primary footer */
    .tsc-tools{display:flex;flex-wrap:wrap;align-items:center;gap:7px;
      padding:9px 12px 9px 14px;border-bottom:1px solid var(--tsc-hair)}
    .tsc-tools[hidden]{display:none}
    .tsc-tools-k{font-size:11px;font-weight:500;letter-spacing:.01em;color:var(--tsc-mut)}
    .tsc-gap{flex:1}
    .tsc-mini{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;
      border:1px solid var(--tsc-line);border-radius:var(--tsc-r-chip);background:var(--tsc-inp);
      color:var(--tsc-ink-2);cursor:pointer;font:11.5px/1 var(--tsc-sans);font-weight:600;
      white-space:nowrap;transition:background .15s ease,border-color .15s ease,color .15s ease}
    .tsc-mini:hover:not([disabled]){border-color:var(--tsc-hair-h);color:var(--tsc-ink)}
    .tsc-mini:active:not([disabled]){transform:translateY(1px)}
    .tsc-mini[disabled]{opacity:.45;cursor:default}
    .tsc-mini[aria-busy="true"] .tsc-i{animation:tsc-spin 1s linear infinite}
    @keyframes tsc-spin{to{transform:rotate(360deg)}}

    /* Spinner arrows eat half a 52px box and push "100" out of view. The arrows go,
       the box gets room for three digits plus focus breathing space. */
    .tsc-pct::-webkit-outer-spin-button,.tsc-pct::-webkit-inner-spin-button,
    .tsc-q::-webkit-outer-spin-button,.tsc-q::-webkit-inner-spin-button{
      -webkit-appearance:none;margin:0}
    .tsc-pct,.tsc-q{-moz-appearance:textfield;appearance:textfield}
    .tsc-pct{width:58px;padding:5px 6px;border:1px solid var(--tsc-line);
      border-radius:var(--tsc-r-chip);background:var(--tsc-inp);color:var(--tsc-ink-2);
      font:11.5px var(--tsc-mono);font-variant-numeric:tabular-nums;text-align:center;
      transition:background .15s ease,border-color .15s ease,color .15s ease}
    .tsc-pct:hover{border-color:var(--tsc-hair-h)}
    .tsc-pct:focus{border-color:var(--tsc-ac);color:var(--tsc-ink)}
    /* a row that overrides the global percent wears the accent, so it is visible
       at a glance which lines are priced off the house rate */
    .tsc-pct[data-own="1"]{background:var(--tsc-ac-tint);border-color:var(--tsc-ac-line);
      color:var(--tsc-ac-ink)}
    /* above 100% you are paying MORE than market - legal, occasionally deliberate,
       always worth a second look, so the box turns warning-coloured */
    .tsc-pct[data-warn="1"]{background:var(--tsc-warn-tint);border-color:var(--tsc-warn-line);
      color:var(--tsc-warn)}

    /* persistent status row: where the last refresh's outcome lives after the button
       label has gone back to resting */
    .tsc-status{padding:8px 14px;border-bottom:1px solid var(--tsc-hair);
      font-size:11px;line-height:1.45;color:var(--tsc-mut)}
    .tsc-status[hidden]{display:none}
    .tsc-status.tsc-warn-t{color:var(--tsc-warn)}

    /* saved buylists: a second tools strip plus a fold-out list of snapshots */
    .tsc-name{flex:1;min-width:0;padding:5px 8px;border:1px solid var(--tsc-line);
      border-radius:var(--tsc-r-chip);background:var(--tsc-inp);color:var(--tsc-ink);
      font:12px var(--tsc-sans);transition:border-color .15s ease}
    .tsc-name:focus{border-color:var(--tsc-ac);outline:none}
    .tsc-savelist{border-bottom:1px solid var(--tsc-hair);background:var(--tsc-sunk);
      max-height:190px;overflow:auto}
    .tsc-savelist[hidden]{display:none}
    .tsc-saverow{display:flex;align-items:center;gap:9px;padding:8px 14px;font-size:12px}
    .tsc-saverow + .tsc-saverow{border-top:1px solid var(--tsc-hair)}
    .tsc-save-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
      white-space:nowrap;font-weight:600;color:var(--tsc-ink)}
    .tsc-save-m{font:11px var(--tsc-mono);color:var(--tsc-mut);white-space:nowrap}
    /* a save that failed says so in a visible line, not a placeholder that vanishes
       the moment you type */
    .tsc-form-err{flex-basis:100%;font-size:11px;font-weight:500;color:var(--tsc-err)}
    .tsc-save-empty{padding:12px 14px;font-size:11.5px;color:var(--tsc-mut)}

    .tsc-list{overflow:auto;flex:1}
    .tsc-empty{display:flex;flex-direction:column;align-items:center;gap:10px;
      padding:34px 22px;text-align:center;color:var(--tsc-mut)}
    .tsc-empty b{display:block;color:var(--tsc-ink);font-size:13px;font-weight:600}
    .tsc-empty p{margin:3px 0 0;font-size:12px;max-width:26ch}
    .tsc-empty .tsc-mark{opacity:.4}

    .tsc-item{display:grid;grid-template-columns:1fr auto auto auto auto;align-items:center;
      gap:10px;padding:10px 14px;transition:background .15s ease}
    .tsc-item + .tsc-item{border-top:1px solid var(--tsc-hair)}
    .tsc-item:hover{background:var(--tsc-row)}
    /* the row you just touched, fading back to the list over ~1.5s */
    .tsc-hit{animation:tsc-hit 1.5s ease-out}
    @keyframes tsc-hit{from{background:var(--tsc-ac-tint)}to{background:transparent}}
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
      color:var(--tsc-warn);font:11px/1.5 var(--tsc-mono);font-weight:600}
    .tsc-flag-bad{background:var(--tsc-err-tint);border-color:var(--tsc-err-line);
      color:var(--tsc-err)}
    .tsc-p{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .tsc-usd{font:13px/1.25 var(--tsc-mono);font-weight:600;color:var(--tsc-ink)}
    .tsc-cad{font:11px/1.25 var(--tsc-mono);color:var(--tsc-mut)}
    .tsc-cad.tsc-nofx{color:var(--tsc-warn)}
    /* brighter than the hairlines elsewhere: an input boundary needs to read as a field */
    .tsc-q{width:52px;padding:5px 6px;border:1px solid var(--tsc-line);
      border-radius:var(--tsc-r-ctl);background:var(--tsc-inp);color:var(--tsc-ink);
      font:12px var(--tsc-mono);font-variant-numeric:tabular-nums;text-align:center;
      transition:border-color .15s ease}
    .tsc-q:hover{border-color:var(--tsc-hair-h)}
    .tsc-q:focus{border-color:var(--tsc-ac)}
    .tsc-del{display:inline-flex;align-items:center;justify-content:center;min-width:28px;
      min-height:28px;border:0;background:none;cursor:pointer;
      color:var(--tsc-mut);padding:4px;border-radius:6px;
      transition:background .15s ease,color .15s ease}
    .tsc-del:hover{background:var(--tsc-err-tint);color:var(--tsc-err)}

    .tsc-foot{display:flex;gap:7px;padding:11px 12px;border-top:1px solid var(--tsc-hair)}
    .tsc-b{display:inline-flex;align-items:center;justify-content:center;gap:7px;flex:1;
      padding:9px 12px;border:1px solid var(--tsc-line);border-radius:var(--tsc-r-ctl);
      background:var(--tsc-inp);color:var(--tsc-ink-2);cursor:pointer;
      font:12px/1 var(--tsc-sans);font-weight:600;white-space:nowrap;
      transition:background .15s ease,border-color .15s ease,color .15s ease}
    .tsc-b:hover:not([disabled]){border-color:var(--tsc-hair-h);color:var(--tsc-ink)}
    .tsc-b:active:not([disabled]){transform:translateY(1px)}
    .tsc-b[disabled]{opacity:.45;cursor:default}
    .tsc-b.tsc-prim[disabled]:hover{background:var(--tsc-ac)}
    .tsc-b.tsc-prim{background:var(--tsc-ac);border-color:var(--tsc-ac);color:#1c1d21}
    .tsc-b.tsc-prim:hover{background:var(--tsc-ac-hov);border-color:var(--tsc-ac-hov);color:#1c1d21}
    .tsc-b.tsc-danger{flex:0 0 auto;color:var(--tsc-err);padding:9px 11px}
    .tsc-b.tsc-danger:hover{background:var(--tsc-err-tint);border-color:var(--tsc-err-line);
      color:var(--tsc-err)}
    .tsc-b[data-armed="1"]{background:var(--tsc-err);border-color:var(--tsc-err);color:#1c1d21}

    @media (prefers-reduced-motion:reduce){
      .tsc-panel *,.tsc-root *{animation:none!important;transition:none!important}
      .tsc-chip:active:not([disabled]),.tsc-b:active,.tsc-pill:active,
      .tsc-mini:active,.tsc-undo:active{transform:none}
      .tsc-busy::after{width:100%;opacity:.45}
      /* no fade, so the tint simply holds until the next render */
      .tsc-hit{background:var(--tsc-ac-tint)}
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

let badge, drawer, listBox, sumBox, toolsBox, rateBox, printBtn, globalInput, pill;
let statusBox, drawerClose;
let closeTimer = 0;      // pending drawer-close animation; cleared by a reopen
let savesBox, savesList, refreshSaves = () => {};
let lastCount = 0;   // rows currently in the buylist; gates the Save as button
let exportBtns = [];
let globalPct = 100;
let pctSet = false;      // has the house rate ever been chosen on this machine?
let pendingHit = null;   // key of the row to flash on the next render
let failedKeys = new Set();  // rows the last refresh could not re-pull

const LOW_SAMPLES = 3;   // must match the worker's constant
const STALE_DAYS = 60;

const reduced = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A row's percent is its own override when it has one, otherwise the house rate.
// undefined and "no override" are the same thing; 0 is a real (if odd) answer.
const pctFor = (row, pct) => (row._pct === undefined || row._pct === null ? pct : row._pct);
const rowPct = row => pctFor(row, globalPct);

// You cannot pay a fraction of a cent. The unit is rounded HERE, once, and every total -
// the drawer summary, the print sheet's line totals, the grand total - is built by
// multiplying the rounded figure. Rounding for display and multiplying the raw number is
// how a printed sheet ends up with lines that do not sum to its own footer.
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// What you would actually pay for one copy, to the cent. null when the FX fetch missed.
function tradeUnit(row, pct) {
  if (!row.cad) return null;
  return round2(parseFloat(row.cad) * pctFor(row, pct) / 100);
}

// The whole line: the ROUNDED unit times the copies, so unit x qty always checks out.
function tradeLine(row, pct) {
  const unit = tradeUnit(row, pct);
  return unit === null ? null : round2(unit * Math.max(1, Number(row.qty) || 1));
}

const tradeCad = row => tradeUnit(row, globalPct);
const tradeTotal = row => tradeLine(row, globalPct);

const lowSamples = row => Number(row._samples) > 0 && Number(row._samples) < LOW_SAMPLES;

// The worker clamps to 0-1000 and that clamp stays where it is: it is the only one that
// binds, because a number input's max is advisory in every browser that ships one. What
// the attribute buys is the spinner and the arrow keys refusing to walk past it. Anything
// over 100 is still allowed - a shop occasionally pays over market on purpose - but it is
// paying MORE than the card is worth, so the box says so in warning colours.
const MAX_PCT = 1000;
function markOverPct(input) {
  const n = Number(input.value);
  const over = Number.isFinite(n) && n > 100;
  input.dataset.warn = over ? "1" : "0";
  // the resting tooltip is remembered once, so dropping back under 100 restores it
  // instead of leaving the warning behind on a perfectly ordinary rate
  if (input.dataset.tip === undefined) input.dataset.tip = input.title || "";
  input.title = over
    ? `${n}% pays MORE than market value. That is allowed, but check it is what you meant.`
    : input.dataset.tip;
}

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
  const cad = round2(priced.reduce((n, r) => n + tradeTotal(r), 0));

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

// DEFAULT_PCT is 100. On a fresh install, a second machine, or after cleared storage,
// every row is therefore priced at full market and nothing said so - Print sheet would
// hand a customer a document offering them 100% of retail. Until somebody has chosen the
// house rate ONCE, this banner sits above the list and Print is refused.
function renderRateBanner(rowCount) {
  if (!rateBox) return;
  rateBox.textContent = "";
  const show = !pctSet && rowCount > 0;
  rateBox.hidden = !show;
  if (printBtn) {
    printBtn.disabled = !pctSet;
    printBtn.title = pctSet
      ? "Open a clean, customer-facing sheet ready to print."
      : "Set your trade-in rate before printing a customer-facing sheet.";
  }
  if (!show) return;
  const b = el("b", null, "Set your trade-in rate.");
  rateBox.append(b, document.createTextNode(
    ` Every row is priced at ${globalPct}% of market until you do, and printing is off.`));
}

async function renderList() {
  const res = await send({ type: "list" });
  if (!res.ok) return;
  globalPct = res.pct;
  pctSet = !!res.pctSet;
  if (globalInput && document.activeElement !== globalInput) {
    globalInput.value = String(globalPct);
    markOverPct(globalInput);
  }
  setCount(res.count);
  toolsBox.hidden = !res.rows.length;
  lastCount = res.rows.length;
  refreshSaves();
  renderRateBanner(res.rows.length);
  listBox.textContent = "";
  let hitRow = null;
  // nothing to copy or export until something is in the store
  for (const b of exportBtns) b.disabled = !res.rows.length;

  if (!res.rows.length) {
    sumBox.textContent = "";
    const empty = el("div", "tsc-empty");
    empty.appendChild(mark(34));
    const copy = el("div");
    copy.appendChild(el("b", null, "Buylist is empty"));
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
    // no href at all when the source URL is missing: an href="#" link scrolls the page
    // to nowhere and lies to assistive tech about being navigable
    if (row._url) {
      name.href = row._url;
      name.target = "_blank";
      name.rel = "noreferrer";
    }
    const sub = el("div", "tsc-s");
    sub.appendChild(el("span", null, `${row.printing} · ${row.condition}`));
    if (row._language && row._language !== "English") {
      sub.appendChild(el("span", "tsc-keep", row._language));
    }
    // Sample count is a warning, not a footnote. One sale is one person's opinion of
    // what a $400 card is worth, and a title attribute nobody hovers is not a signal.
    if (lowSamples(row)) {
      const thin = el("span", "tsc-flag");
      thin.appendChild(icon("warn", 11));
      thin.appendChild(document.createTextNode(
        `${row._samples} sale${row._samples === 1 ? "" : "s"}`));
      thin.title = `Averaged from only ${row._samples} sale`
        + `${row._samples === 1 ? "" : "s"}. Treat this price as a guess.`;
      sub.appendChild(thin);
    } else {
      sub.appendChild(el("span", "tsc-keep", `${row._samples || "?"} sales`));
    }
    if (failedKeys.has(row.key)) {
      const bad = el("span", "tsc-flag tsc-flag-bad");
      bad.appendChild(icon("warn", 11));
      bad.appendChild(document.createTextNode("not refreshed"));
      bad.title = "The last Refresh prices run could not re-pull this row. "
        + "Its price is whatever it was before.";
      sub.appendChild(bad);
    }
    // The set/number heuristics on the product page failed for this row. Same surface
    // as the other trust flags: a wrong set on a customer-facing sheet is a dispute.
    if (row._meta_warn) {
      const guess = el("span", "tsc-flag");
      guess.appendChild(icon("warn", 11));
      guess.appendChild(document.createTextNode("check set/no."));
      guess.title = "The set or card number could not be read cleanly from the product "
        + "page. Check both before this row goes on a customer-facing sheet.";
      sub.appendChild(guess);
    }
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
    const paid = tradeCad(row);
    const cad = el("div", row.cad ? "tsc-cad" : "tsc-cad tsc-nofx",
      paid === null ? "no rate" : money(paid) + " CAD");
    if (row._fx_rate) {
      cad.title = `${row.cad} CAD market at ${rowPct(row)}%. `
        + `Converted at ${row._fx_rate}`
        + (row._fx_date ? ` (rate dated ${row._fx_date}` +
            (row._fx_src ? `, ${row._fx_src}` : "") + ")" : "")
        + `, fetched ${row._fx_at}`
        + (row._fx_stale ? ". The last refresh could not reach the rate service, "
          + "so this is the previous rate." : "");
    }
    price.appendChild(cad);

    // Per-row trade-in percent. Blank it to fall back to the house rate.
    const pct = el("input", "tsc-pct");
    pct.type = "number";
    pct.min = "0";
    pct.max = String(MAX_PCT);
    pct.step = "1";
    pct.value = String(rowPct(row));
    pct.dataset.own = row._pct === undefined || row._pct === null ? "0" : "1";
    pct.setAttribute("aria-label", `Trade-in percent for ${row.name}`);
    pct.title = "Trade-in percent for this row. Clear it to follow the rate above.";
    markOverPct(pct);
    pct.addEventListener("input", () => markOverPct(pct));
    pct.addEventListener("change", async () => {
      const res2 = await send({ type: "setPct", key: row.key, pct: pct.value.trim() });
      if (res2.ok) { pendingHit = row.key; renderList(); }
    });

    const qty = el("input", "tsc-q");
    qty.type = "number";
    qty.min = "1";
    qty.step = "1";
    qty.value = String(row.qty || 1);
    qty.setAttribute("aria-label", `Copies of ${row.name} you are trading in`);
    qty.title = "How many copies you are trading in";
    qty.addEventListener("change", async () => {
      const res2 = await send({ type: "setQty", key: row.key, qty: qty.value });
      if (res2.ok) { qty.value = String(res2.qty); pendingHit = row.key; renderList(); }
    });

    const del = el("button", "tsc-del");
    del.type = "button";
    del.appendChild(icon("trash", 15));
    del.title = "Remove from buylist";
    del.setAttribute("aria-label", `Remove ${row.name}`);
    del.addEventListener("click", async () => {
      // Disabled for the round trip: a second click on an already-removed row is a
      // no-op, and a no-op toast must never take the place of the live undo.
      del.disabled = true;
      const res2 = await send({ type: "remove", key: row.key });
      renderList();
      if (res2.ok) undoToast(`Removed ${row.name}`, res2.prev, res2.keys);
    });

    item.append(text, price, pct, qty, del);
    if (pendingHit === row.key) { item.classList.add("tsc-hit"); hitRow = item; }
    listBox.appendChild(item);
  }

  pendingHit = null;
  // scrollIntoView after the list is built, so the row is at its final offset
  if (hitRow) {
    hitRow.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" });
  }
}

// ---------------------------------------------------------------- undo

// One toast at a time. `prev` is the store as it was before the destructive action and
// `keys` names exactly what that action removed - the worker puts back only those, and
// only where nothing newer has taken their place. Undo never deletes.
let toastEl = null, toastTimer = 0;

// Undo is allowed to be partial: a row that came back on its own inside the five seconds
// is left exactly as it is, and the snapshot's older copy - with the qty and per-row
// percent you had typed - is dropped. Throwing that response away meant "clear,
// re-collect one card, Undo" silently lost that row's edits with no sign at all.
// Returns null when the undo was total, which is the ordinary case and needs no words.
function undoOutcome(res) {
  if (!res || !res.ok || !res.kept) return null;
  return `Restored ${res.restored} row${res.restored === 1 ? "" : "s"}`
    + ` · ${res.kept} left as ${res.kept === 1 ? "it was" : "they were"}`;
}

// `override` swaps the undo message: removals restore the deleted keys, but undoing a
// buylist LOAD must put back exactly what was showing, so it replaces wholesale.
function undoToast(text, prev, keys, override) {
  if (toastEl) toastEl.remove();
  clearTimeout(toastTimer);

  const t = toastEl = el("div", "tsc-toast");
  t.setAttribute("role", "status");
  t.appendChild(el("span", "tsc-toast-t", text));

  const btn = el("button", "tsc-undo", "Undo");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    dismissToast(t);
    const res = await send(override || { type: "restore", store: prev, keys });
    renderList();
    const outcome = undoOutcome(res);
    if (outcome) infoToast(outcome);
  });
  t.appendChild(btn);

  floatRoot.insertBefore(t, floatRoot.firstChild);
  toastTimer = setTimeout(() => dismissToast(t), 5000);
}

// Same surface, no button: the outcome of an undo that could not do all of it.
function infoToast(text) {
  if (toastEl) toastEl.remove();
  clearTimeout(toastTimer);
  const t = toastEl = el("div", "tsc-toast");
  t.setAttribute("role", "status");
  t.appendChild(el("span", "tsc-toast-t", text));
  floatRoot.insertBefore(t, floatRoot.firstChild);
  toastTimer = setTimeout(() => dismissToast(t), 3000);
}

function dismissToast(t) {
  clearTimeout(toastTimer);
  // fade, then remove: the class transition runs .18s; the timeout gives it room.
  // Under reduced motion the transition is disabled globally, so the class change is
  // invisible and the removal lands a beat later - still correct, just not animated.
  t.classList.add("tsc-out");
  setTimeout(() => {
    t.remove();
    if (toastEl === t) toastEl = null;
  }, 200);
}

// ---------------------------------------------------------------- print sheet

const esc = s => String(s === null || s === undefined ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A customer-facing document, so it is light and boring on purpose: the drawer's dark
// mauve chrome is our tool, not something to hand across a counter. Written into a blank
// window rather than fetched from a template - no bundler, no extra file, no network.
function printDoc(rows, housePct) {
  const lines = rows.map(r => {
    const qty = Math.max(1, Number(r.qty) || 1);
    // ONE rounding, and the line total is built from the rounded unit. Line totals that
    // do not add up to the footer are the fastest way to lose an argument at a counter.
    return {
      name: r.name, set: r.set, printing: r.printing, condition: r.condition,
      qty, pct: pctFor(r, housePct),
      unit: tradeUnit(r, housePct), total: tradeLine(r, housePct)
    };
  });
  const grand = round2(lines.reduce((n, l) => n + (l.total || 0), 0));
  const copies = lines.reduce((n, l) => n + l.qty, 0);
  const missing = lines.filter(l => l.total === null).length;
  const dash = "&#8212;";

  const body = lines.map(l => `<tr>
      <td>${esc(l.name)}</td><td>${esc(l.set)}</td><td>${esc(l.printing)}</td>
      <td>${esc(l.condition)}</td><td class="n">${l.qty}</td>
      <td class="n">${l.pct}%</td>
      <td class="n">${l.unit === null ? dash : money(l.unit)}</td>
      <td class="n">${l.total === null ? dash : money(l.total)}</td>
    </tr>`).join("");

  // Everything the sheet was priced off, stated on the sheet. The rows persist across
  // days, each carrying its own rate, so a collection built over a week sums a total
  // across several exchange rates - the footer is where that stops being invisible.
  const notes = [];
  const overrides = rows.filter(r => r._pct !== undefined && r._pct !== null).length;
  notes.push(`Priced at ${housePct}% of market value`
    + (overrides
      ? `, except ${overrides} line${overrides === 1 ? "" : "s"} at `
        + `${overrides === 1 ? "its" : "their"} own rate (see the % column)`
      : "") + ".");

  const fx = new Map();
  for (const r of rows) {
    if (!r._fx_rate) continue;
    const when = r._fx_date || (r._fx_at || "").slice(0, 10);
    fx.set(`${r._fx_rate}|${when}`, { rate: r._fx_rate, when, src: r._fx_src || "" });
  }
  const fxList = Array.from(fx.values());
  if (fxList.length === 1) {
    notes.push(`Converted from USD at ${fxList[0].rate}`
      + (fxList[0].when ? `, rate dated ${fxList[0].when}` : "") + ".");
  } else if (fxList.length > 1) {
    notes.push(`Converted from USD at ${fxList.length} different rates: `
      + fxList.map(f => `${f.rate}${f.when ? ` (${f.when})` : ""}`).join(", ")
      + ". Refresh prices to put every line on today's rate.");
  }

  const dates = rows.map(r => r._oldest).filter(Boolean).sort();
  if (dates.length) {
    notes.push(dates[0] === dates[dates.length - 1]
      ? `Sales data back to ${dates[0]}.`
      : `Oldest sale used per line falls between ${dates[0]} and ${dates[dates.length - 1]}.`);
  }

  const thin = rows.filter(lowSamples).length;
  const stale = rows.filter(r => r._stale).length;
  if (thin || stale) {
    notes.push([
      thin ? `${thin} line${thin === 1 ? "" : "s"} averaged fewer than ${LOW_SAMPLES} sales`
        : null,
      stale ? `${stale} line${stale === 1 ? "" : "s"} rest${stale === 1 ? "s" : ""} on `
        + `sales over ${STALE_DAYS} days old` : null
    ].filter(Boolean).join("; ") + ".");
  }
  if (missing) {
    notes.push(`${missing} line${missing === 1 ? "" : "s"} had no exchange rate and `
      + `${missing === 1 ? "is" : "are"} excluded from the total.`);
  }

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Trade-in sheet ${new Date().toISOString().slice(0, 10)}</title>
<style>
  :root{--ac:#a288a6;--ink:#1c1d21;--mut:#7d7377;--line:#e8dfe0}
  *{box-sizing:border-box}
  body{margin:0;padding:34px 30px;color:var(--ink);background:#fff;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
  header{display:flex;align-items:baseline;gap:10px;margin:0 0 18px}
  h1{margin:0;font-size:17px;font-weight:700;letter-spacing:-.02em}
  .date{font-size:11.5px;color:var(--mut)}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--mut);
    padding:0 8px 7px;border-bottom:1px solid var(--line)}
  td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
  td:first-child{font-weight:600}
  .n{text-align:right;white-space:nowrap;
    font-family:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace}
  th.n{text-align:right}
  tfoot td{border-bottom:0;border-top:2px solid var(--ink);font-weight:700;padding-top:11px}
  tfoot .n{font-size:15px}
  .notes{margin:14px 0 0;padding:0;list-style:none;font-size:11.5px;color:var(--mut)}
  .notes li{margin:0 0 3px}
  @media print{body{padding:0}thead{display:table-header-group}}
</style></head><body>
<header><h1>Trade-in sheet</h1>
  <span class="date">${new Date().toLocaleDateString("en-CA")} &#183; ${rows.length} card${rows.length === 1 ? "" : "s"}, ${copies} cop${copies === 1 ? "y" : "ies"} &#183; ${housePct}% of market</span>
</header>
<table><thead><tr>
  <th>Card</th><th>Set</th><th>Printing</th><th>Condition</th>
  <th class="n">Qty</th><th class="n">%</th><th class="n">Unit CAD</th><th class="n">Line total</th>
</tr></thead><tbody>${body}</tbody>
<tfoot><tr><td colspan="7">Total offer</td><td class="n">${money(grand)}</td></tr></tfoot></table>
<ul class="notes">${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
</body></html>`;
}

async function openPrintSheet() {
  const res = await send({ type: "list" });
  if (!res.ok || !res.rows.length) return "nothing to print";
  // The default house rate is 100%. Printing before anybody has chosen one hands a
  // customer a signed offer at full retail, so this is a block, not a nudge.
  if (!res.pctSet) return "set the rate first";
  globalPct = res.pct;
  pctSet = true;
  // A Blob URL, not document.write: writing into an open document leaves the new window
  // with no real load event to wait on, which is why printing used to fire on a guessed
  // 200ms timer and could catch the sheet mid-parse - a customer-facing document printed
  // without its own stylesheet. A blob is a genuine navigation, so `load` means loaded.
  const url = URL.createObjectURL(
    new Blob([printDoc(res.rows, res.pct)], { type: "text/html;charset=utf-8" }));
  const w = window.open(url, "_blank");
  if (!w) { URL.revokeObjectURL(url); return "popup blocked"; }

  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    try { w.focus(); w.print(); } catch (e) { /* user can still print manually */ }
    // revoke only after the print dialog has the document; doing it any earlier can
    // pull the URL out from under a window still fetching it
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  try {
    if (w.document && w.document.readyState === "complete") fire();
    else w.addEventListener("load", fire, { once: true });
  } catch (e) {
    // the popup blocker handed back a window we cannot touch: fall back to the old
    // guess rather than never printing at all
    setTimeout(fire, 400);
  }
  return null;
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

function miniLabel(btn, iconName, text) {
  btn.textContent = "";
  btn.appendChild(icon(iconName, 13));
  btn.appendChild(document.createTextNode(text));
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
  drawer.setAttribute("aria-label", "Buylist");

  const head = el("div", "tsc-dhead");
  head.appendChild(mark(17));
  head.appendChild(el("h2", null, "Buylist"));
  const close = drawerClose = el("button", "tsc-x");
  close.type = "button";
  close.appendChild(icon("close", 16));
  close.setAttribute("aria-label", "Close buylist");
  close.addEventListener("click", () => toggleDrawer(false));
  head.appendChild(close);

  sumBox = el("div", "tsc-sum");
  rateBox = el("div", "tsc-rate");
  rateBox.hidden = true;

  // Where a refresh says what it did, and keeps saying it. role=status so a screen
  // reader hears the outcome without the user hunting for a button label that has
  // already reverted.
  statusBox = el("div", "tsc-status");
  statusBox.hidden = true;
  statusBox.setAttribute("role", "status");
  statusBox.setAttribute("aria-live", "polite");

  // ---- tools strip: house rate, refresh all, print
  toolsBox = el("div", "tsc-tools");
  toolsBox.hidden = true;
  toolsBox.appendChild(el("span", "tsc-tools-k", "Trade-in rate"));
  globalInput = el("input", "tsc-pct");
  globalInput.type = "number";
  globalInput.min = "0";
  globalInput.max = String(MAX_PCT);
  globalInput.step = "1";
  globalInput.value = String(globalPct);
  globalInput.setAttribute("aria-label", "Trade-in percent for every row without its own");
  globalInput.title = "Applies to every row that has no percent of its own.";
  markOverPct(globalInput);
  globalInput.addEventListener("input", () => markOverPct(globalInput));
  globalInput.addEventListener("change", async () => {
    const res = await send({ type: "setGlobalPct", pct: globalInput.value.trim() });
    if (!res.ok) return;
    // Blanking the box is refused by the worker, so put the live rate back rather than
    // leaving an empty field that disagrees with what every row is priced at.
    globalInput.value = String(res.pct);
    markOverPct(globalInput);
    pctSet = !!res.pctSet;
    renderList();
  });
  toolsBox.appendChild(globalInput);
  toolsBox.appendChild(el("span", "tsc-gap"));

  const refreshBtn = el("button", "tsc-mini");
  refreshBtn.type = "button";
  refreshBtn.appendChild(icon("refresh", 13));
  refreshBtn.appendChild(document.createTextNode("Refresh prices"));
  refreshBtn.title = "Re-pull every collected row at today's rate.";
  const REFRESH_LABEL = "Refresh prices";
  const REFRESH_TIP = "Re-pull every collected row at today's rate.";
  let refreshRevert = 0;
  let liveRun = null;   // id of the run this drawer believes is in flight, or null

  // The drawer NEVER learns the outcome from the sendMessage response any more. An MV3
  // service worker can be torn down mid-run, and a 50-row refresh is 50 sequential paging
  // runs - long enough that the response callback frequently died with it, at which point
  // 40 successful rows were reported as "Refresh failed" and the failedKeys, the entire
  // point of the run, went with it. The worker answers { started: true } straight away and
  // writes a record per row; this side is driven by the broadcasts and, when the broadcast
  // never arrives, by that persisted record. Partial success reads as partial success.
  const setBusyLabel = (done, total) => {
    miniLabel(refreshBtn, "close",
      total ? `Cancel (${done}/${total})` : "Cancel");
    refreshBtn.title = "Stop the refresh. Rows already done keep their new prices.";
    refreshBtn.setAttribute("aria-busy", "true");
  };

  const restLabel = () => {
    refreshBtn.removeAttribute("aria-busy");
    miniLabel(refreshBtn, "refresh", REFRESH_LABEL);
    refreshBtn.title = REFRESH_TIP;
  };

  // One sentence for a finished run, built from the persisted record so it says the same
  // thing whether it came from a broadcast, a reopened drawer or another tab entirely.
  const outcomeOf = rec => {
    if (!rec) return null;
    if (rec.cancelled) {
      const left = Math.max(0, (rec.total || 0) - (rec.done || 0));
      return { text: `Stopped after ${rec.refreshed} row${rec.refreshed === 1 ? "" : "s"}`
        + (left ? `, ${left} left` : ""), warn: true };
    }
    // Died mid-run: the record was never marked finished and nothing is running now.
    if (!rec.finished) {
      return { text: `Interrupted after ${rec.refreshed} of ${rec.total} row`
        + `${rec.total === 1 ? "" : "s"}. Those ${rec.refreshed} kept their new prices; `
        + "run it again to finish the rest.", warn: true };
    }
    if (rec.failed) {
      return { text: `${rec.refreshed} refreshed, ${rec.failed} could not be re-pulled `
        + "and are flagged in the list below.", warn: true };
    }
    if (rec.fxFailed) {
      return { text: `${rec.refreshed} refreshed, but the exchange-rate lookup failed - `
        + "CAD figures are on the previous rate.", warn: true };
    }
    if (rec.skipped) {
      return { text: `${rec.refreshed} refreshed, ${rec.skipped} row`
        + `${rec.skipped === 1 ? " was" : "s were"} removed from TCGplayer.`, warn: true };
    }
    return { text: `Refreshed ${rec.refreshed} row${rec.refreshed === 1 ? "" : "s"} at `
      + "today's prices and rate.", warn: false };
  };

  // The status row outlives the button label. A refresh outcome that lived only in a
  // 4-second button label was gone before the user had finished reading the list it
  // was describing.
  const showStatus = (rec, running) => {
    if (!statusBox) return;
    if (!rec) { statusBox.hidden = true; statusBox.textContent = ""; return; }
    if (running) {
      statusBox.hidden = false;
      statusBox.classList.remove("tsc-warn-t");
      statusBox.textContent =
        `Refreshing prices: ${rec.done} of ${rec.total} done. Click Cancel to stop.`;
      return;
    }
    const out = outcomeOf(rec);
    if (!out) { statusBox.hidden = true; return; }
    statusBox.hidden = false;
    statusBox.classList.toggle("tsc-warn-t", out.warn);
    statusBox.textContent = `Last refresh · ${out.text}`;
  };

  // Adopt a record: flags, list, button and status row all follow from it.
  const adopt = (rec, running) => {
    if (!rec) return;
    failedKeys = new Set(rec.failedKeys || []);
    if (running) {
      liveRun = rec.id;
      setBusyLabel(rec.done, rec.total);
      showStatus(rec, true);
      note(`Refreshing prices: ${rec.done} of ${rec.total} done. Click Cancel to stop.`);
      return;
    }
    liveRun = null;
    clearTimeout(refreshRevert);
    const out = outcomeOf(rec);
    showStatus(rec, false);
    if (out) {
      note(out.text);
      miniLabel(refreshBtn, "refresh",
        rec.cancelled ? "Stopped" : out.warn ? "Partly done" : "Refreshed");
      refreshBtn.removeAttribute("aria-busy");
      // The label always finds its way home; the status row keeps the detail.
      refreshRevert = setTimeout(restLabel, 4000);
    } else {
      restLabel();
    }
    renderList();
  };

  // Ask the worker where the latest run stands. Called on every drawer open, so a drawer
  // opened after the worker died still shows what that run managed to do.
  refreshStatus = async () => {
    try {
      const res = await send({ type: "refreshStatus" });
      if (res && res.ok && res.record) adopt(res.record, !!res.running);
    } catch (e) { /* worker asleep; the next broadcast or open will do it */ }
  };

  // Streamed position, per row. runId-gated: a broadcast from a run this drawer did not
  // start (or from one already finished) must not repaint a live label.
  refreshProgress = (runId, done, total) => {
    if (liveRun && runId !== liveRun) return;
    liveRun = runId;
    setBusyLabel(done, total);
    showStatus({ done, total }, true);
    note(`Refreshing prices: ${done} of ${total} done. Click Cancel to stop.`);
  };

  refreshDone = (runId, result) => {
    if (liveRun && runId !== liveRun) return;
    adopt(Object.assign({ id: runId, finished: true }, result), false);
  };

  // chrome.storage.onChanged, i.e. a run started in ANOTHER tab. Same treatment: this
  // drawer shows the same store, so it shows the same run.
  updateStatus = (rec, running) => {
    if (!statusBox) return;
    if (liveRun && rec && rec.id !== liveRun) return;
    adopt(rec, running);
  };

  refreshBtn.addEventListener("click", async () => {
    if (liveRun) { send({ type: "cancelRefresh", runId: liveRun }); return; }

    clearTimeout(refreshRevert);
    failedKeys = new Set();
    setBusyLabel(0, 0);
    note("Refreshing prices.");

    let res;
    try {
      res = await send({ type: "refreshAll" });
    } catch (e) {
      res = null;
    }
    // A second refresh while one is already running is refused rather than interleaved.
    if (res && res.busy) {
      liveRun = res.runId;
      note("A refresh is already running. This button will cancel it.");
      refreshStatus();
      return;
    }
    if (!res || !res.ok) {
      restLabel();
      if (statusBox) {
        statusBox.hidden = false;
        statusBox.classList.add("tsc-warn-t");
        statusBox.textContent = "Last refresh · could not be started. "
          + "Reload the page and try again.";
      }
      note("Refresh could not be started.");
      return;
    }
    liveRun = res.runId;
    // Everything from here arrives as a broadcast or, if the worker dies first, from
    // the persisted record the next time this drawer opens.
  });

  printBtn = el("button", "tsc-mini");
  printBtn.type = "button";
  printBtn.appendChild(icon("print", 13));
  printBtn.appendChild(document.createTextNode("Print sheet"));
  printBtn.title = "Open a clean, customer-facing sheet ready to print.";
  printBtn.addEventListener("click", async () => {
    const err = await openPrintSheet();
    if (err) {
      miniLabel(printBtn, "print", err);
      setTimeout(() => miniLabel(printBtn, "print", "Print sheet"), 1800);
    }
  });

  toolsBox.append(refreshBtn, printBtn);

  // ---- saved buylists strip: name the current buylist and keep it, or bring one back.
  // Saving is a snapshot; loading replaces the working buylist (with an Undo).
  savesBox = el("div", "tsc-tools");
  savesList = el("div", "tsc-savelist");
  savesList.hidden = true;

  const savesIdle = () => {
    savesBox.textContent = "";
    savesBox.appendChild(el("span", "tsc-tools-k", "Saved buylists"));
    savesBox.appendChild(el("span", "tsc-gap"));
    const saveBtn = el("button", "tsc-mini");
    saveBtn.type = "button";
    saveBtn.appendChild(icon("bookmark", 13));
    saveBtn.appendChild(document.createTextNode("Save as"));
    saveBtn.disabled = !lastCount;
    saveBtn.title = lastCount
      ? "Snapshot the current buylist under a name."
      : "Collect something first.";
    saveBtn.addEventListener("click", () => savesNaming());
    const loadBtn = el("button", "tsc-mini");
    loadBtn.type = "button";
    loadBtn.appendChild(icon("folder", 13));
    loadBtn.appendChild(document.createTextNode("Load"));
    loadBtn.title = "Show saved buylists.";
    loadBtn.setAttribute("aria-expanded", String(!savesList.hidden));
    loadBtn.addEventListener("click", async () => {
      savesList.hidden = !savesList.hidden;
      loadBtn.setAttribute("aria-expanded", String(!savesList.hidden));
      if (!savesList.hidden) renderSaves();
    });
    savesBox.append(saveBtn, loadBtn);
  };

  const savesNaming = () => {
    savesBox.textContent = "";
    const name = el("input", "tsc-name");
    name.type = "text";
    name.maxLength = 60;
    name.value = `Buylist ${new Date().toLocaleDateString("en-CA")}`;
    name.setAttribute("aria-label", "Name for this buylist");
    const ok = el("button", "tsc-mini");
    ok.type = "button";
    ok.appendChild(icon("bookmark", 13));
    ok.appendChild(document.createTextNode("Save"));
    const cancel = el("button", "tsc-mini");
    cancel.type = "button";
    cancel.appendChild(icon("close", 13));
    cancel.appendChild(document.createTextNode("Cancel"));
    // A failed save used to blank the box and put the reason in the placeholder - which
    // meant the reason vanished the instant the user typed the first character of a fix,
    // and the name they had written was gone too. The reason gets its own line, the
    // typing survives, and role=alert says it out loud.
    const err = el("div", "tsc-form-err");
    err.setAttribute("role", "alert");
    err.hidden = true;
    const commit = async () => {
      const res = await send({ type: "saveAs", name: name.value });
      if (!res.ok) {
        err.hidden = false;
        err.textContent = res.error;
        name.focus();
        name.select();
        return;
      }
      savesIdle();
      renderSaves();
      infoToast(res.replaced
        ? `Replaced "${res.name}" (${res.count} card${res.count === 1 ? "" : "s"})`
        : `Saved "${res.name}" (${res.count} card${res.count === 1 ? "" : "s"})`);
    };
    ok.addEventListener("click", commit);
    // typing is an attempt to fix it, so the complaint stands down
    name.addEventListener("input", () => { err.hidden = true; });
    name.addEventListener("keydown", e => {
      if (e.key === "Enter") commit();
      // swallow it: Escape here backs out of naming, not out of the whole drawer
      if (e.key === "Escape") { e.stopPropagation(); savesIdle(); }
    });
    cancel.addEventListener("click", () => savesIdle());
    savesBox.append(name, ok, cancel, err);
    name.focus();
    name.select();
  };

  const renderSaves = async () => {
    const res = await send({ type: "listSaved" });
    if (!res.ok) return;
    savesList.textContent = "";
    if (!res.saves.length) {
      savesList.appendChild(el("div", "tsc-save-empty",
        "No saved buylists yet. Save as keeps the current one under a name."));
      return;
    }
    for (const s of res.saves) {
      const row = el("div", "tsc-saverow");
      row.appendChild(el("span", "tsc-save-n", s.name));
      row.appendChild(el("span", "tsc-save-m",
        `${s.count} card${s.count === 1 ? "" : "s"} · ${String(s.at).slice(0, 10)}`));
      const load = el("button", "tsc-mini");
      load.type = "button";
      load.appendChild(icon("folder", 13));
      load.appendChild(document.createTextNode("Load"));
      load.title = "Replace the current buylist with this one. Undo brings the current one back.";
      load.addEventListener("click", async () => {
        const r = await send({ type: "loadSaved", name: s.name });
        if (!r.ok) { infoToast(r.error); return; }
        savesList.hidden = true;
        renderList();
        undoToast(`Loaded "${r.name}"`, null, null, { type: "replaceStore", store: r.prev });
      });
      const del = el("button", "tsc-del");
      del.type = "button";
      del.appendChild(icon("trash", 14));
      del.title = `Delete the saved buylist "${s.name}"`;
      del.setAttribute("aria-label", `Delete saved buylist ${s.name}`);
      // same two-step arming as Clear: first click asks, second click deletes
      del.addEventListener("click", async () => {
        if (del.dataset.armed !== "1") {
          del.dataset.armed = "1";
          del.textContent = "Delete?";
          setTimeout(() => {
            if (del.dataset.armed !== "1" || !del.isConnected) return;
            del.dataset.armed = "0";
            del.textContent = "";
            del.appendChild(icon("trash", 14));
          }, 2500);
          return;
        }
        const r = await send({ type: "deleteSaved", name: s.name });
        if (r.ok) renderSaves();
      });
      row.append(load, del);
      savesList.appendChild(row);
    }
  };
  savesIdle();
  refreshSaves = () => {
    // never rebuild the strip out from under a half-typed name
    if (savesBox.querySelector(".tsc-name")) return;
    savesIdle();
    if (!savesList.hidden) renderSaves();
  };

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
  csvBtn.title = "A .csv file of every collected row, with the trade-in columns.";
  csvBtn.addEventListener("click", async () => {
    // The worker builds the text; the download happens HERE. A service worker has no
    // URL.createObjectURL, which is why this used to be a data: URL - the whole sheet
    // percent-encoded into a URL, truncated by length limits on big buylists and
    // needing the "downloads" permission to hand to chrome.downloads. A Blob URL from
    // the page has neither problem and needs no permission at all.
    const res = await send({ type: "csvText" });
    if (!res.ok) { flash(csvBtn, res.error); return; }
    let url = "";
    try {
      url = URL.createObjectURL(new Blob([res.text], { type: "text/csv;charset=utf-8" }));
      const a = el("a");
      a.href = url;
      a.download = res.filename;
      a.rel = "noreferrer";
      // must be in the document for the click to count as a user-initiated download
      document.body.appendChild(a);
      a.click();
      a.remove();
      flash(csvBtn, `Downloaded ${res.count} row${res.count === 1 ? "" : "s"}`);
    } catch (e) {
      flash(csvBtn, "Download blocked");
    } finally {
      // long enough for the browser to have taken the bytes, short enough not to leak
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  });

  const clearBtn = actionButton("tsc-b tsc-danger", "trash", "Clear");
  clearBtn.setAttribute("aria-label", "Clear the whole buylist");
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
    const res = await send({ type: "clear" });
    renderList();
    if (res.ok && res.cleared) {
      undoToast(`Cleared ${res.cleared} row${res.cleared === 1 ? "" : "s"}`,
        res.prev, res.keys);
    }
  });

  exportBtns = [copyBtn, csvBtn, clearBtn];
  foot.append(copyBtn, csvBtn, clearBtn);
  drawer.append(head, sumBox, rateBox, toolsBox, statusBox, savesBox, savesList,
    listBox, foot);

  pill = el("button", "tsc-pill");
  pill.type = "button";
  pill.setAttribute("aria-expanded", "false");
  pill.appendChild(mark(16));
  pill.appendChild(document.createTextNode("Buylist"));
  badge = el("span", "tsc-badge", "0");
  badge.dataset.zero = "1";
  pill.appendChild(badge);
  pill.addEventListener("click", () => toggleDrawer(!drawer.classList.contains("tsc-open")));

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && drawer.classList.contains("tsc-open")) toggleDrawer(false);
    trapTab(e);
  });

  root.append(drawer, pill);
  document.body.appendChild(root);
}

// Every focusable control the drawer currently owns, in document order. Queried fresh
// on each Tab because the drawer rebuilds its list, its tools strip and its saves strip
// constantly - a cached list would trap focus on buttons that no longer exist.
const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),"
  + "select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
function focusables() {
  return Array.from(drawer.querySelectorAll(FOCUSABLE))
    .filter(n => n.offsetParent !== null || n === document.activeElement);
}

// Tab and Shift+Tab wrap inside the drawer. It is a role="dialog" sitting on top of a
// full TCGplayer product page; without this, one Tab off the last button walked focus
// into the page behind it while the dialog was still open and covering it.
function trapTab(e) {
  if (e.key !== "Tab" || !drawer.classList.contains("tsc-open")) return;
  const items = focusables();
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// Opening moves focus into the drawer (its Close button - the one control that is always
// there and never rebuilt); closing puts focus back on the pill that opened it, so the
// keyboard lands where the user left it rather than at the top of the document.
function toggleDrawer(open) {
  clearTimeout(closeTimer);
  drawer.classList.remove("tsc-out");
  pill.setAttribute("aria-expanded", String(open));

  if (open) {
    drawer.classList.add("tsc-open");
    drawer.setAttribute("aria-modal", "true");
    renderList();
    refreshStatus();
    if (drawerClose) drawerClose.focus();
    return;
  }

  drawer.removeAttribute("aria-modal");
  // return focus BEFORE the exit animation: the pill is outside the drawer, so nothing
  // is left focused inside a surface that is on its way to display:none
  if (pill && drawer.contains(document.activeElement)) pill.focus();
  if (reduced()) { drawer.classList.remove("tsc-open"); return; }
  // .tsc-out runs the entrance in reverse over .16s; display goes back to none after
  drawer.classList.add("tsc-out");
  closeTimer = setTimeout(() => {
    drawer.classList.remove("tsc-open", "tsc-out");
    closeTimer = 0;
  }, 180);
}

// ---------------------------------------------------------------- panel

let noteBox;

function note(text, strong) {
  if (!noteBox) return;
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
  const COLLECTED_TIP = "Collected. Click to add another copy, "
    + "shift-click to refresh the price without changing the count.";
  if (have.has(`${PID}|${sel.variant}|${sel.condition}|${sel.language}`)) {
    setState("tsc-ok", "check");
    chip.title = COLLECTED_TIP;
  }

  chip.addEventListener("click", async e => {
    // Both paths re-pull the price. The only difference is whether a copy is added.
    const bump = !e.shiftKey;
    chip.disabled = true;
    chip.setAttribute("aria-busy", "true");
    setState("tsc-busy", null);
    note(`Paging sales for ${label(sel)}.`);
    try {
      const res = await send({
        type: "collect", productId: PID, sel, meta: scrapePageMeta(),
        mode: bump ? "bump" : "refresh"
      });
      if (res.ok) {
        setState("tsc-ok", "check");
        const what = res.mode === "incremented"
          ? [`+1 copy · ${res.qty} total`]
          : res.mode === "refreshed" ? ["refreshed"] : [];
        const detail = what.concat([`${res.samples} sale${res.samples === 1 ? "" : "s"} averaged`,
          `${res.rejected} rejected`])
          .concat(res.capped ? ["stopped at the 10 page cap"] : [])
          .concat(res.stale ? ["oldest sale is over 60 days old"] : [])
          .concat(res.noFx ? ["no exchange rate, CAD left blank"] : []);
        chip.title = detail.join(". ") + ". " + COLLECTED_TIP;
        note(detail.join(", ") + ".", label(sel) + ":");
        setCount(res.count);
        pendingHit = res.key;
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

// init() awaits the sales API - twice, with a 1.2s pause between tries. TCGplayer is a
// SPA, so the user can navigate to another product (or keepMounted can rebuild) while
// that is in flight, and the old call would then finish and write its chips, its note and
// its count into a panel belonging to a DIFFERENT card, or into a panel already detached
// from the document. Each init() takes a generation number; anything stale returns without
// touching the DOM. `noteBox` is the worst of it - it is a module global, so a late init
// hijacked the live panel's status line.
let initGen = 0;

async function init() {
  const gen = ++initGen;
  const stale = () => gen !== initGen;
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

  const myNote = noteBox = el("p", "tsc-note");
  noteBox.setAttribute("role", "status");
  noteBox.setAttribute("aria-live", "polite");
  panel.appendChild(noteBox);
  const myPanel = panel;
  mount(panel);

  // Two tries with a beat between them: the MV3 worker can be mid-wake on the first
  // message, and the sales API drops the odd request. One silent retry turns "refresh
  // the page until it loads" into a pause nobody notices. Only then is it an error.
  let res, lastErr;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1200));
    if (stale()) return;
    try {
      const r = await send({ type: "firstPage", productId: PID });
      if (r.ok) res = r;
      else lastErr = r.error;
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  // a newer init() (or a rebuild) started while we were waiting: that one owns the panel
  // and the note line now, and this reply describes a card the user has already left
  if (stale() || myPanel !== panel || noteBox !== myNote) return;
  if (!res) {
    alert_(body, "Could not read sales: " + lastErr, true);
    return;
  }
  setCount(res.count);

  const groups = combos(res.rows);
  if (!groups.length) { alert_(body, "No recent sales on this product."); return; }

  body.textContent = "";

  // Exactly 5 sales and no next page is the signed-out truncation signature - but it is
  // also what a genuinely quiet product looks like, so this is a warning above working
  // chips, never a block. Blocking on it hid every quiet product behind a wrong reason.
  if (res.loggedOut) {
    const warn = el("p", "tsc-alert");
    warn.textContent = "Only 5 sales came back and there is no next page. "
      + "That is all this product has, or you are signed out of TCGplayer - "
      + "signed out, the feed stops at 5 rows. Sign in for the full history.";
    body.appendChild(warn);
  }

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

  // Shift-click was documented only in a title attribute, which is to say it was
  // documented nowhere: nobody hovers a button they have already decided to click.
  // One line under the chips, where the decision is actually made.
  const hint = el("p", "tsc-hint");
  hint.appendChild(document.createTextNode("Click a grade to add a copy. "));
  hint.appendChild(el("b", null, "Shift-click"));
  hint.appendChild(document.createTextNode(
    " re-pulls its price without changing the count."));
  body.appendChild(hint);
}

// The pure parts - the money arithmetic, the printed document, the undo wording - are
// exported so `node test.js` can hold them to the same standard as the worker's. There
// is no DOM in any of them.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    round2, pctFor, tradeUnit, tradeLine, printDoc, undoOutcome, lowSamples,
    LOW_SAMPLES, STALE_DAYS
  };
} else {
  // last: everything above uses `let` bindings that must be initialised first.
  // start() runs on EVERY tcgplayer page, product or not: TCGplayer is a SPA, so a
  // click from search to a product never reloads the page. When the script only
  // injected on /product/* urls, that navigation left the panel missing until a
  // manual refresh. The URL watcher inside keepMounted() is what builds the panel
  // the moment the location becomes a product page.
  readUrl();
  start();
}
