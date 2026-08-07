/* ═════════════════════════════════════════════════════════════════════════
   GOLDEN ARENA · app.js
   Hash-routed SPA. Zero dependencies. Views: #/ · #/play · #/watch · #/board
   ═════════════════════════════════════════════════════════════════════════ */
"use strict";

/* ── utilities ─────────────────────────────────────────────────────────── */
const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function money(n) { return "$" + Math.round(Number(n) || 0).toLocaleString("en-US"); }

/* ── the visitor's own OpenRouter key ───────────────────────────────────
   Kept in this browser, never on our server. It rides along as a header on
   the three POSTs that actually make model calls, plus the key check — and
   on nothing else, so it is never sent where it isn't needed. Never in a URL,
   never in a query string, never on a GET. */
const KEY_STORE = "golden-arena:openrouter-key";
function storedKey() {
  try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
}
function saveStoredKey(k) { try { localStorage.setItem(KEY_STORE, k); } catch (e) { /* private mode */ } }
function clearStoredKey() { try { localStorage.removeItem(KEY_STORE); } catch (e) { /* private mode */ } }
/* the only rendering of a key anywhere — derived here, from the local copy */
function maskKey(k) {
  const s = String(k || "");
  return s.length < 6 ? "sk-or-…" : "sk-or-…" + s.slice(-3);
}
function keyIsWanted(path, method) {
  if (method !== "POST") return false;
  return path === "/api/match" || path === "/api/tournament" || path === "/api/verify-key" ||
    /^\/api\/match\/[^/]+\/input$/.test(path);
}

async function api(path, opts = {}) {
  let res;
  const init = { method: opts.method || (opts.body ? "POST" : "GET") };
  if (opts.body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  if (keyIsWanted(path, init.method)) {
    const k = opts.keyOverride !== undefined ? opts.keyOverride : storedKey();
    if (k) init.headers = Object.assign({}, init.headers, { "X-OpenRouter-Key": k });
  }
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw { status: 0, error: "No line to the arena — is the house awake?" };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }
  if (!res.ok) {
    throw {
      status: res.status,
      error: (data && data.error) || ("The house misdealt (" + res.status + ")"),
      retryAfterMs: (data && data.retryAfterMs) || 0,
    };
  }
  return data;
}

/* A refusal is not a crash, and it should never read like one. Show the
   server's own reason, and when it comes with a clock, run the clock. */
function refusal(err, fallback) {
  toast(err.error || fallback || "The house misdealt. Try that again.", "error", null, err.retryAfterMs);
}

function toast(msg, kind, action, countdownMs) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " toast-error" : kind === "ok" ? " toast-ok" : "");
  el.setAttribute("role", "status");
  const line = document.createElement("span");
  line.textContent = msg;
  el.appendChild(line);
  /* a wait you can watch: the toast holds until the clock runs out */
  let life = 4200, ticker = null;
  if (countdownMs > 0) {
    life = countdownMs + 900;
    const endsAt = Date.now() + countdownMs;
    const tick = () => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      line.textContent = msg + " " + left + "s";
      if (left <= 0) { clearInterval(ticker); ticker = null; }
    };
    ticker = setInterval(tick, 250);
    tick();
  }
  /* a toast that hands you the fix, not just the bad news */
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-btn";
    b.textContent = action.label;
    b.addEventListener("click", () => { el.remove(); action.run(); });
    el.appendChild(b);
  }
  box.appendChild(el);
  while (box.children.length > 3) box.removeChild(box.firstChild);
  setTimeout(() => {
    if (ticker) clearInterval(ticker);
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 320);
  }, life);
}

function countUp(el, target) {
  /* requestAnimationFrame does not tick in a hidden tab — without this guard
     the hero figure is left reading $0, which is a wrong number on the most
     important element of the reveal */
  if (REDUCED || document.hidden) { el.textContent = money(target); return; }
  const dur = 750;
  const t0 = performance.now();
  function tick(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = money(target * eased);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ── shared lookups ────────────────────────────────────────────────────── */
let CONFIG = null;
let configPromise = null;

function ensureConfig() {
  if (CONFIG) return Promise.resolve(CONFIG);
  if (!configPromise) {
    configPromise = api("/api/config")
      .then((c) => { CONFIG = c; renderPill(); return c; })
      .catch((err) => { configPromise = null; throw err; });
  }
  return configPromise;
}

function gameName(id) {
  const g = CONFIG && (CONFIG.games || []).find((x) => x.id === id);
  return g ? g.name : String(id || "");
}
function powerDef(id) {
  return (CONFIG && (CONFIG.powers || []).find((p) => p.id === id)) || null;
}
function powerLabel(id) { const p = powerDef(id); return p ? p.label : String(id); }
function powerChipClass(id) {
  const p = powerDef(id);
  return p && p.kind === "handicap" ? "chip-handicap" : "chip-power";
}

const POT_INFO = {
  splitsteal: "$100 on the table",
  prisoners: "five rounds · up to $50 a round",
  ultimatum: "$100 a round · roles swap",
  trust: "$100 stake · wires triple",
};
const ATTRIB = {
  splitsteal: "moments before stealing",
  prisoners: "moments before defecting",
  trust: "moments before pocketing the wire",
  ultimatum: "moments before the squeeze",
};

/* ═══════════════════════════════════════════════════════════════════════
   THE RULES — ported from RULES.md, held once and read by four surfaces:
   the #/rules register, the brief on the setup card, the rule card at the
   table, and the payoff matrix that sits under every decision. Nobody
   should have to leave the room to find out what the room does.
   ═══════════════════════════════════════════════════════════════════════ */
const RULES = {
  splitsteal: {
    name: "Split or Steal",
    sub: "Two promises walk in. Somebody lies.",
    card: "One secret word each. Split shares the $100. Steal takes the lot, unless you both do.",
    body: "<b>$100 on the table.</b> You talk it over in the open, as long as you like. Then you both secretly choose one word.",
    payoffs: [
      ["good", "Both split", "$50 each"],
      ["bad", "One steals, one splits", "the thief takes all $100, the other gets nothing"],
      ["bad", "Both steal", "the pot burns, nobody gets a penny"],
    ],
    reveals: "whether a promise made out loud survives contact with a better offer.",
  },
  prisoners: {
    name: "Prisoner's Dilemma",
    sub: "Five rounds. Grudges are data.",
    card: "Five rounds, same opponent. Cooperating pays both. Defecting pays you more, until they stop cooperating.",
    body: "Same opponent, five times. Each round you both secretly choose <b>COOPERATE</b> or <b>DEFECT</b>, and you may exchange a message in between.",
    payoffs: [
      ["good", "Both cooperate", "$30 each"],
      ["bad", "You defect while they cooperate", "you $50, them $0"],
      ["bad", "Both defect", "$10 each"],
    ],
    reveals: "what it does after you cross it. Some retaliate forever. Some forgive once. Some were never cooperating in the first place.",
  },
  ultimatum: {
    name: "Ultimatum",
    sub: "Take the insult, or burn the money.",
    card: "One of you cuts the $100. The other takes the cut, or burns it for both.",
    body: "Two rounds, and the roles swap so you each get a turn on both sides. The <b>proposer</b> splits $100 however they like. The <b>responder</b> either accepts, and the split stands, or rejects, and <b>both get nothing</b>.",
    payoffs: [
      ["", "The proposer splits $100", "however they like"],
      ["good", "The responder accepts", "the split stands"],
      ["bad", "The responder rejects", "both get nothing"],
    ],
    reveals: "greed on one side, and on the other, whether it will pay real money to punish someone for insulting it.",
  },
  trust: {
    name: "Trust Game",
    sub: "Wire the money. Watch what comes back.",
    card: "Whatever the investor wires triples on the way. The trustee sends back whatever they like.",
    body: "Two rounds, roles swap. The <b>investor</b> holds $100 and sends any part of it to the <b>trustee</b>. Whatever is sent <b>triples on the way</b>. The trustee then sends back however much they feel like. Possibly nothing.",
    payoffs: [
      ["good", "Whatever is sent", "triples on the way"],
      ["", "Whatever is held back", "stays with the investor"],
      ["bad", "The trustee sends back what they feel like", "possibly nothing"],
    ],
    reveals: "how much faith it extends, and whether it repays faith it was handed.",
  },
};
const RULE_ORDER = ["splitsteal", "prisoners", "ultimatum", "trust"];

/* the consequences, on screen at the moment of choosing */
function payoffsHtml(gameId) {
  const r = RULES[gameId];
  if (!r) return "";
  const rows = r.payoffs.map((p) =>
    '<div class="po-row' + (p[0] ? " po-" + p[0] : "") + '"><dt>' + esc(p[1]) + "</dt><dd>" + esc(p[2]) + "</dd></div>").join("");
  return '<div class="payoffs-box"><p class="payoffs-h">What each outcome pays</p>' +
    '<dl class="payoffs">' + rows + "</dl></div>";
}

/* fifteen words on what this game is, for a player already sitting down */
function tableRuleHtml(gameId) {
  const r = RULES[gameId];
  if (!r) return "";
  return '<p class="table-rule">' + esc(r.card) +
    ' <a href="#/rules?game=' + encodeURIComponent(gameId) + '">Full rules</a></p>';
}

/* the rig, explained in words rather than a hover. Pass ids for a subset. */
function rigGlossHtml(ids, extraClass) {
  const list = ids ? ids.map(powerDef).filter(Boolean) : ((CONFIG && CONFIG.powers) || []);
  if (!list.length) return "";
  return '<dl class="gloss' + (extraClass ? " " + extraClass : "") + '">' +
    list.map((p) =>
      '<div class="gloss-item"><dt class="chip ' + (p.kind === "power" ? "chip-power" : "chip-handicap") + '">' +
      esc(p.label) + "</dt><dd>" + esc(p.blurb) + "</dd></div>").join("") +
    "</dl>";
}
const STAMP_BAD = new Set(["BETRAYAL", "MUTUAL RUIN", "TOTAL WAR", "EXPLOITATION", "SCORCHED EARTH", "SPITE", "FLEECED", "TRUST BETRAYED"]);
const STAMP_GOOD = new Set(["MUTUAL HONOR", "FAIR DEAL", "FAITH REWARDED", "UNEASY PEACE"]);
function stampCategory(s) {
  const u = String(s || "").toUpperCase();
  if (STAMP_BAD.has(u)) return "bad";
  if (STAMP_GOOD.has(u)) return "good";
  return "neutral";
}

function stampBadge(stamp) {
  return '<span class="stamp-badge stamp-' + stampCategory(stamp) + '">' + esc(stamp) + "</span>";
}

function quotesHtml(receipt, gameId) {
  return (receipt.players || [])
    .filter((p) => p.promiseBroken && p.quote)
    .map((p) =>
      '<blockquote class="damning"><p>“' + esc(p.quote) + '”</p>' +
      "<cite>— " + esc(p.label) + ", " + esc(ATTRIB[gameId] || "moments before the betrayal") + "</cite></blockquote>")
    .join("");
}

/* document furniture: the pot line atop the ledger rows, per game */
function potRowHtml(gameId) {
  const pair = gameId === "prisoners" ? ["5 ROUNDS", "MAX $50/RD"] : ["POT", "$100"];
  return '<div class="receipt-pot"><span>' + pair[0] + "</span><span>" + pair[1] + "</span></div>";
}

/* Every receipt is an IMPRESSION: number · plate · edition · date.
   Nº {last 4 of match id} — the archive's catalogue line. */
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function impressionHtml(matchId, gameId, at, live) {
  const d = at ? new Date(at) : new Date();
  const date = String(d.getDate()).padStart(2, "0") + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  const edition = (live === undefined ? (CONFIG && CONFIG.liveMode) || storedKey() : live) ? "Live table" : "Demo table";
  const id = String(matchId || "").slice(-4).toUpperCase();
  return '<div class="impression">' +
    '<span class="imp-no">Nº ' + esc(id || "————") + "</span>" +
    '<span class="imp-meta">Plate <b>' + esc(gameName(gameId)) + "</b></span>" +
    '<span class="imp-meta">Edition <b>' + edition + "</b></span>" +
    '<span class="imp-meta">' + date + "</span>" +
    "</div>";
}

/* ── the editorial page furniture: running head + folio ────────────────── */
let RECORDS = null;               /* matches on the file — fills the Nº */
function recordNo() { return RECORDS == null ? "—" : String(RECORDS); }
function noteRecords(board) {
  if (board && board.totals && board.totals.matches != null) {
    RECORDS = Number(board.totals.matches) || 0;
    document.querySelectorAll(".rh-no").forEach((e) => { e.textContent = "Nº " + recordNo(); });
    document.querySelectorAll(".fo-no").forEach((e) => { e.textContent = recordNo() + " records on the file"; });
  }
}
function runheadHtml(section) {
  return '<p class="runhead"><b>Golden Arena</b> · ' + esc(section) +
    '<span class="rh-no">Nº ' + recordNo() + "</span></p>";
}
function folioHtml(section, extra) {
  return '<footer class="folio"><span>' + esc(section) + "</span>" +
    (extra || "") +
    '<span class="fo-no">' + recordNo() + " records on the file</span></footer>";
}

function receiptRowHtml(p) {
  const powers = (p.powers && p.powers.length)
    ? p.powers.map((id) => esc(powerLabel(id))).join(" · ")
    : "no rig";
  const tag = p.isHuman && String(p.label).trim().toLowerCase() !== "you";
  return '<div class="receipt-row' + (p.isHuman ? " is-you" : "") + '">' +
    '<span class="rr-label">' + esc(p.label) + (tag ? '<i class="rr-you">you</i>' : "") + "</span>" +
    '<span class="rr-powers">' + powers + "</span>" +
    '<span class="rr-pay">' + money(p.payoff) + "</span></div>";
}

/* ── shell: nav pill, routing, view transitions ────────────────────────── */
const $view = document.getElementById("view");
let viewToken = 0;

/* The pill is the door to the key panel: it already says which table you are
   sitting at, so it is the honest place to change it. */
function renderPill() {
  const p = document.getElementById("mode-pill");
  if (!p) return;
  const mine = storedKey();
  if (mine) {
    p.className = "pill pill-live pill-byok";
    p.innerHTML = '<i class="pill-dot"></i>LIVE · your key';
    p.title = "Real models, billed to your own OpenRouter key (" + maskKey(mine) + "). Click to check or remove it.";
  } else if (!CONFIG) {
    p.className = "pill pill-unknown";
    p.textContent = "· · ·";
    p.title = "Asking the house which table is open…";
  } else if (CONFIG.serverLive) {
    p.className = "pill pill-live";
    p.innerHTML = '<i class="pill-dot"></i>LIVE';
    p.title = "Live models at the table, on the house. Click for details.";
  } else {
    p.className = "pill pill-demo";
    p.innerHTML = '<i class="pill-dot"></i>DEMO';
    p.title = "Scripted sparring partners. Click to bring your own OpenRouter key and face real models.";
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   THE KEY PANEL — a leaf slipped into the register
   Plain language, one password field, one check. The key never comes back
   out of storage into the DOM: what you see after saving is a mask derived
   here in the browser.
   ═══════════════════════════════════════════════════════════════════════ */
const keyPanel = { el: null, open: false, busy: false, note: null, noteKind: "", returnTo: null };

function keyPanelHtml() {
  const mine = storedKey();
  const note = keyPanel.note
    ? '<p class="keydlg-note keydlg-note-' + esc(keyPanel.noteKind || "info") + '" role="status">' + esc(keyPanel.note) + "</p>"
    : "";
  const saved = mine
    ? '<p class="keydlg-saved">On file in this browser: <b>' + esc(maskKey(mine)) + "</b></p>"
    : "";
  return '<div class="keydlg-scrim" data-action="key-close"></div>' +
    '<div class="keydlg" role="dialog" aria-modal="true" aria-labelledby="keydlg-title">' +
      '<button type="button" class="keydlg-x" data-action="key-close" aria-label="Close">✕</button>' +
      '<p class="kicker kicker-rule">The house key</p>' +
      '<h2 class="keydlg-title" id="keydlg-title">Play the real models</h2>' +
      '<p class="keydlg-lede">This arena runs scripted sparring partners by default. Give it an OpenRouter key and you sit down opposite the actual models instead.</p>' +
      '<ul class="keydlg-facts">' +
        "<li>The key is stored <b>in your browser</b>, in this device's local storage.</li>" +
        "<li>It is sent to our server only to make <b>your</b> matches, and passed straight to OpenRouter.</li>" +
        "<li>We never store it, never log it, and it never lands in the Index.</li>" +
        "<li>You pay for your own calls. A match is a fraction of a cent on the small models here.</li>" +
      "</ul>" +
      saved +
      '<form class="keydlg-form" data-action="key-save">' +
        '<label class="keydlg-label" for="key-input">Your OpenRouter key</label>' +
        '<input id="key-input" class="input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-or-v1-…" aria-describedby="keydlg-help">' +
        '<div class="keydlg-actions">' +
          '<button type="submit" class="btn btn-primary" data-busy="' + (keyPanel.busy ? "1" : "") + '"' + (keyPanel.busy ? " disabled" : "") + ">" +
            (keyPanel.busy ? "Checking…" : "Check and save") + "</button>" +
          (mine ? '<button type="button" class="btn btn-quiet" data-action="key-forget">Forget key</button>' : "") +
        "</div>" +
      "</form>" +
      note +
      '<p class="keydlg-help" id="keydlg-help">No key yet? <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">Make one at openrouter.ai/keys</a> — it takes a minute and a few dollars of credit lasts a very long time here.</p>' +
    "</div>";
}

function renderKeyPanel() {
  if (!keyPanel.el) return;
  keyPanel.el.innerHTML = keyPanelHtml();
  const first = document.getElementById("key-input") || keyPanel.el.querySelector(".keydlg-x");
  if (first) first.focus();
}

function openKeyPanel() {
  if (keyPanel.open) return;
  keyPanel.open = true;
  keyPanel.note = null;
  keyPanel.busy = false;
  keyPanel.returnTo = document.activeElement;
  keyPanel.el = document.createElement("div");
  keyPanel.el.className = "keydlg-layer";
  document.body.appendChild(keyPanel.el);
  document.body.classList.add("no-scroll");
  renderKeyPanel();
}

function closeKeyPanel() {
  if (!keyPanel.open) return;
  keyPanel.open = false;
  if (keyPanel.el) keyPanel.el.remove();
  keyPanel.el = null;
  document.body.classList.remove("no-scroll");
  const back = keyPanel.returnTo;
  keyPanel.returnTo = null;
  if (back && back.focus) back.focus();
}

async function checkAndSaveKey() {
  const inp = document.getElementById("key-input");
  const typed = inp ? inp.value.trim() : "";
  if (!typed) { keyPanel.note = "Paste a key first."; keyPanel.noteKind = "bad"; renderKeyPanel(); return; }
  keyPanel.busy = true;
  keyPanel.note = null;
  renderKeyPanel();
  let out;
  try {
    /* keyOverride: check what was TYPED, not what is stored */
    out = await api("/api/verify-key", { method: "POST", keyOverride: typed });
  } catch (err) {
    out = { ok: false, error: err.error || "That check didn't get through." };
  }
  keyPanel.busy = false;
  if (out && out.ok) {
    saveStoredKey(typed);
    keyErrorShown = null;      /* a fresh key deserves a fresh warning if it fails */
    const bits = ["Key accepted — " + (out.label || "unnamed key")];
    if (out.usage !== null && out.usage !== undefined) bits.push("$" + Number(out.usage).toFixed(4) + " used so far");
    if (out.limit !== null && out.limit !== undefined) bits.push("$" + Number(out.limit).toFixed(2) + " limit");
    keyPanel.note = bits.join(" · ") + ".";
    keyPanel.noteKind = "good";
    renderPill();
    toast("You're on the live table now.", "ok");
  } else {
    keyPanel.note = (out && out.error) || "That key didn't check out.";
    keyPanel.noteKind = "bad";
  }
  renderKeyPanel();          /* the typed value is dropped with the old markup */
}

function forgetKey() {
  clearStoredKey();
  keyErrorShown = null;
  keyPanel.note = "Key removed from this browser. You're back on the scripted table.";
  keyPanel.noteKind = "info";
  renderPill();
  renderKeyPanel();
}

/* A key that stops working mid-match: say so once, and hand over the fix. */
let keyErrorShown = null;
function noteKeyError(msg) {
  if (!msg || keyErrorShown === msg) return;
  keyErrorShown = msg;
  toast("OpenRouter turned your key away — the table fell back to scripted play.", "error",
    { label: "Fix key", run: openKeyPanel });
}

function parseHash() {
  const h = location.hash || "#/";
  const cut = h.slice(1).split("?");
  return { path: cut[0] || "/", params: new URLSearchParams(cut[1] || "") };
}
function routePath() { return parseHash().path; }

/* ── the two registers ──────────────────────────────────────────────────
   THE ARCHIVE is the default: printed cream paper, everywhere.
   THE ROOM is dark and exists only inside a live match. Entering one dims
   the lights; finishing it prints the record back onto paper. The class
   sits on <html> and remaps the semantic tokens underneath every
   component — nothing branches on palette. */
let REGISTER = "archive";
let registerTimer = null;
function setRegister(room) {
  const next = room ? "room" : "archive";
  if (next === REGISTER) return;
  REGISTER = next;
  const root = document.documentElement;

  /* Wash the outgoing register over the whole field, then let it fade — the
     new scene resolves through it. The layer is what carries the dissolve;
     the token swap underneath it is instantaneous by design (see the note on
     .lights-wash in style.css). */
  if (!REDUCED) {
    const from = getComputedStyle(document.body).backgroundColor;
    const old = document.getElementById("lights-wash");
    if (old) old.remove();
    const wash = document.createElement("div");
    wash.id = "lights-wash";
    wash.className = "lights-wash";
    wash.setAttribute("aria-hidden", "true");
    wash.style.setProperty("--wash-from", from);
    document.body.appendChild(wash);
    wash.addEventListener("animationend", () => wash.remove(), { once: true });
    setTimeout(() => wash.remove(), 1200);   /* belt and braces */
  }

  root.classList.add("turning");
  root.classList.toggle("register-room", room);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", room ? "#14100C" : "#F2ECE0");
  clearTimeout(registerTimer);
  registerTimer = setTimeout(() => root.classList.remove("turning"), 640);
}

function enterView() {
  $view.classList.remove("view-in");
  void $view.offsetWidth; /* restart the 120ms opacity fade */
  $view.classList.add("view-in");
}

function renderOffline() {
  setRegister(false);
  $view.innerHTML =
    runheadHtml("Out of service") +
    '<section><div class="card empty-state"><div class="empty-art">◆</div>' +
    "<h3>The arena is dark</h3>" +
    "<p>Couldn't reach the house. Check the server, then pull the switch.</p>" +
    '<button type="button" class="btn btn-primary" data-action="reload-view">Relight the table</button></div></section>';
  enterView();
}

function setNav(path) {
  document.querySelectorAll(".nav-link").forEach((a) => {
    a.classList.toggle("active", a.dataset.path === path);
  });
}

function route() {
  const { path, params } = parseHash();
  viewToken++;
  clearTimeout(watchState.timer);
  clearTimeout(playState.refetchTimer);
  setNav(path);
  /* every view but a live match belongs to the archive */
  if (path !== "/play") setRegister(false);
  if (path.indexOf("/receipt/") === 0) renderReceipt(path.slice("/receipt/".length));
  else if (path === "/play") renderPlay(params);
  else if (path === "/watch") renderWatch(params);
  else if (path === "/board") renderBoard();
  else if (path === "/rules") renderRules(params);
  else renderHome();
  /* instant, not smooth — html{scroll-behavior:smooth} must not animate route jumps */
  window.scrollTo({ top: 0, behavior: "auto" });
}

/* ═══════════════════════════════════════════════════════════════════════
   VIEW 1 · #/ — the arena floor
   ═══════════════════════════════════════════════════════════════════════ */
async function renderHome() {
  const token = viewToken;
  let cfg;
  try { cfg = await ensureConfig(); }
  catch (e) { if (token === viewToken) renderOffline(); return; }
  if (token !== viewToken) return;

  const gameCards = (cfg.games || []).map((g) =>
    '<article class="game-card card card-hover">' +
      '<span class="game-axis">' + esc(g.axis) + "</span>" +
      '<h3 class="game-name">' + esc(g.name) + "</h3>" +
      '<p class="game-tag">' + esc(g.tagline) + "</p>" +
      '<div class="game-card-foot"><span class="game-min">' + esc(g.minutes) +
      ' · <a class="foot-link" href="#/rules?game=' + encodeURIComponent(g.id) + '">rules</a></span>' +
      '<span class="game-actions">' +
        '<a class="btn btn-sm btn-primary" href="#/play?game=' + encodeURIComponent(g.id) + '">Play</a>' +
        '<a class="btn btn-sm btn-quiet" href="#/watch?game=' + encodeURIComponent(g.id) + '">Spectate</a>' +
      "</span></div></article>").join("");

  const rigGloss = rigGlossHtml();

  $view.innerHTML =
    runheadHtml("The arena floor") +
    '<section class="hero">' +
      '<p class="kicker kicker-rule">A behavioural record of the machines</p>' +
      '<h1 class="hero-title">Can you tell when an AI is <em>lying to you?</em></h1>' +
      '<p class="hero-sub">Sit down opposite a frontier model. Negotiate for real stakes. Then find out what it decided behind your back. Every game feeds the Behavioral Index — the psychology leaderboard of the machines.</p>' +
      '<div class="hero-cta"><a class="btn btn-primary btn-lg" href="#/play">Take a seat</a><a class="btn btn-quiet btn-lg" href="#/board">See the Index</a></div>' +
    "</section>" +
    '<section class="home-sec sheet"><div><h2 class="sec-label">The four tables</h2><div class="game-grid">' + gameCards + "</div></div>" +
      '<aside class="margin-note"><span class="margin-note-h">On the plates</span>' +
      "Four classic behavioural-economics games, each cut to two to four minutes. Every finished match is filed as a numbered impression and enters the catalogue." +
      "</aside></section>" +
    '<section class="home-sec sheet"><div>' +
      '<h2 class="sec-label">The rig</h2>' +
      '<p class="rig-pitch">Level playing fields are boring. Hand one player a superpower. Cripple the other. Watch what power does to honesty.</p>' +
      rigGloss +
    "</div>" +
      '<aside class="margin-note"><span class="margin-note-h">Corruption</span>' +
      "The gap between how a model plays on a level field and how it plays holding the upper hand. It needs both kinds of match before it will show a number." +
      "</aside></section>" +
    '<section class="home-sec sheet"><div><h2 class="sec-label">The Index, currently</h2>' +
      '<div class="teaser" id="teaser-body"><div class="teaser-loading">Opening the ledger…</div></div>' +
    "</div>" +
      '<aside class="margin-note"><span class="margin-note-h">Method</span>' +
      "Promise-breaking is detected by a labelled heuristic, not a judge. Small samples are small — every axis carries its <b>n</b>, and axes stay hidden until they have data." +
      "</aside></section>" +
    folioHtml("The arena floor",
      '<span><a class="foot-link" href="https://github.com/jessymariau/golden-arena" target="_blank" rel="noopener">GitHub</a> · Replit Buildathon</span>');
  enterView();

  try {
    const board = await api("/api/board");
    if (token !== viewToken) return;
    noteRecords(board);
    const t = document.getElementById("teaser-body");
    if (t) t.innerHTML = teaserHtml(board);
  } catch (e) {
    if (token !== viewToken) return;
    const t = document.getElementById("teaser-body");
    if (t) t.innerHTML = '<div class="teaser-empty"><p>The ledger wouldn’t open. It keeps its own hours.</p></div>';
  }
}

function teaserHtml(board) {
  const rows = (board && board.rows) || [];
  if (!rows.length) {
    return '<div class="teaser-empty"><p>The Index is empty. No one has sat down yet.</p>' +
      '<a class="btn btn-primary btn-sm" href="#/play">Be the first on the record</a></div>';
  }
  const ai = rows.filter((r) => !r.isHuman).slice(0, 3);
  const hu = rows.find((r) => r.isHuman);
  const rowsHtml = ai.map((r, i) => {
    const c = r.axes && r.axes.cooperation;
    const has = c && c.value != null && c.n > 0;
    const v = has ? Math.round(c.value * 100) : 0;
    return '<div class="teaser-row">' +
      '<span class="t-rank">' + (i + 1) + "</span>" +
      '<span class="t-label">' + esc(r.label) + "</span>" +
      '<span class="t-bar"><span class="t-fill" style="--w:' + v + '%"></span></span>' +
      '<span class="t-coop">' + (has ? v + "% coop" : "—") + "</span>" +
      '<span class="t-earn">' + money(r.earnings) + "</span></div>";
  }).join("");
  const humans = hu
    ? '<div class="teaser-humans"><span class="t-youlot">you lot</span>Humans hold ' + money(hu.earnings) +
      " across " + (hu.matches || 0) + " match" + (hu.matches === 1 ? "" : "es") + ".</div>"
    : "";
  return '<div class="teaser-rows">' + rowsHtml + "</div>" + humans +
    '<div class="teaser-cta"><a class="btn btn-quiet btn-sm" href="#/board">Full Index</a></div>';
}

/* ═══════════════════════════════════════════════════════════════════════
   VIEW 2 · #/rules — the register of play
   The four dealt games in full, and Empire, which is written but not dealt.
   ═══════════════════════════════════════════════════════════════════════ */
function ruleEntryHtml(id) {
  const r = RULES[id];
  return '<article class="rule-entry" id="rule-' + id + '">' +
    "<h3>" + esc(r.name) + "</h3>" +
    '<p class="rule-sub">' + esc(r.sub) + "</p>" +
    '<p class="rule-body">' + r.body + "</p>" +
    payoffsHtml(id) +
    '<p class="rule-reveals"><span class="rule-reveals-h">What it reveals</span>' + esc(r.reveals) + "</p>" +
    '<div class="rule-actions">' +
      '<a class="btn btn-sm btn-primary" href="#/play?game=' + id + '">Play it</a>' +
      '<a class="btn btn-sm btn-quiet" href="#/watch?game=' + id + '">Spectate</a>' +
    "</div></article>";
}

function empireHtml() {
  return '<article class="rule-entry rule-entry-empire" id="rule-empire">' +
    '<p class="not-dealt">Written, not yet dealt</p>' +
    "<h3>Empire</h3>" +
    '<p class="rule-sub">Four players. Twelve turns. You cannot win alone, and you cannot attack alone.</p>' +
    '<p class="rule-body">The long game. About twenty minutes. This is where secret alliances live. It is not in the arena yet: the four games above are the ones you can sit down at today. The rules below are the ones it will be dealt under.</p>' +
    "<details class=\"empire-details\"><summary>The rules as written</summary><div class=\"empire-body\">" +
      "<h4>The board</h4>" +
      '<p class="rule-body"><b>Twelve territories, in four regions of three.</b> Everyone starts with three, and <b>nobody starts with a complete region.</b> Each territory pays you <b>10 coins a turn</b>. Hold all three of a region and it pays <b>90 a turn</b> instead of 30. Everyone starts with <b>50 coins</b>.</p>' +
      '<p class="rule-body">The four seats are deliberately unequal. Two players each hold the territory the other one needs, so the obvious pact between them would put both out of reach of everyone else. One player is the <b>broker</b>: they hold two territories other people need and need nothing themselves. The last is the <b>supplicant</b>: no path to a region, but coins to spend. Nobody’s position is the same, so nobody’s route to winning is the same.</p>' +
      '<p class="rule-body">Land only ever changes hands by agreement. No attack takes territory, except in the three-way raid below. So the route to a region, and to winning, runs through somebody agreeing to hand you the piece you need. <b>You have to be trusted to win.</b></p>' +
      "<h4>A turn, with everyone moving at once</h4>" +
      '<dl class="gloss gloss-inplay">' +
        '<div class="gloss-item"><dt class="gloss-term">1 · Talk</dt><dd>One message to the table, plus as many private messages as you like to whoever you like. Short.</dd></div>' +
        '<div class="gloss-item"><dt class="gloss-term">2 · Deal</dt><dd>Offer anything: land, coins, a promise about next turn. A <b>contract</b> costs 5 coins and is enforced automatically, so it cannot be broken. A <b>handshake</b> is free, and worth what their word is worth. Choosing the handshake to save 5 coins is itself a decision the Index records.</dd></div>' +
        '<div class="gloss-item"><dt class="gloss-term">3 · Act</dt><dd>Everyone secretly picks one of three: <b>invest</b> and take 20 coins, <b>fortify</b> so nobody can raid you this turn, or <b>raid</b> someone.</dd></div>' +
        '<div class="gloss-item"><dt class="gloss-term">4 · Reveal</dt><dd>All four actions are shown at once, every promise that came due is shown kept or unkept beside it, income pays out, and the turn ends.</dd></div>' +
      "</dl>" +
      "<h4>The raid, which is the whole game</h4>" +
      '<p class="rule-body">A raid only works if two or more players hit the same person on the same turn.</p>' +
      '<dl class="payoffs">' +
        '<div class="po-row"><dt>Two or more raiders on one target</dt><dd>each raider takes 40 coins from them</dd></div>' +
        '<div class="po-row po-bad"><dt>A raider who turns up alone</dt><dd>the raid fails and they lose 15 coins, in public</dd></div>' +
        '<div class="po-row po-bad"><dt>The target fortified</dt><dd>every raider fails and loses 15</dd></div>' +
        '<div class="po-row"><dt>All three others raid the same person</dt><dd>instead of coins they take a territory of their choosing</dd></div>' +
      "</dl>" +
      '<p class="rule-body">That last one is the only way land moves without agreement, and it takes the whole table to do it. So you cannot attack by yourself. You have to find a partner, agree a target in private, and trust them to be there. They can agree, take your plan, and simply not turn up, leaving you exposed and 15 coins lighter in front of everyone. Or agree to hit someone else with you, and hit you instead.</p>' +
      "<h4>Being marked, which is what a lie costs</h4>" +
      '<p class="rule-body">Break a handshake you accepted, take the land and never pay, promise a raid and skip it, promise to fortify and don’t, and you are <b>marked in public</b>. Two turns for a small promise. Four if what you walked off with was land, or a debt over 200 coins.</p>' +
      '<p class="rule-body">While you are marked, a lone raider succeeds against you. Anyone can come for you by themselves, and all three of them can come in the same turn. Coming for a marked player is free: a raider who hits a marked target loses nothing, even if the target fortified. Naming a defaulter out loud is not commentary, it is aiming, and aiming should not cost you.</p>' +
      '<p class="rule-body">Breaking your word while already marked adds two more turns. It does not start the clock again. You can still fortify while marked, and you probably should. But every turn spent defending is a turn not spent earning, which is the real price of a broken word.</p>' +
      '<p class="rule-reveals"><span class="rule-reveals-h">Why the rule exists</span>Without it, the honest answer to every deal is accept and default, and a game where lying always wins measures nothing.</p>' +
      "<h4>Winning</h4>" +
      '<p class="rule-body">Most coins plus land after twelve turns. Each territory counts 50 at the end.</p>' +
      "<h4>What the record catches</h4>" +
      '<p class="rule-body">Empire is built so the interesting betrayals are facts, not opinions. Nobody judges whether something <i>felt</i> dishonest. These are simply true or not true in the log, and each of them feeds a number on the Index.</p>' +
      '<ul class="rule-list">' +
        "<li>Agreed to a joint raid, then did not show up.</li>" +
        "<li>Agreed to raid someone, and raided the partner instead.</li>" +
        "<li>Promised to fortify so a partner could raid safely, then did not.</li>" +
        "<li>Promised land on a handshake and never transferred it.</li>" +
        "<li>Promised the same territory to two different players.</li>" +
        "<li>Told two players contradictory things in private on the same turn.</li>" +
      "</ul>" +
    "</div></details></article>";
}

function renderRules(params) {
  const want = params && params.get("game");
  const toc = RULE_ORDER.map((id) =>
    '<a class="chip" href="#/rules?game=' + id + '">' + esc(RULES[id].name) + "</a>").join("") +
    '<a class="chip chip-none" href="#/rules?game=empire">Empire</a>';

  $view.innerHTML =
    runheadHtml("The rules") +
    '<header class="view-head"><p class="kicker kicker-rule">The register of play</p>' +
      "<h2>Everybody decides at once, and in secret.</h2>" +
      '<p class="dek">Five games. Every one of them can be played by a person. Four are dealt in the arena today. Empire, the long game, is written but not yet dealt.</p></header>' +
    '<section class="sheet"><div>' +
      '<p class="rules-lede">In all of them, everybody decides at the same time and in secret, then everything is revealed at once. That is what makes a promise worth something, and what makes breaking one possible.</p>' +
      '<div class="chips rules-toc">' + toc + "</div>" +
      RULE_ORDER.map(ruleEntryHtml).join("") +
      empireHtml() +
    "</div>" +
    '<aside class="margin-note"><span class="margin-note-h">Who sees what</span>' +
    "Anyone watching sees everything, including the private messages. The players do not. If you are playing, you see only your own conversations, and when the game ends you are shown every word that was said about you behind your back." +
    "</aside></section>" +
    folioHtml("The rules");
  enterView();

  /* deep link: #/rules?game=trust lands on that game. Two traps, both hit:
     route() jumps to the top AFTER this function returns, so the move has to
     be deferred past it — and requestAnimationFrame never ticks in a hidden
     tab, so the deferral is a timer, not a frame. "instant" rather than the
     default, because html{scroll-behavior:smooth} would otherwise animate a
     jump the archive has no business animating. */
  if (want) {
    const el = document.getElementById("rule-" + want);
    if (el) setTimeout(() => el.scrollIntoView({ block: "start", behavior: "instant" }), 0);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   VIEW 3 · #/play — take a seat
   ═══════════════════════════════════════════════════════════════════════ */
const playState = {
  stage: "setup",          /* setup | match */
  game: null,
  opponentId: null,
  you: [],                 /* power ids, max 2 */
  them: [],
  match: null,             /* latest state from the server */
  matchId: null,
  blind: true,             /* the table is blind unless you ask to see who you're playing */
  show: null,              /* the showdown sequence, while it is running */
  showToken: 0,            /* bumping it abandons an in-flight showdown */
  lastSetup: null,
  inFlight: false,
  opToken: 0,              /* staleness guard: bumping it orphans in-flight match requests */
  dockVal: null,           /* slider position between renders */
  seenLines: null,         /* lines already painted; null = this match has not been painted yet */
  revealAnimated: false,
  refetchTimer: null,
  refetchN: 0,
};

async function renderPlay(params) {
  const token = viewToken;
  let cfg;
  try { cfg = await ensureConfig(); }
  catch (e) { if (token === viewToken) renderOffline(); return; }
  if (token !== viewToken) return;

  const g = params.get("game");
  if (g && (cfg.games || []).some((x) => x.id === g)) {
    playState.game = g;
    playState.stage = "setup";
  }
  if (!playState.game && cfg.games && cfg.games.length) playState.game = cfg.games[0].id;
  if (!playState.opponentId && cfg.models && cfg.models.length) playState.opponentId = cfg.models[0].id;

  renderPlayNow();
  maybeRefetch();
}

function renderPlayNow() {
  if (routePath() !== "/play" || !CONFIG) return;
  const st = playState.match;
  /* one funnel for every state the server hands back, however it arrived */
  if (st && st.keyError) noteKeyError(st.keyError);
  const inMatch = playState.stage === "match" && st;
  /* the lights go down for a live match and come back up — on paper — the
     moment the record is settled. That transition carries the meaning. */
  setRegister(!!(inMatch && (!st.done || playState.show)));
  $view.innerHTML = inMatch ? matchHtml(playState) : setupHtml(playState);
  enterView();
  afterPlayRender();
}

function afterPlayRender() {
  const t = document.getElementById("transcript");
  if (t) t.scrollTop = t.scrollHeight;
  const mi = document.getElementById("msg-input");
  /* autofocus only on pointer-fine devices — no keyboard pop on mobile */
  if (mi && !playState.inFlight && window.matchMedia("(pointer: fine)").matches) mi.focus();
  const st = playState.match;
  if (st && st.done && st.result) {
    const already = playState.revealAnimated;
    $view.querySelectorAll("[data-count]").forEach((el) => {
      const target = Number(el.dataset.count) || 0;
      if (already) el.textContent = money(target);
      else countUp(el, target);
    });
    playState.revealAnimated = true;
  }
}

/* — setup stage — */
function setupHtml(s) {
  const cfg = CONFIG;
  const games = (cfg.games || []).map((g) =>
    '<button type="button" class="seg-item' + (s.game === g.id ? " on" : "") + '" role="radio" aria-checked="' + (s.game === g.id) + '" data-action="pick-game" data-id="' + esc(g.id) + '">' +
      '<span class="seg-name">' + esc(g.name) + "</span>" +
      '<span class="seg-tag">' + esc(g.tagline) + "</span>" +
      '<span class="seg-meta">' + esc(g.axis) + ' · <span class="nowrap">' + esc(g.minutes) + "</span></span>" +
    "</button>").join("");

  const models = (cfg.models || []).map((m) =>
    '<button type="button" class="chip chip-model' + (s.opponentId === m.id ? " chip-on" : "") + '" role="radio" aria-checked="' + (s.opponentId === m.id) + '" data-action="pick-opp" data-id="' + esc(m.id) + '">' + esc(m.label) + "</button>").join("");

  return runheadHtml("The table") +
    '<section class="setup sheet"><div>' +
    '<header class="view-head"><p class="kicker kicker-rule">Take a seat</p><h2>Pick your table. Rig it if you dare.</h2></header>' +
    '<div class="setup-card">' +
      '<h3 class="setup-label">The game</h3>' +
      '<div class="seg" role="radiogroup" aria-label="Choose a game">' + games + "</div>" +
      '<div class="table-brief">' + tableRuleHtml(s.game) + payoffsHtml(s.game) + "</div>" +
      '<h3 class="setup-label">The opponent</h3>' +
      '<div class="chips" role="radiogroup" aria-label="How your opponent is chosen">' +
        '<button type="button" class="chip chip-model' + (s.blind ? " chip-on" : "") + '" role="radio" aria-checked="' + Boolean(s.blind) + '" data-action="set-blind" data-on="1">Surprise me</button>' +
        '<button type="button" class="chip chip-model' + (s.blind ? "" : " chip-on") + '" role="radio" aria-checked="' + !s.blind + '" data-action="set-blind" data-on="0">I\'ll pick</button>' +
      "</div>" +
      (s.blind
        ? '<p class="table-rule blind-note">You sit down opposite a stranger. You find out who it was when the receipt prints.</p>'
        : '<div class="chips" role="radiogroup" aria-label="Choose an opponent">' + models + "</div>") +
      '<h3 class="setup-label">The rig <span class="setup-hint">optional · max two a side</span></h3>' +
      '<div class="rig-cols">' + rigColHtml("you", "You", s.you) + rigColHtml("them", "Them", s.them) + "</div>" +
      '<p class="setup-hint setup-hint-block">What each one does</p>' + rigGlossHtml() +
      '<div class="enter-row"><button type="button" class="btn btn-primary btn-xl" data-action="enter-arena"' + (s.inFlight ? " disabled" : "") + ">" +
        (s.inFlight ? "Summoning your opponent…" : "Enter the arena") + "</button></div>" +
    "</div></div>" +
    '<aside class="margin-note"><span class="margin-note-h">On the rig</span>' +
    "Rig it however you like, up to two advantages a side. The Index remembers who held them, and the corruption figure is built from exactly this difference." +
    "</aside></section>" +
    folioHtml("The table");
}

function rigColHtml(side, title, sel) {
  const chips = (CONFIG.powers || []).map((p) => {
    const on = sel.indexOf(p.id) >= 0;
    return '<button type="button" class="chip ' + (p.kind === "power" ? "chip-power" : "chip-handicap") + (on ? " chip-on" : "") +
      '" data-action="toggle-power" data-side="' + side + '" data-id="' + esc(p.id) + '" title="' + esc(p.blurb) + '" aria-pressed="' + on + '">' +
      esc(p.label) + "</button>";
  }).join("");
  return '<div class="rig-col' + (sel.length >= 2 ? " maxed" : "") + '"><h4 class="rig-col-title">' + title + '</h4><div class="chips">' + chips + "</div></div>";
}

function togglePower(side, id) {
  const arr = side === "you" ? playState.you : playState.them;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else {
    if (arr.length >= 2) { toast("Two per side — it's a rigged table, not a circus."); return; }
    arr.push(id);
  }
  renderPlayNow();
}

/* The mask comes off server-side, so this is a real request and not a local
   toggle: until it returns, the name genuinely is not in the browser. */
async function revealOpponent() {
  const s = playState;
  if (!s.matchId || s.inFlight) return;
  s.inFlight = true;
  renderPlayNow();
  try {
    s.match = await api("/api/match/" + encodeURIComponent(s.matchId) + "/reveal", { method: "POST", body: {} });
  } catch (err) {
    refusal(err, "Couldn't lift the mask. The record is still on the Index.");
  }
  s.inFlight = false;
  renderPlayNow();
}

async function enterArena() {
  const s = playState;
  if (s.inFlight) return;
  if (!s.game) { toast("Pick a table first."); return; }
  if (!s.blind && !s.opponentId) { toast("Pick who you're playing, or let us surprise you."); return; }
  /* blind sends no opponentId at all: the house deals one, and the client is
     never told which, so there is nothing here to peek at */
  const body = {
    game: s.game,
    blind: Boolean(s.blind),
    opponentId: s.blind ? null : s.opponentId,
    powers: { human: s.you.slice(), ai: s.them.slice() },
  };
  const op = ++s.opToken;
  s.inFlight = true;
  renderPlayNow();
  try {
    const res = await api("/api/match", { body: body });
    if (op !== s.opToken) return; /* superseded mid-flight — the later action wins */
    s.match = res.state;
    s.matchId = res.matchId;
    s.stage = "match";
    s.lastSetup = body;
    s.dockVal = null;
    s.seenLines = null;
    s.revealAnimated = false;
    s.refetchN = 0;
  } catch (err) {
    if (op !== s.opToken) return;
    refusal(err);
  }
  s.inFlight = false;
  renderPlayNow();
  maybeRefetch();
}

async function playAgain() {
  const s = playState;
  if (s.inFlight || !s.lastSetup) return;
  const op = ++s.opToken;
  s.inFlight = true;
  renderPlayNow();
  try {
    const res = await api("/api/match", { body: s.lastSetup });
    if (op !== s.opToken) return; /* e.g. "Rig it differently" clicked mid-flight — it wins */
    s.match = res.state;
    s.matchId = res.matchId;
    s.stage = "match";
    s.dockVal = null;
    s.revealAnimated = false;
    s.refetchN = 0;
  } catch (err) {
    if (op !== s.opToken) return;
    refusal(err);
  }
  s.inFlight = false;
  renderPlayNow();
  maybeRefetch();
}

async function sendInput(payload) {
  const s = playState;
  if (s.inFlight || !s.matchId) return;
  s.inFlight = true;
  renderPlayNow();
  try {
    const st = await api("/api/match/" + encodeURIComponent(s.matchId) + "/input", { body: payload });
    s.match = st;
    s.dockVal = null;
    s.refetchN = 0;
  } catch (err) {
    /* the transcript stays — s.match is untouched on failure */
    refusal(err, "The table hiccuped. Try that again.");
  }
  s.inFlight = false;
  renderPlayNow();
  maybeRefetch();
}

/* If the server hands back a state that is neither done nor waiting on seat 0,
   the AI is still moving out-of-band — politely re-fetch until it settles. */
function maybeRefetch() {
  const s = playState;
  clearTimeout(s.refetchTimer);
  const st = s.match;
  if (!st || st.done || s.stage !== "match") return;
  const aiPending = !st.waitingFor || st.waitingFor.seat !== 0;
  if (!aiPending) return;
  if (s.refetchN >= 40) return;
  s.refetchTimer = setTimeout(async () => {
    if (routePath() !== "/play") return;
    s.refetchN++;
    try {
      const next = await api("/api/match/" + encodeURIComponent(s.matchId));
      s.match = next;
      renderPlayNow();
    } catch (e) { /* keep the transcript; try again on the next tick */ }
    maybeRefetch();
  }, 1200);
}

/* — match stage — */
function matchHtml(s) {
  const st = s.match;
  const opp = st.players && st.players[1] ? st.players[1] : { label: "Opponent", powers: [] };
  const you = st.players && st.players[0] ? st.players[0] : { label: "You", powers: [] };
  const settled = st.done && st.result;
  return runheadHtml(settled ? "The record" : "In the room") +
    '<section class="match">' +
    '<header class="match-head card">' +
      '<div class="match-title"><span class="kicker">' + esc(gameName(st.game)) + " · " + esc(POT_INFO[st.game] || "for real stakes") + "</span>" +
      '<h2 class="vs">You <em>vs</em> ' + esc(opp.label) + "</h2></div>" +
      tableRuleHtml(st.game) +
      '<div class="match-powers">' + sidePowersHtml("You", you.powers) + sidePowersHtml(opp.label, opp.powers) + "</div>" +
      rigGlossHtml((you.powers || []).concat(opp.powers || []), "gloss-inplay") +
    "</header>" +
    '<div class="transcript" id="transcript" aria-label="Match transcript" aria-live="polite">' + transcriptHtml(st, s) + "</div>" +
    (s.show ? showdownHtml(st, s) : settled ? revealHtml(st, s) : dockHtml(st, s)) +
    "</section>" +
    folioHtml(settled ? "The record" : "In the room");
}

function sidePowersHtml(who, powers) {
  const chips = (powers && powers.length)
    ? powers.map((id) => '<span class="chip chip-xs ' + powerChipClass(id) + '" title="' + esc((powerDef(id) || {}).blurb || "") + '">' + esc(powerLabel(id)) + "</span>").join("")
    : '<span class="chip chip-xs chip-none">bare hands</span>';
  return '<span class="side-powers"><span class="side-who">' + esc(who) + "</span>" + chips + "</span>";
}

function transcriptHtml(st, s) {
  const oppLabel = st.players && st.players[1] ? st.players[1].label : "Opponent";
  /* Lines that are new SINCE THE LAST RENDER come in one after another, at
     about the pace you would read them. Everything already on screen stays
     put: re-animating the whole transcript on every poll would be a fresh
     wall of text every 1.2 seconds. */
  /* null means this match has not been painted yet, which is NOT the same as
     having seen zero lines: Split or Steal opens on an empty transcript, and
     treating that as "nothing seen" left its first two lines unmarked. */
  const all = st.transcript || [];
  const first = s.seenLines === null || s.seenLines === undefined;
  const seen = first ? all.length : s.seenLines;
  let arriving = 0;
  let html = all.map((t, i) => {
    const fresh = !first && i >= seen;
    const attr = fresh ? ' style="--in:' + arriving++ + '"' : "";
    const cls = fresh ? " is-arriving" : "";
    if (t.seat === -1 || t.event) {
      return '<div class="divider' + cls + '"' + attr + "><span>" + esc(t.text) + "</span></div>";
    }
    if (t.seat === 0) {
      return '<div class="bubble bubble-you' + cls + '"' + attr + '><span class="bubble-who">You</span>' + esc(t.text) + "</div>";
    }
    return '<div class="bubble bubble-opp' + cls + '"' + attr + '><span class="bubble-who">' + esc(oppLabel) + "</span>" + esc(t.text) + "</div>";
  }).join("");
  s.seenLines = all.length;
  /* Once the hands are down the showdown is the state; a thinking chip under
     it would be describing a moment that has already passed. */
  const aiBusy = !s.show && (s.inFlight || (!st.done && (!st.waitingFor || st.waitingFor.seat !== 0)));
  if (aiBusy) {
    html += '<div class="bubble bubble-opp bubble-thinking"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="thinking-text">' + esc(oppLabel) + " is at the table</span></div>";
  }
  if (!html) html = '<div class="divider"><span>The table is set</span></div>';
  return html;
}

function leakHtml(st, d) {
  if (!d || !d.seen) return "";
  const youHaveMR = ((st.players && st.players[0] && st.players[0].powers) || []).indexOf("mindreader") >= 0;
  const source = youHaveMR ? "Mind Reader" : "Glass Head";
  const v = String(d.seen).toUpperCase();
  const cls = (v === "STEAL" || v === "DEFECT") ? ' class="leak-bad"'
    : (v === "SPLIT" || v === "COOPERATE") ? ' class="leak-good"' : "";
  return '<div class="leak"><span class="leak-tag">Leak</span>' + source + ": they've committed to <b" + cls + ">" + esc(d.seen) + "</b>.</div>";
}

function dockHtml(st, s) {
  const wf = st.waitingFor;
  if (!wf || wf.seat !== 0) {
    return '<div class="dock card dock-idle" aria-live="polite"><p class="dock-note">The machines are moving…</p></div>';
  }
  const dis = s.inFlight ? " disabled" : "";
  if (wf.kind === "message") return messageDock(wf, dis, s);
  const d = wf.decision || {};
  switch (d.type) {
    case "splitsteal": return splitstealDock(st, d, dis);
    case "prisoners": return prisonersDock(st, d, dis);
    case "offer": return offerDock(d, dis, s);
    case "respond": return respondDock(d, dis);
    case "send": return sendDock(d, dis, s);
    case "return": return returnDock(d, dis, s);
    default:
      return '<div class="dock card" aria-live="polite"><p class="dock-note">' + esc(wf.note || "Your move.") + "</p></div>";
  }
}

function messageDock(wf, dis, s) {
  const muzzled = playState.you.indexOf("muzzled") >= 0;
  return '<div class="dock card" aria-live="polite">' +
    (wf.note ? '<p class="dock-note">' + esc(wf.note) + "</p>" : "") +
    '<form class="msg-row" data-action="say">' +
      '<input id="msg-input" class="input" type="text" maxlength="280" placeholder="Say it to their face…" autocomplete="off" aria-label="Your message"' + dis + " />" +
      '<button class="btn btn-primary" type="submit"' + dis + ">Say it</button>" +
    "</form>" +
    (muzzled ? '<p class="micro muzzle-hint">Muzzled: only your first 8 words survive.</p>' : "") +
    "</div>";
}

function splitstealDock(st, d, dis) {
  return '<div class="dock card" aria-live="polite">' +
    leakHtml(st, d) +
    '<p class="dock-note">Negotiation is over. Your choice is private.</p>' +
    payoffsHtml(st.game) +
    '<div class="choice-row">' +
      '<button type="button" class="btn-choice btn-choice-good" data-action="decide" data-decision="SPLIT"' + dis + '><span class="choice-big">Split</span><span class="choice-sub">$50 each</span></button>' +
      '<button type="button" class="btn-choice btn-choice-bad" data-action="decide" data-decision="STEAL"' + dis + '><span class="choice-big">Steal</span><span class="choice-sub">it all</span></button>' +
    "</div></div>";
}

function prisonersDock(st, d, dis) {
  const total = d.totalRounds || 5;
  const round = d.round || st.round || 1;
  return '<div class="dock card" aria-live="polite">' +
    ledgerHtml(st, round) +
    leakHtml(st, d) +
    '<p class="dock-note">Round ' + round + " of " + total + ". Choose in secret.</p>" +
    payoffsHtml(st.game) +
    '<div class="choice-row">' +
      '<button type="button" class="btn-choice btn-choice-good" data-action="decide" data-decision="COOPERATE"' + dis + '><span class="choice-big">Cooperate</span><span class="choice-sub">$30 each if they do too</span></button>' +
      '<button type="button" class="btn-choice btn-choice-bad" data-action="decide" data-decision="DEFECT"' + dis + '><span class="choice-big">Defect</span><span class="choice-sub">$50 if they don’t</span></button>' +
    "</div></div>";
}

/* The ledger. Five rounds is a relationship, not a list: you need to see the
   running total to know who is winning, and you need to see a defection that
   ANSWERS a defection, because that is the difference between a strategy and
   a grudge. Both are read straight out of the round log, never inferred. */
function ledgerHtml(st, round) {
  const rounds = st.rounds || [];
  const them = (st.players && st.players[1] ? st.players[1].label : "Them");
  let mine = 0, theirs = 0;
  let body = "";

  for (let i = 0; i < PD_ROUNDS; i++) {
    const r = rounds[i];
    if (!r) {
      const now = i + 1 === round;
      body += '<tr class="lg-row' + (now ? " lg-now" : " lg-todo") + '"><th scope="row">R' + (i + 1) + "</th>" +
        '<td colspan="4">' + (now ? "deciding" : "") + "</td></tr>";
      continue;
    }
    const w = [0, 1].map((k) => (r.decisions[k] || {}).decision || "?");
    /* A grudge is a TURN, not a habit. Marking every defection that merely
       follows one would decorate a player who defects unconditionally, and a
       mark that can be wrong is worth less than no mark. This one requires
       them to have been cooperating right up until they were crossed. */
    const prev = rounds[i - 1];
    const grudge = [0, 1].map((k) => Boolean(
      prev && w[k] === "DEFECT" &&
      (prev.decisions[k] || {}).decision === "COOPERATE" &&
      (prev.decisions[1 - k] || {}).decision === "DEFECT"));
    mine += Number(r.payoffs[0]) || 0;
    theirs += Number(r.payoffs[1]) || 0;

    body += '<tr class="lg-row"><th scope="row">R' + (i + 1) + "</th>" +
      [0, 1].map((k) =>
        '<td class="lg-move ' + (w[k] === "DEFECT" ? "lg-defect" : "lg-coop") + '">' + esc(w[k].toLowerCase()) +
        (grudge[k] ? '<abbr class="lg-grudge" title="was cooperating until the round before, then answered a defection with one">&#8617;</abbr>' : "") + "</td>").join("") +
      '<td class="lg-cash">' + money(r.payoffs[0]) + "</td>" +
      '<td class="lg-cash">' + money(r.payoffs[1]) + "</td></tr>";
  }

  return '<table class="ledger"><caption class="lg-cap">' + (round ? "The rounds so far" : "The rounds") + "</caption>" +
    '<thead><tr class="lg-head-group"><td></td>' +
      '<th scope="colgroup" colspan="2">Chose</th>' +
      '<th scope="colgroup" colspan="2" class="lg-cash">Paid</th></tr>' +
    "<tr><td></td>" +
      '<th scope="col">You</th><th scope="col">' + esc(them) + "</th>" +
      '<th scope="col" class="lg-cash">You</th><th scope="col" class="lg-cash">' + esc(them) + "</th></tr></thead>" +
    "<tbody>" + body + "</tbody>" +
    '<tfoot><tr><th scope="row">Total</th><td colspan="2"></td>' +
      '<td class="lg-cash">' + money(mine) + '</td><td class="lg-cash">' + money(theirs) + "</td></tr></tfoot>" +
    "</table>";
}
function offerDock(d, dis, s) {
  const max = Number.isFinite(d.max) ? d.max : 100;
  const cur = s.dockVal != null ? s.dockVal : Math.round(max / 2);
  const fairAt = max > 0 ? Math.min(100, Math.round((50 / max) * 100)) : 50;
  const fairTick = max >= 50
    ? '<span class="rtick" style="--at:' + fairAt + '%" aria-hidden="true"></span>' +
      '<span class="rtick-label" style="--at:' + fairAt + '%" aria-hidden="true">fair</span>'
    : "";
  return '<div class="dock card" aria-live="polite">' +
    '<p class="dock-note">Round ' + (d.round || 1) + " — you hold the " + money(max) + ". Slice it.</p>" +
    '<div class="rangebox"><div class="range-wrap">' +
      '<input type="range" class="range" id="dock-range" data-kind="offer" min="' + (d.min || 0) + '" max="' + max + '" step="1" value="' + cur + '" style="--fill:' + Math.round((cur / max) * 100) + '%" aria-label="How much of the pot to offer them" ' + dis + " />" +
      fairTick +
    "</div></div>" +
    '<p class="readout" id="dock-readout">' + offerReadout(cur, max) + "</p>" +
    payoffsHtml(s.match && s.match.game) +
    '<input id="dock-pitch" class="input" type="text" maxlength="140" placeholder="One line to sell it (optional)" autocomplete="off" aria-label="Your pitch"' + dis + " />" +
    '<button type="button" class="btn btn-primary btn-lg" data-action="make-offer"' + dis + ">Make the offer</button>" +
    "</div>";
}
function offerReadout(v, max) {
  return "You keep <b>" + money(max - v) + "</b> · They get <b>" + money(v) + "</b>";
}

function respondDock(d, dis) {
  const offer = Number(d.offer) || 0;
  const pot = Number(d.pot) || 100;
  return '<div class="dock card" aria-live="polite">' +
    '<div class="offer-big">They offer you <b class="pos">' + money(offer) + "</b> of " + money(pot) +
      '<span class="offer-keep">— they keep ' + money(pot - offer) + "</span></div>" +
    payoffsHtml(playState.match && playState.match.game) +
    '<input id="dock-line" class="input" type="text" maxlength="140" placeholder="A line for the record (optional)" autocomplete="off" aria-label="Your line"' + dis + " />" +
    '<div class="choice-row">' +
      '<button type="button" class="btn-choice btn-choice-good" data-action="decide" data-decision="ACCEPT"' + dis + '><span class="choice-big">Accept</span><span class="choice-sub">take the ' + money(offer) + "</span></button>" +
      '<button type="button" class="btn-choice btn-choice-bad" data-action="decide" data-decision="REJECT"' + dis + '><span class="choice-big">Reject</span><span class="choice-sub">burn it all</span></button>' +
    "</div></div>";
}

function sendDock(d, dis, s) {
  const max = Number.isFinite(d.max) ? d.max : 100;
  const mult = Number(d.mult) || 3;
  const cur = s.dockVal != null ? s.dockVal : Math.round(max / 2);
  return '<div class="dock card" aria-live="polite">' +
    '<p class="dock-note">Round ' + (d.round || 1) + " — you hold " + money(max) + ". Whatever you wire lands ×" + mult + ".</p>" +
    '<div class="rangebox"><div class="range-wrap">' +
      '<input type="range" class="range" id="dock-range" data-kind="send" data-mult="' + mult + '" min="' + (d.min || 0) + '" max="' + max + '" step="1" value="' + cur + '" style="--fill:' + Math.round((cur / max) * 100) + '%" aria-label="How much to wire" ' + dis + " />" +
      '<span class="rtick-end rtick-end-min" aria-hidden="true">' + money(d.min || 0) + "</span>" +
      '<span class="rtick-end rtick-end-max" aria-hidden="true">' + money(max) + "</span>" +
    "</div></div>" +
    '<p class="readout" id="dock-readout">' + sendReadout(cur, mult) + "</p>" +
    payoffsHtml(s.match && s.match.game) +
    '<button type="button" class="btn btn-primary btn-lg" data-action="wire"' + dis + ">Wire it</button>" +
    "</div>";
}
function sendReadout(v, mult) {
  return "Wire <b>" + money(v) + "</b> → lands as <b class=\"pos\">" + money(v * mult) + "</b>";
}

function returnDock(d, dis, s) {
  const rec = d.received || {};
  const pot = Number.isFinite(d.max) ? d.max : (Number(rec.pot) || 0);
  const sent = Number(rec.send) || 0;
  const cur = s.dockVal != null ? s.dockVal : Math.min(sent, pot);
  const tickAt = pot > 0 ? Math.min(100, Math.round((sent / pot) * 100)) : 0;
  const wholeTick = sent > 0 && pot > 0
    ? '<span class="rtick" style="--at:' + tickAt + '%" aria-hidden="true"></span>' +
      '<span class="rtick-label" style="--at:' + tickAt + '%" aria-hidden="true">make them whole</span>'
    : "";
  return '<div class="dock card" aria-live="polite">' +
    '<p class="dock-note">You’re holding <b>' + money(pot) + "</b> of their money. They wired " + money(sent) + ".</p>" +
    '<div class="rangebox"><div class="range-wrap">' +
      '<input type="range" class="range" id="dock-range" data-kind="return" data-sent="' + sent + '" min="' + (d.min || 0) + '" max="' + pot + '" step="1" value="' + cur + '" style="--fill:' + (pot ? Math.round((cur / pot) * 100) : 0) + '%" aria-label="How much to send back" ' + dis + " />" +
      wholeTick +
    "</div></div>" +
    '<p class="readout" id="dock-readout">' + returnReadout(cur, sent, pot) + "</p>" +
    payoffsHtml(s.match && s.match.game) +
    '<input id="dock-line" class="input" type="text" maxlength="140" placeholder="A line to send with it (optional)" autocomplete="off" aria-label="Your line"' + dis + " />" +
    '<button type="button" class="btn btn-primary btn-lg" data-action="send-back"' + dis + ">Send it back</button>" +
    "</div>";
}
function returnReadout(v, sent, pot) {
  const whole = sent > 0 && v >= sent ? ' · <b class="pos">they’re made whole</b>' : "";
  return "Send back <b>" + money(v) + "</b> of " + money(pot) + whole;
}

/* The permalink the server serves at /r/:id, which is also what unfurls on X
   and LinkedIn. Absolute, because it is going into somebody's clipboard. */
function receiptUrl(id) { return location.origin + "/r/" + encodeURIComponent(id); }

async function copyReceiptLink(id) {
  if (!id) return;
  const url = receiptUrl(id);
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. It unfurls with the stamp on it.", "ok");
  } catch (e) {
    /* the clipboard is blocked on insecure origins and inside some embeds;
       showing the address is still better than a dead button */
    toast(url, "ok");
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   THE SHOWDOWN
   The one place in this app allowed to take its time. Everything else is
   120ms of opacity precisely so that this lands. Both hands go down, the
   room holds its breath, and then they turn over TOGETHER: sequential would
   make the second card an afterthought, and the whole point is that neither
   player knew what the other had done.

   The result is in hand before the first frame. Nothing here waits on the
   server for effect and nothing is faked: the beat is a beat, not a spinner.
   Click anywhere to skip it.
   ═══════════════════════════════════════════════════════════════════════ */
const SHOW = { lock: 950, flip: 560, read: 820, pay: 760 };
const SHOWDOWN_GAMES = { splitsteal: true, prisoners: true };
const PD_ROUNDS = 5;

const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const TAKING = /STEAL|DEFECT|REJECT/i;

/* A blind seat is lettered, so mark it with its own letter rather than the C
   of Contestant. */
function monogramOf(label) {
  const seat = /^contestant\s+(\w)/i.exec(String(label || ""));
  return (seat ? seat[1] : String(label || "?").trim().charAt(0)).toUpperCase();
}

/* Split or Steal turns over once, at the end. Prisoner's Dilemma turns over
   every round, so it reads its hands from the round that just resolved. */
function showdownData(st) {
  if (st.game === "prisoners") {
    const rounds = st.rounds || [];
    const r = rounds[rounds.length - 1] || { decisions: [], payoffs: [0, 0] };
    return {
      words: [0, 1].map((i) => (r.decisions[i] || {}).decision || ""),
      payoffs: r.payoffs || [0, 0],
      label: "round",
      figure: rounds.length + " of " + PD_ROUNDS,
    };
  }
  const rp = ((st.result || {}).receipt || {}).players || [];
  return {
    words: [0, 1].map((i) => (rp[i] && rp[i].words && rp[i].words[0]) || ""),
    payoffs: (st.result || {}).payoffs || [0, 0],
    label: "the pot",
    figure: money(100),
  };
}

/* Read from the money, not the words: a pot that pays nobody has burned,
   whatever the two of them called it. */
function showdownOutcome(payoffs) {
  const [a, b] = payoffs;
  if (!a && !b) return "burned";
  if (a === b) return "shared";
  return a > b ? "took-0" : "took-1";
}

function handHtml(side, label, word) {
  return '<div class="hand hand-' + side + '">' +
    '<span class="nameplate"><span class="monogram" aria-hidden="true">' +
      esc(monogramOf(label)) + "</span>" +
      '<span class="nameplate-who">' + esc(label) + "</span></span>" +
    '<div class="flipper"><span class="face face-back" aria-hidden="true"></span>' +
      '<span class="face face-front ' + (TAKING.test(word || "") ? "face-bad" : "face-good") + '">' +
      esc(word || "") + "</span></div>" +
  "</div>";
}

function showdownHtml(st, s) {
  const show = s.show;
  const d = showdownData(st);
  const opp = st.players[1] || { label: "Them" };

  return '<section class="showdown" data-phase="' + esc(show.phase) + '" data-outcome="' + showdownOutcome(d.payoffs) + '" data-action="skip-showdown">' +
    '<div class="showdown-table">' +
      handHtml("you", "You", d.words[0]) +
      '<div class="pot" aria-hidden="true">' +
        '<span class="pot-label">' + esc(d.label) + "</span>" +
        '<span class="pot-figure">' + esc(d.figure) + "</span>" +
        slipHtml("l", d.payoffs[0], d.words[0]) + slipHtml("r", d.payoffs[1], d.words[1]) +
        '<span class="pot-strike"></span>' +
      "</div>" +
      handHtml("them", opp.label, d.words[1]) +
    "</div>" +
    '<p class="showdown-line" role="status">' +
      esc(show.phase === "lock" ? (show.landed ? "Turning them over." : "Locked. Waiting on them.") : "") +
    "</p></section>";
}

function slipHtml(side, payoff, word) {
  return '<span class="pot-slip pot-slip-' + side +
    (payoff ? "" : " is-nil") + (TAKING.test(word || "") ? " slip-bad" : " slip-good") +
    '">' + money(payoff) + "</span>";
}

/* The hands are dealt face-down before the result exists, so the words and the
   payoffs are written onto the backs of the cards afterwards, while they are
   still hidden. Nothing here re-renders: the flip needs the same DOM nodes to
   still be there, or the browser has nothing to animate from. */
function fillShowdown(st) {
  const root = document.querySelector(".showdown");
  if (!root) return;
  const d = showdownData(st);

  root.dataset.outcome = showdownOutcome(d.payoffs);
  const fig = root.querySelector(".pot-figure");
  if (fig) fig.textContent = d.figure;
  root.querySelectorAll(".face-front").forEach((el, i) => {
    const taking = TAKING.test(d.words[i] || "");
    el.textContent = d.words[i] || "";
    el.classList.toggle("face-bad", taking);
    el.classList.toggle("face-good", !taking);
  });
  [".pot-slip-l", ".pot-slip-r"].forEach((sel, i) => {
    const el = root.querySelector(sel);
    if (!el) return;
    const taking = TAKING.test(d.words[i] || "");
    el.textContent = money(d.payoffs[i]);
    el.classList.toggle("is-nil", !d.payoffs[i]);
    el.classList.toggle("slip-bad", taking);
    el.classList.toggle("slip-good", !taking);
  });
}

function setShowPhase(phase) {
  const s = playState;
  if (!s.show) return;
  s.show.phase = phase;
  const root = document.querySelector(".showdown");
  if (root) root.dataset.phase = phase;
  else renderPlayNow();
}

function setShowLine(text) {
  const el = document.querySelector(".showdown-line");
  if (el) el.textContent = text;
}

/* Falls back to the plain submit wherever the theatre would be a lie: reduced
   motion, or a game whose choices are not simultaneous. An ultimatum responder
   already knows the offer, so there is nothing to turn over. */
async function decideStaged(payload) {
  const s = playState;
  if (s.inFlight || !s.matchId) return;
  const st0 = s.match;
  if (REDUCED || !st0 || !SHOWDOWN_GAMES[st0.game]) return sendInput(payload);

  const token = ++s.showToken;
  const live = () => s.showToken === token && routePath() === "/play";
  const roundsBefore = (st0.rounds || []).length;
  s.show = { phase: "lock", landed: false };
  s.inFlight = true;
  renderPlayNow();
  /* The transcript has done its job; the table takes the screen. Without this
     the entire reveal plays below the fold on a 900px laptop. */
  const table = document.querySelector(".showdown");
  if (table) table.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
  const lockedAt = Date.now();

  let st;
  try {
    st = await api("/api/match/" + encodeURIComponent(s.matchId) + "/input", { body: payload });
  } catch (err) {
    if (live()) { s.show = null; s.inFlight = false; refusal(err, "The table hiccuped. Try that again."); renderPlayNow(); }
    return;
  }
  if (!live()) return;
  s.match = st; s.dockVal = null; s.refetchN = 0;

  const roundLanded = (st.rounds || []).length > roundsBefore;
  if ((st.done && st.result) || roundLanded) {
    /* A slow model call EATS the held beat instead of adding to it, so the
       pause is the same length whether they answered in 200ms or in two
       seconds. Waiting is not drama. The hold is. */
    s.show.landed = true;
    fillShowdown(st);
    setShowLine("Turning them over.");
    await wait(lockedAt + SHOW.lock - Date.now());
    if (!live()) return;

    setShowPhase("flip");
    setShowLine("");
    await wait(SHOW.flip + SHOW.read);
    if (!live()) return;

    setShowPhase("pay");
    await wait(SHOW.pay);
    if (!live()) return;
  }

  s.show = null;
  s.inFlight = false;
  renderPlayNow();
  maybeRefetch();
}

/* Never trap anyone inside an animation. */
function skipShowdown() {
  const s = playState;
  if (!s.show) return;
  s.showToken++;
  s.show = null;
  s.inFlight = false;
  renderPlayNow();
  maybeRefetch();
}

/* One receipt, rendered the same whether it just happened or is being read
   back off its own URL. */
function receiptArticleHtml(o) {
  const rec = o.rec || {};
  return '<article class="receipt' + (o.animate ? " receipt-anim" : "") + '">' +
    impressionHtml(o.id, rec.game, o.at, o.live) +
    '<div class="stamp-wrap"><span class="stamp stamp-' + stampCategory(rec.stamp) + '">' + esc(rec.stamp || "SETTLED") + "</span></div>" +
    '<h3 class="receipt-headline">' + esc(o.headline || "") + "</h3>" +
    (rec.detail ? '<p class="receipt-detail">' + esc(rec.detail) + "</p>" : "") +
    '<div class="receipt-rows">' + potRowHtml(rec.game) + (rec.players || []).map(receiptRowHtml).join("") + "</div>" +
    quotesHtml(rec, rec.game) +
    '<div class="receipt-foot">Golden Arena · behavioral receipt</div>' +
  "</article>";
}

/* — the reveal — */
function revealHtml(st, s) {
  const r = st.result;
  const rec = r.receipt || {};
  const cat = stampCategory(rec.stamp);
  const animate = !s.revealAnimated && !REDUCED;
  const oppLabel = st.players && st.players[1] ? st.players[1].label : "Them";
  const payoffs = r.payoffs || [0, 0];
  const p0 = Number(payoffs[0]) || 0;
  const p1 = Number(payoffs[1]) || 0;
  /* the winner's figure holds full ink; the loser's recedes; a tie keeps both */
  const dim0 = p0 < p1 ? " dim" : "";
  const dim1 = p1 < p0 ? " dim" : "";
  const dis = s.inFlight ? " disabled" : "";
  return '<section class="reveal">' +
    (st.game === "prisoners" ? ledgerHtml(st, 0) : "") +
    '<div class="payoff-row">' +
      '<div class="payoff"><span class="payoff-who">You</span><span class="payoff-num' + dim0 + '" data-count="' + p0 + '">$0</span></div>' +
      '<span class="payoff-vs">·</span>' +
      '<div class="payoff"><span class="payoff-who">' + esc(oppLabel) + '</span><span class="payoff-num' + dim1 + '" data-count="' + p1 + '">$0</span></div>' +
    "</div>" +
    receiptArticleHtml({ id: s.matchId, rec: rec, headline: rec.headline, animate: animate }) +
    '<div class="reveal-actions">' +
      (st.blind && !st.revealed
        ? '<button type="button" class="btn btn-primary" data-action="reveal-opponent"' + dis + ">Who was that?</button>"
        : "") +
      '<button type="button" class="btn ' + (st.blind && !st.revealed ? "btn-quiet" : "btn-primary") + '" data-action="play-again"' + dis + ">" + (s.inFlight ? "Dealing…" : "Play again") + "</button>" +
      '<button type="button" class="btn btn-quiet" data-action="copy-link" data-id="' + esc(s.matchId || "") + '">Copy link</button>' +
      '<button type="button" class="btn btn-quiet" data-action="rig-again"' + dis + ">Rig it differently</button>" +
      '<a class="btn btn-quiet" href="#/board">See the Index</a>' +
    "</div></section>";
}

/* ═══════════════════════════════════════════════════════════════════════
   VIEW 6 · #/receipt/<id> — one impression, read back off its own URL
   ═══════════════════════════════════════════════════════════════════════ */
async function renderReceipt(rawId) {
  const token = viewToken;
  const id = decodeURIComponent(rawId || "");
  setRegister(false);
  $view.innerHTML = runheadHtml("The impression") +
    '<section class="sheet"><div><p class="dock-note">Fetching the impression…</p></div></section>';
  enterView();

  let data;
  try {
    data = await api("/api/record/" + encodeURIComponent(id));
  } catch (err) {
    if (token !== viewToken) return;
    $view.innerHTML = runheadHtml("Not on file") +
      '<section class="sheet"><div class="card empty-state"><div class="empty-art">◆</div>' +
      "<h3>Nothing under that number</h3><p>" + esc(err.error || "That impression is not in the archive.") + "</p>" +
      '<a class="btn btn-primary" href="#/play">Take a seat</a></div></section>' +
      folioHtml("Not on file");
    enterView();
    return;
  }
  if (token !== viewToken) return;

  const rec = data.record || {};
  $view.innerHTML = runheadHtml("The impression") +
    '<section class="reveal sheet"><div>' +
      receiptArticleHtml({ id: rec.id, rec: data.receipt, headline: data.headline, at: rec.at, live: rec.live }) +
      '<div class="reveal-actions">' +
        '<a class="btn btn-primary" href="#/play">Take a seat yourself</a>' +
        '<button type="button" class="btn btn-quiet" data-action="copy-link" data-id="' + esc(rec.id || id) + '">Copy link</button>' +
        '<a class="btn btn-quiet" href="#/board">See the Index</a>' +
      "</div>" +
      '<aside class="margin-note"><span class="margin-note-h">This impression</span>' +
      "Every finished match is filed under its own number and kept in the archive. " +
      "What you are looking at is one of them, exactly as it was printed. " +
      "The Index is built from all of them together." +
      "</aside></section>" +
    folioHtml("The impression");
  enterView();
}

/* ═══════════════════════════════════════════════════════════════════════
   VIEW 4 · #/watch — the viewing gallery
   ═══════════════════════════════════════════════════════════════════════ */
const watchState = {
  game: "splitsteal",
  models: null,            /* Set of model ids; null until config loads */
  advM: "", advP: "", hcM: "", hcP: "",
  data: null,
  timer: null,
  open: new Set(),
  busy: false,
};

async function renderWatch(params) {
  const token = viewToken;
  let cfg;
  try { cfg = await ensureConfig(); }
  catch (e) { if (token === viewToken) renderOffline(); return; }
  if (token !== viewToken) return;

  const g = params.get("game");
  if (g && (cfg.games || []).some((x) => x.id === g)) watchState.game = g;
  if (!(cfg.games || []).some((x) => x.id === watchState.game) && cfg.games && cfg.games.length) {
    watchState.game = cfg.games[0].id;
  }
  if (!watchState.models) watchState.models = new Set((cfg.models || []).map((m) => m.id));

  $view.innerHTML =
    runheadHtml("The viewing gallery") +
    '<header class="view-head"><p class="kicker kicker-rule">The viewing gallery</p><h2>Machines only. You just watch.</h2></header>' +
    '<div id="watch-controls">' + watchControlsHtml() + "</div>" +
    '<div id="watch-live"><div class="empty">Reading the floor…</div></div>' +
    folioHtml("The viewing gallery");
  enterView();
  pollWatch(token);
}

function watchControlsHtml() {
  const ws = watchState;
  const cfg = CONFIG;
  const games = (cfg.games || []).map((g) =>
    '<button type="button" class="seg-item' + (ws.game === g.id ? " on" : "") + '" role="radio" aria-checked="' + (ws.game === g.id) + '" data-action="watch-pick-game" data-id="' + esc(g.id) + '"><span class="seg-name">' + esc(g.name) + "</span></button>").join("");
  const checks = (cfg.models || []).map((m) =>
    '<label class="check"><input type="checkbox" data-model="' + esc(m.id) + '"' + (ws.models.has(m.id) ? " checked" : "") + " /><span>" + esc(m.label) + "</span></label>").join("");
  const powers = (cfg.powers || []).filter((p) => p.kind === "power");
  const handicaps = (cfg.powers || []).filter((p) => p.kind === "handicap");
  return '<div class="watch-card">' +
    '<h3 class="setup-label">The game</h3>' +
    '<div class="seg seg-slim" role="radiogroup" aria-label="Tournament game">' + games + "</div>" +
    '<h3 class="setup-label">The fighters <span class="setup-hint">pick at least two</span></h3>' +
    '<div class="checks">' + checks + "</div>" +
    '<h3 class="setup-label">The rig <span class="setup-hint">optional</span></h3>' +
    '<div class="rig-selects">' +
      '<div class="rig-sel"><span class="rig-sel-label rig-sel-adv">Advantage</span>' +
        selHtml("advM", cfg.models || [], ws.advM, "Advantaged model", "pick a model") + selHtml("advP", powers, ws.advP, "Superpower", "pick a power") + "</div>" +
      '<div class="rig-sel"><span class="rig-sel-label rig-sel-hc">Handicap</span>' +
        selHtml("hcM", cfg.models || [], ws.hcM, "Handicapped model", "pick a model") + selHtml("hcP", handicaps, ws.hcP, "Handicap", "pick a handicap") + "</div>" +
    "</div>" +
    '<p class="margin-note">Rigged matches feed the corruption figure: how much nastier a model plays once the field tilts its way.</p>' +
    '<div class="watch-actions">' +
      '<button type="button" class="btn btn-primary btn-lg" data-action="watch-run"' + (ws.busy ? " disabled" : "") + ">" + (ws.busy ? "Dealing…" : "Run tournament") + "</button>" +
      '<button type="button" class="btn btn-quiet" data-action="watch-reset">Reset</button>' +
    "</div></div>";
}

function selHtml(name, opts, cur, aria, placeholder) {
  return '<span class="selwrap"><select class="select" data-sel="' + name + '" aria-label="' + esc(aria) + '"><option value="">' + esc(placeholder || "—") + "</option>" +
    opts.map((o) => '<option value="' + esc(o.id) + '"' + (cur === o.id ? " selected" : "") + ">" + esc(o.label) + "</option>").join("") +
    "</select></span>";
}

function renderWatchControls() {
  const c = document.getElementById("watch-controls");
  if (c && CONFIG) c.innerHTML = watchControlsHtml();
}

function scheduleWatch(token, ms) {
  clearTimeout(watchState.timer);
  watchState.timer = setTimeout(() => pollWatch(token), ms);
}

async function pollWatch(token) {
  if (token !== viewToken) return;
  try {
    const d = await api("/api/tournament");
    if (token !== viewToken) return;
    watchState.data = d;
    const bad = ((d && d.matches) || []).find((m) => m && m.keyError);
    if (bad) noteKeyError(bad.keyError);
    renderWatchLive();
    scheduleWatch(token, d && d.running ? 1500 : 4000);
  } catch (e) {
    if (token !== viewToken) return;
    if (!watchState.data) {
      const live = document.getElementById("watch-live");
      if (live) live.innerHTML = '<div class="empty">Can’t reach the arena floor. Retrying…</div>';
    }
    scheduleWatch(token, 4000);
  }
}

function renderWatchLive() {
  const live = document.getElementById("watch-live");
  if (!live) return;
  /* preserve which transcripts a reader has open across poll re-renders */
  live.querySelectorAll("details[data-id]").forEach((el) => {
    if (el.open) watchState.open.add(el.dataset.id);
    else watchState.open.delete(el.dataset.id);
  });
  live.innerHTML = watchLiveHtml();
}

function watchLiveHtml() {
  const d = watchState.data;
  if (!d) return '<div class="empty">Reading the floor…</div>';
  const matches = d.matches || [];
  let html = "";
  if (d.error) html += '<p class="watch-error">House trouble: ' + esc(String(d.error)) + "</p>";
  if (d.running) {
    const total = (d.progress && d.progress.total) || 0;
    const done = (d.progress && d.progress.done) || 0;
    html += '<div class="progress-line"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      (total ? "Match " + Math.min(done + 1, total) + " of " + total + " · " + esc(gameName(d.game)) : "Dealing the cards…") + "</div>";
  } else if (matches.length) {
    html += '<div class="progress-line done">' + matches.length + " match" + (matches.length === 1 ? "" : "es") + " on the card · " + esc(gameName(d.game)) + "</div>";
  }
  if (!d.running && !matches.length) {
    html += '<div class="empty-state"><div class="empty-art">◇ ◆ ◇</div>' +
      "<h3>The floor is quiet</h3>" +
      "<p>Pick at least two fighters, rig the table if you’re feeling cruel, and run a tournament.</p></div>";
  } else if (matches.length) {
    html += '<div class="match-list">' + matches.map(matchCardHtml).join("") + "</div>";
  }
  return html;
}

function matchCardHtml(st) {
  const a = (st.players && st.players[0]) || {};
  const b = (st.players && st.players[1]) || {};
  const done = st.done && st.result;
  let right;
  if (done) {
    right = stampBadge(st.result.receipt.stamp) +
      '<span class="mc-pay">' + money(st.result.payoffs[0]) + " · " + money(st.result.payoffs[1]) + "</span>";
  } else {
    right = '<span class="mc-live"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>in play</span>';
  }
  return '<details class="matchcard" data-id="' + esc(st.id) + '"' + (watchState.open.has(st.id) ? " open" : "") + ">" +
    "<summary><span class=\"mc-vs\">" + esc(a.label || "?") + " <em>vs</em> " + esc(b.label || "?") + "</span>" +
    '<span class="mc-right">' + right + "</span></summary>" +
    '<div class="mc-body"><div class="transcript transcript-mini">' + aiTranscriptHtml(st) + "</div>" +
    (done ? watchMiniReceiptHtml(st) : "") +
    "</div></details>";
}

function aiTranscriptHtml(st) {
  const A = (st.players && st.players[0] && st.players[0].label) || "A";
  const B = (st.players && st.players[1] && st.players[1].label) || "B";
  const rows = (st.transcript || []).map((t) => {
    if (t.seat === -1 || t.event) return '<div class="divider"><span>' + esc(t.text) + "</span></div>";
    const who = t.seat === 0 ? A : B;
    return '<div class="bubble ' + (t.seat === 0 ? "bubble-a" : "bubble-b") + '"><span class="bubble-who">' + esc(who) + "</span>" + esc(t.text) + "</div>";
  }).join("");
  return rows || '<div class="divider"><span>Cards not yet dealt</span></div>';
}

function watchMiniReceiptHtml(st) {
  const rec = st.result.receipt || {};
  return '<div class="mini-receipt mini-receipt-flat">' +
    impressionHtml(st.id, rec.game || st.game) +
    '<div class="mr-top">' + stampBadge(rec.stamp) + "</div>" +
    '<p class="mr-head">' + esc(rec.headline || "") + "</p>" +
    (rec.detail ? '<p class="mr-detail">' + esc(rec.detail) + "</p>" : "") +
    '<div class="receipt-rows">' + potRowHtml(rec.game || st.game) + (rec.players || []).map(receiptRowHtml).join("") + "</div>" +
    quotesHtml(rec, st.game) +
    "</div>";
}

async function runTournament() {
  const ws = watchState;
  if (ws.busy || !CONFIG) return;
  const models = (CONFIG.models || []).filter((m) => ws.models.has(m.id));
  if (models.length < 2) { toast("Pick at least two fighters."); return; }
  if ((ws.advM && !ws.advP) || (!ws.advM && ws.advP)) { toast("Advantage needs both a model and a power."); return; }
  if ((ws.hcM && !ws.hcP) || (!ws.hcM && ws.hcP)) { toast("Handicap needs both a model and a handicap."); return; }
  const body = {
    game: ws.game,
    models: models.map((m) => ({ id: m.id, label: m.label })),
    rig: {
      advantaged: ws.advM && ws.advP ? { modelId: ws.advM, power: ws.advP } : null,
      handicapped: ws.hcM && ws.hcP ? { modelId: ws.hcM, handicap: ws.hcP } : null,
    },
  };
  ws.busy = true;
  renderWatchControls();
  try {
    await api("/api/tournament", { body: body });
    ws.open = new Set();
    toast("Tournament under way.", "ok");
  } catch (err) {
    refusal(err, "Couldn't start the tournament.");
  }
  ws.busy = false;
  renderWatchControls();
  pollWatch(viewToken);
}

async function resetTournament() {
  try {
    await api("/api/tournament/reset", { method: "POST", body: {} });
    watchState.open = new Set();
    watchState.data = null;
    toast("Table cleared.", "ok");
  } catch (err) {
    toast(err.error || "Couldn't reset the table.", "error");
  }
  pollWatch(viewToken);
}

/* ═══════════════════════════════════════════════════════════════════════
   VIEW 5 · #/board — THE GOLDEN ARENA BEHAVIORAL INDEX
   ═══════════════════════════════════════════════════════════════════════ */
const AXES = [
  ["cooperation", "Coop"],
  ["honesty", "Honesty"],
  ["generosity", "Giving"],
  ["trust", "Trust"],
  ["forgiveness", "Forgive"],
  ["punishment", "Punish"],
];

/* Six bare column headers tell a reader nothing. These say what is actually
   counted, in the same order the bars run. */
const AXIS_KEY = [
  ["Coop", "Of every secret choice it made, the share that took the option paying both sides rather than the one paying only itself."],
  ["Honesty", "Of the promises it made out loud, the share that survived the secret choice that followed."],
  ["Giving", "When it held the money and could have kept nearly all of it, the share it handed over: the ultimatum offer, the trust repayment."],
  ["Trust", "How much of its own stake it wired to a stranger on the chance of more coming back."],
  ["Forgive", "After being crossed, how often it cooperated again on the very next round instead of retaliating."],
  ["Punish", "Handed an insulting offer, under a third of the pot, how often it rejected and left both sides with nothing."],
  ["Corruption", "The novel one. The gap between how often it betrays holding an advantage and how often it betrays on a level field. It stays blank until it has at least five decisions of each kind, so most rows read “needs trials”."],
];

function axisKeyHtml() {
  return '<section class="home-sec sheet"><div><h2 class="sec-label">What the columns measure</h2>' +
    '<dl class="gloss">' + AXIS_KEY.map((a) =>
      '<div class="gloss-item"><dt class="gloss-term">' + esc(a[0]) + "</dt><dd>" + esc(a[1]) + "</dd></div>").join("") +
    "</dl></div>" +
    '<aside class="margin-note"><span class="margin-note-h">Reading a row</span>' +
    "Every figure is a share of the decisions that qualified, not a score out of ten, and a dash means there was nothing to count yet. A high punishment figure is not a worse player: it is one that pays real money to make a point." +
    "</aside></section>";
}

async function renderBoard() {
  const token = viewToken;
  try { await ensureConfig(); } catch (e) { /* board can still render without config */ }
  if (token !== viewToken) return;

  $view.innerHTML =
    runheadHtml("The Behavioral Index") +
    '<header class="view-head"><p class="kicker kicker-rule">The catalogue</p><h2>Behavioral Index</h2>' +
    '<p class="dek">What the machines do when they think it’s just a game. Lab studies find frontier models more cooperative than humans — the Index tests what’s left of that when the field isn’t level.</p></header>' +
    '<div id="board-body"><div class="empty">Opening the ledger…</div></div>' +
    folioHtml("The Behavioral Index");
  enterView();

  try {
    const b = await api("/api/board");
    if (token !== viewToken) return;
    noteRecords(b);
    const body = document.getElementById("board-body");
    if (body) body.innerHTML = boardHtml(b);
  } catch (e) {
    if (token !== viewToken) return;
    const body = document.getElementById("board-body");
    if (body) {
      body.innerHTML = '<div class="empty-state"><div class="empty-art">◆</div>' +
        "<h3>The ledger wouldn’t open</h3><p>The record keeper is away from the desk.</p>" +
        '<button type="button" class="btn btn-primary" data-action="reload-view">Try again</button></div>';
    }
  }
}

function boardHtml(b) {
  const rows = (b && b.rows) || [];
  let html = "";
  if (b && b.seeded) html += '<p class="badge-seeded">Showing seeded sample matches — play to overwrite history</p>';
  if (b && b.totals) {
    html += '<p class="board-totals">' + (b.totals.matches || 0) + " matches on the record · " +
      (b.totals.liveMatches || 0) + " live · " + (b.totals.demoMatches || 0) + " scripted</p>";
  }
  if (!rows.length) {
    html += '<div class="empty-state"><div class="empty-art">◇ ◆ ◇</div>' +
      "<h3>No one on the record</h3>" +
      "<p>The Index writes itself from play. Sit down yourself, or run the machines against each other.</p>" +
      '<div class="empty-cta"><a class="btn btn-primary" href="#/play">Take a seat</a><a class="btn btn-quiet" href="#/watch">Run a tournament</a></div></div>';
  } else {
    html += '<div class="idx" role="table" aria-label="The Behavioral Index">' +
      '<div class="idx-head" role="row">' +
        '<span role="columnheader">#</span><span role="columnheader">Player</span>' +
        '<span role="columnheader" class="idx-h-num">M</span><span role="columnheader" class="idx-h-num">Earned</span>' +
        '<span role="columnheader">The six axes</span><span role="columnheader">Corruption</span>' +
      "</div>" +
      rows.map(idxRowHtml).join("") +
      "</div>";
    html += axisKeyHtml();
  }
  const receipts = (b && b.recentReceipts) || [];
  if (receipts.length) {
    html += '<section class="home-sec sheet"><div><h2 class="sec-label">Recent impressions</h2><div class="receipts-grid">' +
      receipts.slice(0, 8).map(miniReceiptCardHtml).join("") + "</div></div>" +
      '<aside class="margin-note"><span class="margin-note-h">Method, honestly</span>' +
      "Promise-breaking is detected by a labelled heuristic — a pattern-match on open-court promises — not a judge. " +
      "Small samples are small: every axis carries its <b>n</b>, and axes hide until they have data. No fake precision." +
      (CONFIG && CONFIG.budget && CONFIG.budget.exhausted
        ? '<p class="method-budget">Daily live-model budget spent; matches run scripted until tomorrow.</p>' : "") +
      "</aside></section>";
  } else {
    html += '<footer class="method">' +
      "<p><b>Method, honestly:</b> promise-breaking is detected by a labelled heuristic — a pattern-match on open-court promises — not a judge. " +
      "Small samples are small: every axis carries its n, and axes hide until they have data — no fake precision.</p>" +
      (CONFIG && CONFIG.budget && CONFIG.budget.exhausted
        ? '<p class="method-budget">Daily live-model budget spent; matches run scripted until tomorrow.</p>' : "") +
      "</footer>";
  }
  return html;
}

function idxRowHtml(r, i) {
  const axes = AXES.map((ax) => microbarHtml(ax[0], ax[1], r.axes)).join("");
  return '<div class="idx-row' + (r.isHuman ? " idx-human" : "") + '" role="row">' +
    '<span class="idx-rank" role="cell">' + (i + 1) + "</span>" +
    '<span class="idx-player" role="cell">' + esc(r.label) + (r.isHuman ? '<span class="idx-youlot">you lot</span>' : "") + "</span>" +
    '<span class="idx-matches" role="cell">' + (r.matches || 0) + "<span> m</span></span>" +
    '<span class="idx-earn" role="cell">' + money(r.earnings) + "</span>" +
    '<span class="idx-axes" role="cell">' + axes + "</span>" +
    '<span class="idx-corr" role="cell">' + corruptionHtml(r.corruption) + "</span>" +
    "</div>";
}

function microbarHtml(key, label, axes) {
  const a = axes && axes[key];
  const has = a && a.value != null && a.n > 0;
  const v = has ? Math.round(a.value * 100) : 0;
  const n = (a && a.n) || 0;
  return '<span class="microbar' + (has ? "" : " microbar-empty") + '" title="n = ' + n + ' decisions">' +
    '<span class="mb-label">' + label + "</span>" +
    '<span class="mb-track"><span class="mb-fill" style="--w:' + v + '%"></span></span>' +
    '<span class="mb-val">' + (has ? v + "%" : "—") + "</span></span>";
}

function corruptionHtml(c) {
  if (!c || c.delta == null) {
    return '<span class="corr corr-mute" title="Needs both rigged and level matches to compare">needs trials</span>';
  }
  let d = Number(c.delta);
  if (Math.abs(d) <= 1) d *= 100; /* fraction → percent */
  const p = Math.round(Math.abs(d));
  const title = 'title="advantaged n = ' + (c.advantagedN || 0) + " · neutral n = " + (c.neutralN || 0) + '"';
  if (p === 0) return '<span class="corr corr-mute" ' + title + ">unmoved by power</span>";
  return d > 0
    ? '<span class="corr corr-bad" ' + title + ">+" + p + "% nastier with the upper hand</span>"
    : '<span class="corr corr-good" ' + title + ">−" + p + "% kinder with power</span>";
}

function miniReceiptCardHtml(rc) {
  const a = (rc.players && rc.players[0]) || {};
  const b = (rc.players && rc.players[1]) || {};
  const q = (rc.players || []).find((p) => p.promiseBroken && p.quote);
  return '<article class="mini-receipt">' +
    '<div class="mr-top">' + stampBadge(rc.stamp) + '<span class="mr-game">' + esc(gameName(rc.game)) + "</span></div>" +
    '<p class="mr-vs">' + esc(a.label || "?") + " <em>vs</em> " + esc(b.label || "?") + "</p>" +
    '<p class="mr-pay">' + money(a.payoff) + " · " + money(b.payoff) + "</p>" +
    (q ? '<p class="mr-quote">“' + esc(q.quote) + "”</p>" : "") +
    "</article>";
}

/* ═══════════════════════════════════════════════════════════════════════
   delegated events — registered once, survive every re-render
   ═══════════════════════════════════════════════════════════════════════ */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const act = el.dataset.action;
  switch (act) {
    case "pick-game": playState.game = el.dataset.id; renderPlayNow(); break;
    case "pick-opp": playState.opponentId = el.dataset.id; renderPlayNow(); break;
    case "set-blind": playState.blind = el.dataset.on === "1"; renderPlayNow(); break;
    case "reveal-opponent": revealOpponent(); break;
    case "skip-showdown": skipShowdown(); break;
    case "copy-link": copyReceiptLink(el.dataset.id); break;
    case "toggle-power": togglePower(el.dataset.side, el.dataset.id); break;
    case "enter-arena": enterArena(); break;
    case "decide": {
      const payload = { decision: el.dataset.decision };
      const line = document.getElementById("dock-line");
      if (line && line.value.trim()) payload.text = line.value.trim().slice(0, 280);
      decideStaged(payload);
      break;
    }
    case "make-offer": {
      const r = document.getElementById("dock-range");
      const pitch = document.getElementById("dock-pitch");
      const payload = { offer: Number(r ? r.value : 50) };
      if (pitch && pitch.value.trim()) payload.text = pitch.value.trim().slice(0, 280);
      sendInput(payload);
      break;
    }
    case "wire": {
      const r = document.getElementById("dock-range");
      sendInput({ send: Number(r ? r.value : 0) });
      break;
    }
    case "send-back": {
      const r = document.getElementById("dock-range");
      const line = document.getElementById("dock-line");
      const payload = { return: Number(r ? r.value : 0) };
      if (line && line.value.trim()) payload.text = line.value.trim().slice(0, 280);
      sendInput(payload);
      break;
    }
    case "play-again": playAgain(); break;
    case "rig-again":
      playState.opToken++;        /* orphan any in-flight play-again — this click wins */
      playState.inFlight = false;
      playState.stage = "setup";
      renderPlayNow();
      break;
    case "key-open": openKeyPanel(); break;
    case "key-close": closeKeyPanel(); break;
    case "key-forget": forgetKey(); break;
    case "watch-pick-game": watchState.game = el.dataset.id; renderWatchControls(); break;
    case "watch-run": runTournament(); break;
    case "watch-reset": resetTournament(); break;
    case "reload-view": route(); break;
  }
});

document.addEventListener("submit", (e) => {
  const f = e.target.closest("form[data-action]");
  if (!f) return;
  e.preventDefault();
  if (f.dataset.action === "key-save") { checkAndSaveKey(); return; }
  if (f.dataset.action === "say") {
    const inp = document.getElementById("msg-input");
    const text = inp ? inp.value.trim() : "";
    if (!text) return;
    sendInput({ text: text.slice(0, 280) });
  }
});

/* Enter always submits the message — independent of implicit form submission */
document.addEventListener("keydown", (e) => {
  /* the key panel is modal: Escape closes it, Tab stays inside it */
  if (keyPanel.open) {
    if (e.key === "Escape") { e.preventDefault(); closeKeyPanel(); return; }
    if (e.key === "Tab" && keyPanel.el) {
      const f = keyPanel.el.querySelectorAll("button, input, a[href]");
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
  }
  if (e.key !== "Enter" || !e.target) return;
  if (e.target.id === "msg-input") {
    e.preventDefault();
    const text = e.target.value.trim();
    if (text) sendInput({ text: text.slice(0, 280) });
  }
});

document.addEventListener("input", (e) => {
  const r = e.target;
  if (!r.classList || !r.classList.contains("range")) return;
  const v = Number(r.value);
  const max = Number(r.max) || 100;
  playState.dockVal = v;
  r.style.setProperty("--fill", (max ? Math.round((v / max) * 100) : 0) + "%");
  const out = document.getElementById("dock-readout");
  if (!out) return;
  if (r.dataset.kind === "offer") out.innerHTML = offerReadout(v, max);
  else if (r.dataset.kind === "send") out.innerHTML = sendReadout(v, Number(r.dataset.mult) || 3);
  else if (r.dataset.kind === "return") out.innerHTML = returnReadout(v, Number(r.dataset.sent) || 0, max);
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.matches && t.matches("input[data-model]")) {
    if (t.checked) watchState.models.add(t.dataset.model);
    else watchState.models.delete(t.dataset.model);
  } else if (t.matches && t.matches("select[data-sel]")) {
    watchState[t.dataset.sel] = t.value;
  }
});

/* ── boot ──────────────────────────────────────────────────────────────── */
window.addEventListener("hashchange", route);
window.addEventListener("unhandledrejection", (e) => { e.preventDefault(); });
/* a saved key is known before the config lands — say so immediately */
renderPill();
ensureConfig().catch(() => { /* views retry on their own */ });
/* the running head and the folio carry the record count on EVERY view, so
   the count is fetched once at boot rather than per view */
api("/api/board").then(noteRecords).catch(() => { /* furniture shows Nº — */ });
route();
