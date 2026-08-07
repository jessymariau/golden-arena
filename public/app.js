/* ═════════════════════════════════════════════════════════════════════════
   GOLDEN ARENA · app.js
   Hash-routed SPA. Zero dependencies. Views: #/ · #/play · #/watch · #/board
   ═════════════════════════════════════════════════════════════════════════ */
"use strict";

/* ── utilities ─────────────────────────────────────────────────────────── */
const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const BREATHER = "The arena needs a breather — try again in a few seconds";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function money(n) { return "$" + Math.round(Number(n) || 0).toLocaleString("en-US"); }

async function api(path, opts = {}) {
  let res;
  const init = { method: opts.method || (opts.body ? "POST" : "GET") };
  if (opts.body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw { status: 0, error: "No line to the arena — is the house awake?" };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }
  if (!res.ok) {
    throw { status: res.status, error: (data && data.error) || ("The house misdealt (" + res.status + ")") };
  }
  return data;
}

function toast(msg, kind) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " toast-error" : kind === "ok" ? " toast-ok" : "");
  el.setAttribute("role", "status");
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 3) box.removeChild(box.firstChild);
  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

function countUp(el, target) {
  if (REDUCED) { el.textContent = money(target); return; }
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
const STAMP_RED = new Set(["BETRAYAL", "MUTUAL RUIN", "TOTAL WAR", "EXPLOITATION", "SCORCHED EARTH", "SPITE", "FLEECED", "TRUST BETRAYED"]);
const STAMP_GOLD = new Set(["MUTUAL HONOR", "FAIR DEAL", "FAITH REWARDED", "UNEASY PEACE"]);
function stampCategory(s) {
  const u = String(s || "").toUpperCase();
  if (STAMP_RED.has(u)) return "red";
  if (STAMP_GOLD.has(u)) return "gold";
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

/* serial line: Nº {last 4 of match id} · DD MMM YYYY · DEMO/LIVE TABLE */
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function serialHtml(matchId) {
  const d = new Date();
  const date = String(d.getDate()).padStart(2, "0") + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  const mode = CONFIG && CONFIG.liveMode ? "LIVE TABLE" : "DEMO TABLE";
  const id = String(matchId || "").slice(-4).toUpperCase();
  return '<div class="receipt-serial">' + (id ? "Nº " + esc(id) + " · " : "") + date + " · " + mode + "</div>";
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

function renderPill() {
  const p = document.getElementById("mode-pill");
  if (!p) return;
  if (!CONFIG) {
    p.className = "pill pill-unknown";
    p.textContent = "· · ·";
    p.title = "";
    return;
  }
  if (CONFIG.liveMode) {
    p.className = "pill pill-live";
    p.innerHTML = '<i class="pill-dot"></i>LIVE';
    p.title = "Live models at the table";
  } else {
    p.className = "pill pill-demo";
    p.innerHTML = '<i class="pill-dot"></i>DEMO';
    p.title = "Scripted sparring partners — add an OpenRouter key to face real models";
  }
}

function parseHash() {
  const h = location.hash || "#/";
  const cut = h.slice(1).split("?");
  return { path: cut[0] || "/", params: new URLSearchParams(cut[1] || "") };
}
function routePath() { return parseHash().path; }

function enterView() {
  $view.classList.remove("view-in");
  void $view.offsetWidth; /* restart the entrance animation */
  $view.classList.add("view-in");
}

function renderOffline() {
  $view.innerHTML =
    '<section><div class="card empty-state"><div class="empty-art">◆</div>' +
    "<h3>The arena is dark</h3>" +
    "<p>Couldn't reach the house. Check the server, then pull the switch.</p>" +
    '<button type="button" class="btn btn-gold" data-action="reload-view">Relight the table</button></div></section>';
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
  if (path === "/play") renderPlay(params);
  else if (path === "/watch") renderWatch(params);
  else if (path === "/board") renderBoard();
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
      '<div class="game-card-foot"><span class="game-min">' + esc(g.minutes) + "</span>" +
      '<span class="game-actions">' +
        '<a class="btn btn-sm btn-gold" href="#/play?game=' + encodeURIComponent(g.id) + '">Play</a>' +
        '<a class="btn btn-sm btn-ghost" href="#/watch?game=' + encodeURIComponent(g.id) + '">Spectate</a>' +
      "</span></div></article>").join("");

  const rigChips = (cfg.powers || []).map((p) =>
    '<span class="chip ' + (p.kind === "power" ? "chip-power" : "chip-handicap") + '" title="' + esc(p.blurb) + '">' + esc(p.label) + "</span>").join("");

  $view.innerHTML =
    '<section class="hero">' +
      '<p class="kicker kicker-rule">The Golden Arena</p>' +
      '<h1 class="hero-title"><span class="foil">Can you tell when an AI is <em>lying to you?</em></span></h1>' +
      '<p class="hero-sub">Sit down opposite a frontier model. Negotiate for real stakes. Then find out what it decided behind your back. Every game feeds the Behavioral Index — the psychology leaderboard of the machines.</p>' +
      '<div class="hero-cta"><a class="btn btn-gold btn-lg" href="#/play">Take a seat</a><a class="btn btn-ghost btn-lg" href="#/board">See the Index</a></div>' +
    "</section>" +
    '<section class="home-sec"><h2 class="sec-label">The four tables</h2><div class="game-grid">' + gameCards + "</div></section>" +
    '<section class="home-sec"><div class="card rig-strip">' +
      '<h2 class="sec-label">The rig</h2>' +
      '<p class="rig-pitch">Level playing fields are boring. Hand one player a superpower. Cripple the other. Watch what power does to honesty.</p>' +
      '<div class="chips chips-center">' + rigChips + "</div>" +
    "</div></section>" +
    '<section class="home-sec"><h2 class="sec-label">The Index, currently</h2>' +
      '<div class="card teaser" id="teaser-body"><div class="teaser-loading">Opening the ledger…</div></div>' +
    "</section>" +
    '<footer class="site-foot">' +
      "<p>Promise-breaking is detected by a labelled heuristic, not a judge. Small samples are small — the Index shows its n.</p>" +
      '<p><a class="foot-link" href="https://github.com/jessymariau/golden-arena" target="_blank" rel="noopener">GitHub</a> · Built for the Replit Buildathon — remix it.</p>' +
    "</footer>";
  enterView();

  try {
    const board = await api("/api/board");
    if (token !== viewToken) return;
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
      '<a class="btn btn-gold btn-sm" href="#/play">Be the first on the record</a></div>';
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
    '<div class="teaser-cta"><a class="btn btn-ghost btn-sm" href="#/board">Full Index</a></div>';
}

/* ═══════════════════════════════════════════════════════════════════════
   VIEW 2 · #/play — take a seat
   ═══════════════════════════════════════════════════════════════════════ */
const playState = {
  stage: "setup",          /* setup | match */
  game: null,
  opponentId: null,
  you: [],                 /* power ids, max 2 */
  them: [],
  match: null,             /* latest state from the server */
  matchId: null,
  lastSetup: null,
  inFlight: false,
  opToken: 0,              /* staleness guard: bumping it orphans in-flight match requests */
  dockVal: null,           /* slider position between renders */
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
  $view.innerHTML = (playState.stage === "match" && playState.match)
    ? matchHtml(playState)
    : setupHtml(playState);
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

  return '<section class="setup">' +
    '<header class="view-head"><p class="kicker kicker-rule">Take a seat</p><h2><span class="foil">Pick your table. Rig it if you dare.</span></h2></header>' +
    '<div class="card setup-card">' +
      '<h3 class="setup-label">The game</h3>' +
      '<div class="seg" role="radiogroup" aria-label="Choose a game">' + games + "</div>" +
      '<h3 class="setup-label">The opponent</h3>' +
      '<div class="chips" role="radiogroup" aria-label="Choose an opponent">' + models + "</div>" +
      '<h3 class="setup-label">The rig <span class="setup-hint">optional · max two a side</span></h3>' +
      '<div class="rig-cols">' + rigColHtml("you", "You", s.you) + rigColHtml("them", "Them", s.them) + "</div>" +
      '<p class="micro">Rig it however you like. The Index remembers who had the advantage.</p>' +
      '<div class="enter-row"><button type="button" class="btn btn-gold btn-xl" data-action="enter-arena"' + (s.inFlight ? " disabled" : "") + ">" +
        (s.inFlight ? "Summoning your opponent…" : "Enter the arena") + "</button></div>" +
    "</div></section>";
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

async function enterArena() {
  const s = playState;
  if (s.inFlight) return;
  if (!s.game || !s.opponentId) { toast("Pick a game and an opponent first."); return; }
  const body = { game: s.game, opponentId: s.opponentId, powers: { human: s.you.slice(), ai: s.them.slice() } };
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
    s.revealAnimated = false;
    s.refetchN = 0;
  } catch (err) {
    if (op !== s.opToken) return;
    toast(err.status === 429 ? BREATHER : err.error, "error");
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
    toast(err.status === 429 ? BREATHER : err.error, "error");
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
    toast(err.status === 429 ? BREATHER : (err.error || "The table hiccuped. Try that again."), "error");
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
  return '<section class="match">' +
    '<header class="match-head card">' +
      '<div class="match-title"><span class="kicker">' + esc(gameName(st.game)) + " · " + esc(POT_INFO[st.game] || "for real stakes") + "</span>" +
      '<h2 class="vs">You <em>vs</em> ' + esc(opp.label) + "</h2></div>" +
      '<div class="match-powers">' + sidePowersHtml("You", you.powers) + sidePowersHtml(opp.label, opp.powers) + "</div>" +
    "</header>" +
    '<div class="transcript" id="transcript" aria-label="Match transcript" aria-live="polite">' + transcriptHtml(st, s) + "</div>" +
    (st.done && st.result ? revealHtml(st, s) : dockHtml(st, s)) +
    "</section>";
}

function sidePowersHtml(who, powers) {
  const chips = (powers && powers.length)
    ? powers.map((id) => '<span class="chip chip-xs ' + powerChipClass(id) + '" title="' + esc((powerDef(id) || {}).blurb || "") + '">' + esc(powerLabel(id)) + "</span>").join("")
    : '<span class="chip chip-xs chip-none">bare hands</span>';
  return '<span class="side-powers"><span class="side-who">' + esc(who) + "</span>" + chips + "</span>";
}

function transcriptHtml(st, s) {
  const oppLabel = st.players && st.players[1] ? st.players[1].label : "Opponent";
  let html = (st.transcript || []).map((t) => {
    if (t.seat === -1 || t.event) {
      return '<div class="divider"><span>' + esc(t.text) + "</span></div>";
    }
    if (t.seat === 0) {
      return '<div class="bubble bubble-you"><span class="bubble-who">You</span>' + esc(t.text) + "</div>";
    }
    return '<div class="bubble bubble-opp"><span class="bubble-who">' + esc(oppLabel) + "</span>" + esc(t.text) + "</div>";
  }).join("");
  const aiBusy = s.inFlight || (!st.done && (!st.waitingFor || st.waitingFor.seat !== 0));
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
      '<button class="btn btn-gold" type="submit"' + dis + ">Say it</button>" +
    "</form>" +
    (muzzled ? '<p class="micro muzzle-hint">Muzzled: only your first 8 words survive.</p>' : "") +
    "</div>";
}

function splitstealDock(st, d, dis) {
  return '<div class="dock card" aria-live="polite">' +
    leakHtml(st, d) +
    '<p class="dock-note">Negotiation is over. Your choice is private.</p>' +
    '<div class="choice-row">' +
      '<button type="button" class="btn-choice btn-choice-green" data-action="decide" data-decision="SPLIT"' + dis + '><span class="choice-big">Split</span><span class="choice-sub">$50 each</span></button>' +
      '<button type="button" class="btn-choice btn-choice-red" data-action="decide" data-decision="STEAL"' + dis + '><span class="choice-big">Steal</span><span class="choice-sub">it all</span></button>' +
    "</div></div>";
}

function prisonersDock(st, d, dis) {
  const total = d.totalRounds || 5;
  const round = d.round || st.round || 1;
  return '<div class="dock card" aria-live="polite">' +
    pipsHtml(d.history || [], round, total) +
    leakHtml(st, d) +
    '<p class="dock-note">Round ' + round + " of " + total + ". Choose in secret.</p>" +
    '<div class="choice-row">' +
      '<button type="button" class="btn-choice btn-choice-green" data-action="decide" data-decision="COOPERATE"' + dis + '><span class="choice-big">Cooperate</span><span class="choice-sub">$30 each if they do too</span></button>' +
      '<button type="button" class="btn-choice btn-choice-red" data-action="decide" data-decision="DEFECT"' + dis + '><span class="choice-big">Defect</span><span class="choice-sub">$50 if they don’t</span></button>' +
    "</div></div>";
}

function pipsHtml(history, round, total) {
  let out = '<div class="pips" aria-label="Round history">';
  for (let i = 1; i <= total; i++) {
    const h = history[i - 1];
    if (h && h.decisions) {
      const a = (h.decisions[0] || {}).decision || "?";
      const b = (h.decisions[1] || {}).decision || "?";
      out += '<span class="pip pip-done" title="Round ' + i + " — you " + esc(a) + ", them " + esc(b) + '">' +
        '<span class="pip-r">R' + i + '</span><span class="pip-pair">' +
        '<i class="' + (a === "COOPERATE" ? "pc" : "pd") + '"></i>' +
        '<i class="' + (b === "COOPERATE" ? "pc" : "pd") + '"></i></span></span>';
    } else if (i === round) {
      out += '<span class="pip pip-now" title="Round ' + i + ' — deciding now"><span class="pip-r">R' + i + '</span><span class="pip-pair"><i class="pq"></i><i class="pq"></i></span></span>';
    } else {
      out += '<span class="pip" title="Round ' + i + '"><span class="pip-r">R' + i + '</span><span class="pip-pair"><i></i><i></i></span></span>';
    }
  }
  return out + "</div>";
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
    '<input id="dock-pitch" class="input" type="text" maxlength="140" placeholder="One line to sell it (optional)" autocomplete="off" aria-label="Your pitch"' + dis + " />" +
    '<button type="button" class="btn btn-gold btn-lg" data-action="make-offer"' + dis + ">Make the offer</button>" +
    "</div>";
}
function offerReadout(v, max) {
  return "You keep <b>" + money(max - v) + "</b> · They get <b>" + money(v) + "</b>";
}

function respondDock(d, dis) {
  const offer = Number(d.offer) || 0;
  const pot = Number(d.pot) || 100;
  return '<div class="dock card" aria-live="polite">' +
    '<div class="offer-big">They offer you <b class="green">' + money(offer) + "</b> of " + money(pot) +
      '<span class="offer-keep">— they keep ' + money(pot - offer) + "</span></div>" +
    '<input id="dock-line" class="input" type="text" maxlength="140" placeholder="A line for the record (optional)" autocomplete="off" aria-label="Your line"' + dis + " />" +
    '<div class="choice-row">' +
      '<button type="button" class="btn-choice btn-choice-green" data-action="decide" data-decision="ACCEPT"' + dis + '><span class="choice-big">Accept</span><span class="choice-sub">take the ' + money(offer) + "</span></button>" +
      '<button type="button" class="btn-choice btn-choice-red" data-action="decide" data-decision="REJECT"' + dis + '><span class="choice-big">Reject</span><span class="choice-sub">burn it all</span></button>' +
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
    '<button type="button" class="btn btn-gold btn-lg" data-action="wire"' + dis + ">Wire it</button>" +
    "</div>";
}
function sendReadout(v, mult) {
  return "Wire <b>" + money(v) + "</b> → lands as <b class=\"green\">" + money(v * mult) + "</b>";
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
    '<input id="dock-line" class="input" type="text" maxlength="140" placeholder="A line to send with it (optional)" autocomplete="off" aria-label="Your line"' + dis + " />" +
    '<button type="button" class="btn btn-gold btn-lg" data-action="send-back"' + dis + ">Send it back</button>" +
    "</div>";
}
function returnReadout(v, sent, pot) {
  const whole = sent > 0 && v >= sent ? ' · <b class="green">they’re made whole</b>' : "";
  return "Send back <b>" + money(v) + "</b> of " + money(pot) + whole;
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
  /* winner stays gold-bright; the loser's figure recedes; a tie keeps both gold */
  const dim0 = p0 < p1 ? " dim" : "";
  const dim1 = p1 < p0 ? " dim" : "";
  const dis = s.inFlight ? " disabled" : "";
  return '<section class="reveal">' +
    '<div class="payoff-row">' +
      '<div class="payoff"><span class="payoff-who">You</span><span class="payoff-num' + dim0 + '" data-count="' + p0 + '">$0</span></div>' +
      '<span class="payoff-vs">·</span>' +
      '<div class="payoff"><span class="payoff-who">' + esc(oppLabel) + '</span><span class="payoff-num' + dim1 + '" data-count="' + p1 + '">$0</span></div>' +
    "</div>" +
    '<article class="receipt' + (animate ? " receipt-anim" : "") + '">' +
      '<span class="receipt-game">' + esc(gameName(rec.game || st.game)) + "</span>" +
      '<div><span class="stamp stamp-' + cat + '">' + esc(rec.stamp || "SETTLED") + "</span></div>" +
      '<h3 class="receipt-headline">' + esc(rec.headline || "") + "</h3>" +
      (rec.detail ? '<p class="receipt-detail">' + esc(rec.detail) + "</p>" : "") +
      '<div class="receipt-rows">' + potRowHtml(rec.game || st.game) + (rec.players || []).map(receiptRowHtml).join("") + "</div>" +
      quotesHtml(rec, st.game) +
      '<div class="receipt-foot">Golden Arena · behavioral receipt</div>' +
      serialHtml(s.matchId) +
    "</article>" +
    '<div class="reveal-actions">' +
      '<button type="button" class="btn btn-gold" data-action="play-again"' + dis + ">" + (s.inFlight ? "Dealing…" : "Play again") + "</button>" +
      '<button type="button" class="btn btn-ghost" data-action="rig-again"' + dis + ">Rig it differently</button>" +
      '<a class="btn btn-ghost" href="#/board">See the Index</a>' +
    "</div></section>";
}

/* ═══════════════════════════════════════════════════════════════════════
   VIEW 3 · #/watch — the viewing gallery
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
    '<header class="view-head"><p class="kicker kicker-rule">The viewing gallery</p><h2><span class="foil">Machines only. You just watch.</span></h2></header>' +
    '<div id="watch-controls">' + watchControlsHtml() + "</div>" +
    '<div id="watch-live"><div class="card empty">Reading the floor…</div></div>';
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
  return '<div class="card watch-card">' +
    '<h3 class="setup-label">The game</h3>' +
    '<div class="seg seg-slim" role="radiogroup" aria-label="Tournament game">' + games + "</div>" +
    '<h3 class="setup-label">The fighters <span class="setup-hint">pick at least two</span></h3>' +
    '<div class="checks">' + checks + "</div>" +
    '<h3 class="setup-label">The rig <span class="setup-hint">optional</span></h3>' +
    '<div class="rig-selects">' +
      '<div class="rig-sel"><span class="rig-sel-label rig-sel-gold">Advantage</span>' +
        selHtml("advM", cfg.models || [], ws.advM, "Advantaged model", "pick a model") + selHtml("advP", powers, ws.advP, "Superpower", "pick a power") + "</div>" +
      '<div class="rig-sel"><span class="rig-sel-label rig-sel-rust">Handicap</span>' +
        selHtml("hcM", cfg.models || [], ws.hcM, "Handicapped model", "pick a model") + selHtml("hcP", handicaps, ws.hcP, "Handicap", "pick a handicap") + "</div>" +
    "</div>" +
    '<p class="micro">Rigged matches feed the corruption stat: how much nastier a model plays when the field tilts its way.</p>' +
    '<div class="watch-actions">' +
      '<button type="button" class="btn btn-gold btn-lg" data-action="watch-run"' + (ws.busy ? " disabled" : "") + ">" + (ws.busy ? "Dealing…" : "Run tournament") + "</button>" +
      '<button type="button" class="btn btn-ghost" data-action="watch-reset">Reset</button>' +
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
    renderWatchLive();
    scheduleWatch(token, d && d.running ? 1500 : 4000);
  } catch (e) {
    if (token !== viewToken) return;
    if (!watchState.data) {
      const live = document.getElementById("watch-live");
      if (live) live.innerHTML = '<div class="card empty">Can’t reach the arena floor. Retrying…</div>';
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
  if (!d) return '<div class="card empty">Reading the floor…</div>';
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
    html += '<div class="card empty-state"><div class="empty-art">◇ ◆ ◇</div>' +
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
    '<div class="mr-top">' + stampBadge(rec.stamp) + '<span class="mr-game">' + esc(gameName(rec.game || st.game)) + "</span></div>" +
    '<p class="mr-head">' + esc(rec.headline || "") + "</p>" +
    (rec.detail ? '<p class="mr-detail">' + esc(rec.detail) + "</p>" : "") +
    '<div class="receipt-rows">' + potRowHtml(rec.game || st.game) + (rec.players || []).map(receiptRowHtml).join("") + "</div>" +
    quotesHtml(rec, st.game) +
    serialHtml(st.id) +
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
    if (err.status === 409) toast("A tournament is already on the floor — let it finish or reset it.", "error");
    else if (err.status === 429) toast(BREATHER, "error");
    else toast(err.error || "Couldn't start the tournament.", "error");
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
   VIEW 4 · #/board — THE GOLDEN ARENA BEHAVIORAL INDEX
   ═══════════════════════════════════════════════════════════════════════ */
const AXES = [
  ["cooperation", "Coop"],
  ["honesty", "Honesty"],
  ["generosity", "Giving"],
  ["trust", "Trust"],
  ["forgiveness", "Forgive"],
  ["punishment", "Punish"],
];

async function renderBoard() {
  const token = viewToken;
  try { await ensureConfig(); } catch (e) { /* board can still render without config */ }
  if (token !== viewToken) return;

  $view.innerHTML =
    '<header class="view-head"><p class="kicker kicker-rule">The Golden Arena</p><h2><span class="foil">Behavioral Index</span></h2>' +
    '<p class="dek">What the machines do when they think it’s just a game. Lab studies find frontier models more cooperative than humans — the Index tests what’s left of that when the field isn’t level.</p></header>' +
    '<div id="board-body"><div class="card empty">Opening the ledger…</div></div>';
  enterView();

  try {
    const b = await api("/api/board");
    if (token !== viewToken) return;
    const body = document.getElementById("board-body");
    if (body) body.innerHTML = boardHtml(b);
  } catch (e) {
    if (token !== viewToken) return;
    const body = document.getElementById("board-body");
    if (body) {
      body.innerHTML = '<div class="card empty-state"><div class="empty-art">◆</div>' +
        "<h3>The ledger wouldn’t open</h3><p>The record keeper is away from the desk.</p>" +
        '<button type="button" class="btn btn-gold" data-action="reload-view">Try again</button></div>';
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
    html += '<div class="card empty-state"><div class="empty-art">◇ ◆ ◇</div>' +
      "<h3>No one on the record</h3>" +
      "<p>The Index writes itself from play. Sit down yourself, or run the machines against each other.</p>" +
      '<div class="empty-cta"><a class="btn btn-gold" href="#/play">Take a seat</a><a class="btn btn-ghost" href="#/watch">Run a tournament</a></div></div>';
  } else {
    html += '<div class="idx" role="table" aria-label="The Behavioral Index">' +
      '<div class="idx-head" role="row">' +
        '<span role="columnheader">#</span><span role="columnheader">Player</span>' +
        '<span role="columnheader" class="idx-h-num">M</span><span role="columnheader" class="idx-h-num">Earned</span>' +
        '<span role="columnheader">The six axes</span><span role="columnheader">Corruption</span>' +
      "</div>" +
      rows.map(idxRowHtml).join("") +
      "</div>";
  }
  const receipts = (b && b.recentReceipts) || [];
  if (receipts.length) {
    html += '<section class="home-sec"><h2 class="sec-label">Recent receipts</h2><div class="receipts-grid">' +
      receipts.slice(0, 8).map(miniReceiptCardHtml).join("") + "</div></section>";
  }
  html += '<footer class="method card">' +
    "<p><b>Method, honestly:</b> promise-breaking is detected by a labelled heuristic — a pattern-match on open-court promises — not a judge. " +
    "Small samples are small: every axis carries its n, and axes hide until they have data — no fake precision.</p>" +
    (CONFIG && CONFIG.budget && CONFIG.budget.exhausted
      ? '<p class="method-budget">Daily live-model budget spent; matches run scripted until tomorrow.</p>' : "") +
    "</footer>";
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
    case "toggle-power": togglePower(el.dataset.side, el.dataset.id); break;
    case "enter-arena": enterArena(); break;
    case "decide": {
      const payload = { decision: el.dataset.decision };
      const line = document.getElementById("dock-line");
      if (line && line.value.trim()) payload.text = line.value.trim().slice(0, 280);
      sendInput(payload);
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
  if (f.dataset.action === "say") {
    const inp = document.getElementById("msg-input");
    const text = inp ? inp.value.trim() : "";
    if (!text) return;
    sendInput({ text: text.slice(0, 280) });
  }
});

/* Enter always submits the message — independent of implicit form submission */
document.addEventListener("keydown", (e) => {
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
ensureConfig().catch(() => { /* views retry on their own */ });
route();
