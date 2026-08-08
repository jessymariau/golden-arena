// Golden Arena server. Four behavioural games, human-vs-model matches,
// rigged tournaments, and a persistent behavioural index.
// The API shapes here are a shared contract with public/ — change both or neither.

import express from "express";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { liveMode, hasServerKey, budgetState, verifyKey, scrub, DEFAULT_MODELS } from "./lib/llm.js";
import { POWERS, validPowers } from "./lib/powers.js";
import { GAMES, gameMeta, createMatch, advance, humanInput, setMatchKey, aliasFor, maskPairs, maskText } from "./lib/games.js";
import { initStore, records, addRecord, storageMode } from "./lib/storage.js";
import { computeBoard, receiptOf } from "./lib/bench.js";
import { seedPlan } from "./lib/seedplan.js";
import { headlineOf, shareMeta, sharePage, missingPage, MISSING_RECORD } from "./lib/share.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (!res.headersSent) res.status(500).json({ error: scrub(err.message) });
  });

// ---------------------------------------------------------------------------
// BRING YOUR OWN KEY
// ---------------------------------------------------------------------------
// A visitor may hand us their own OpenRouter key so they can play real models
// at their own expense. It arrives in a header on the request that needs it,
// is read fresh EVERY time (a client that stops sending it stops playing live),
// and is never written to disk, to a log, to a record or to any response.
// The one exception is the detached tournament runner, which must hold it for
// the length of the run — and drops it in a finally.
const KEY_SHAPE = /^[\x21-\x7E]{16,256}$/; // printable ASCII, no spaces
function visitorKey(req) {
  const raw = req.get("X-OpenRouter-Key");
  if (typeof raw !== "string") return null;
  const k = raw.trim();
  return KEY_SHAPE.test(k) ? k : null;
}

// ---------------------------------------------------------------------------
// sessions + per-IP rate limits
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_CAP = 300;
const COOLDOWN_MS = 60_000;
const sessions = new Map(); // matchId -> match (insertion order = age)
const lastMatchAt = new Map(); // ip -> ts
const lastTournamentAt = new Map();

function ipOf(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// A cooldown only makes sense when OUR key is buying the tokens. A demo match
// is scripted and costs nothing, and a visitor on their own key is spending
// their own money — throttling either protects nobody and reads as a bug.
function housePays(req) {
  return hasServerKey() && !visitorKey(req);
}

// A refusal must look like a refusal: the real reason, and a clock you can
// watch. Never a vague apology the visitor has to read as a crash.
function cooledDown(req, store) {
  if (!housePays(req)) return 0;
  const waited = Date.now() - (store.get(ipOf(req)) || 0);
  return waited < COOLDOWN_MS ? COOLDOWN_MS - waited : 0;
}

function refuse(res, retryAfterMs, message) {
  res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  return res.status(429).json({ error: message, retryAfterMs });
}

function putSession(match) {
  while (sessions.size >= SESSION_CAP) sessions.delete(sessions.keys().next().value);
  match.touchedAt = Date.now();
  sessions.set(match.id, match);
}

function getSession(id) {
  const match = sessions.get(id);
  if (match) match.touchedAt = Date.now();
  return match;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, m] of sessions) if (now - (m.touchedAt || m.createdAt) > SESSION_TTL_MS) sessions.delete(id);
  for (const [ip, ts] of lastMatchAt) if (now - ts > SESSION_TTL_MS) lastMatchAt.delete(ip);
  for (const [ip, ts] of lastTournamentAt) if (now - ts > SESSION_TTL_MS) lastTournamentAt.delete(ip);
  for (const [ip, h] of verifyHits) if (now > h.resetAt) verifyHits.delete(ip);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// shared shapes
// ---------------------------------------------------------------------------
// pendingDecisions stays server-side; the only sanctioned leak of a committed
// choice is waitingFor.decision.seen, which games.js controls. Built field by
// field — match.apiKey is non-enumerable and is never named here.
function publicState(match) {
  // On a blind table the opponent's name is stripped HERE, on the way out, so
  // it is absent from the response rather than merely hidden by the client.
  // Headlines and spoken lines get the same treatment as the labels do.
  const pairs = maskPairs(match);
  const mask = (t) => maskText(t, pairs);
  const result = match.done ? match.result : null;

  return {
    id: match.id,
    keyError: match.keyError || null, // scrubbed upstream in lib/llm.js
    game: match.game,
    done: match.done,
    liveMode: match.live,
    blind: Boolean(match.blind),
    revealed: Boolean(match.revealed),
    players: match.players.map((p, i) => ({
      label: p.isHuman || !pairs.length ? p.label : aliasFor(i),
      isHuman: !!p.isHuman,
      powers: p.powers,
    })),
    transcript: pairs.length
      ? match.transcript.map((t) => ({ ...t, text: mask(t.text) }))
      : match.transcript,
    round: match.round,
    /* the rounds that have RESOLVED, whatever the game calls them. Every entry
       is settled history — numbers and seat indices, nothing anybody is still
       deciding — so it carries no name to mask and leaks nothing. */
    rounds: match.pdHistory || match.ultRounds || match.trustRounds || null,
    waitingFor: pairs.length && match.waitingFor
      ? { ...match.waitingFor, note: mask(match.waitingFor.note) }
      : match.waitingFor,
    result: pairs.length && result ? maskResult(result, pairs) : result,
  };
}

function maskResult(result, pairs) {
  const mask = (t) => maskText(t, pairs);
  const r = result.receipt;
  return {
    ...result,
    reveal: mask(result.reveal),
    receipt: {
      ...r,
      headline: mask(r.headline),
      detail: mask(r.detail),
      players: (r.players || []).map((p, i) => ({ ...p, label: p.isHuman ? p.label : aliasFor(i) })),
    },
  };
}

function profileLine(opponent, rows) {
  const key = opponent.isHuman ? "human" : opponent.modelId;
  const name = opponent.isHuman ? "Humans" : opponent.label;
  const row = rows.find((r) => r.modelId === key);
  const parts = [];
  if (row) {
    const { cooperation, honesty, generosity } = row.axes;
    if (cooperation.value !== null) parts.push(`cooperates ${Math.round(cooperation.value * 100)}% of the time (n=${cooperation.n})`);
    if (honesty.value !== null) {
      const broken = honesty.n - Math.round(honesty.value * honesty.n);
      parts.push(`${broken} broken promise${broken === 1 ? "" : "s"} on record`);
    }
    if (generosity.value !== null) parts.push(`generosity ${Math.round(generosity.value * 100)}%`);
  }
  if (!parts.length) return `${name}'s file: no recorded history yet.`;
  return `${name}'s file: ${parts.join(", ")}.`;
}

function wireDossier(match) {
  if (!match.players.some((p) => (p.powers || []).includes("dossier"))) return;
  const rows = computeBoard(records()).rows;
  for (const seat of [0, 1]) {
    if ((match.players[seat].powers || []).includes("dossier")) {
      match.dossier = { ...match.dossier, [seat]: profileLine(match.players[seat === 0 ? 1 : 0], rows) };
    }
  }
}

async function runToCompletion(match) {
  // One advance normally finishes an all-AI match; the guard is cheap insurance.
  for (let i = 0; i < 60 && !match.done && !match.waitingFor; i++) await advance(match);
  return match;
}

async function maybeRecord(match) {
  if (match.done && match.record && !match.recorded) {
    match.recorded = true;
    await addRecord(match.record);
  }
}

// ---------------------------------------------------------------------------
// config + board
// ---------------------------------------------------------------------------
app.get("/api/config", (req, res) => {
  res.json({
    liveMode: liveMode() && !budgetState().exhausted,
    serverLive: hasServerKey(), // the house pays; otherwise a visitor may bring a key
    budget: budgetState(),
    models: DEFAULT_MODELS,
    games: gameMeta(),
    powers: Object.entries(POWERS).map(([id, p]) => ({ id, kind: p.kind, label: p.label, blurb: p.blurb })),
  });
});

app.get("/api/board", (req, res) => {
  res.json({
    ...computeBoard(records()),
    storage: storageMode(),
    seeded: records().some((r) => String(r.id).startsWith("seed")),
  });
});

// ---------------------------------------------------------------------------
// one receipt, and its permalink
// ---------------------------------------------------------------------------
// A receipt is the thing people screenshot. Until now it had no URL, so a
// great result was unlinkable and unfurled as nothing. These two routes fix
// that: JSON for the app, server-rendered HTML for the crawler.

// Ids are minted from Date+Math.random (seeded ones carry a "seed-" prefix), so
// this shape is generous but closed. It is also what keeps a hostile :id out of
// the HTML and the redirect below — nothing else may reach them.
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

function findRecord(id) {
  return ID_SHAPE.test(id) ? records().find((r) => String(r.id) === id) : null;
}

// Absolute URLs for og: tags. Behind Replit's proxy the scheme only survives in
// the forwarded header; PUBLIC_ORIGIN wins where a deployment knows its name.
function originOf(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

app.get("/api/record/:id", (req, res) => {
  const rec = findRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: MISSING_RECORD });
  res.json({
    record: rec,
    receipt: receiptOf(rec), // same shape the Index renders
    headline: headlineOf(rec),
    share: shareMeta(rec, originOf(req)),
  });
});

app.get("/r/:id", (req, res) => {
  const rec = findRecord(req.params.id);
  const origin = originOf(req);
  if (!rec) return res.status(404).type("html").send(missingPage(origin));
  res.type("html").send(sharePage(rec, origin));
});

// ---------------------------------------------------------------------------
// key check — "is this key any good?" without spending anything on it
// ---------------------------------------------------------------------------
const VERIFY_PER_MIN = 6;
const verifyHits = new Map(); // ip -> { n, resetAt }

app.post("/api/verify-key", wrap(async (req, res) => {
  const ip = ipOf(req);
  const now = Date.now();
  const hit = verifyHits.get(ip);
  if (!hit || now > hit.resetAt) verifyHits.set(ip, { n: 1, resetAt: now + 60_000 });
  else if (hit.n >= VERIFY_PER_MIN) {
    return refuse(res, hit.resetAt - now, `That is ${VERIFY_PER_MIN} key checks in a minute. Try the next one in`);
  } else hit.n += 1;

  const key = visitorKey(req);
  if (!key) return res.status(400).json({ ok: false, error: "No key on that request. Paste one first." });
  res.json(await verifyKey(key)); // never logged, never echoed
}));

// ---------------------------------------------------------------------------
// human vs model matches
// ---------------------------------------------------------------------------
app.post("/api/match", wrap(async (req, res) => {
  const { game, opponentId, powers, blind } = req.body || {};
  if (!GAMES[game]) return res.status(400).json({ error: `unknown game: ${game}` });

  // Picking your opponent off a list and then calling the table blind would be
  // theatre. Blind means we deal you one.
  const opponent = opponentId
    ? DEFAULT_MODELS.find((m) => m.id === opponentId)
    : DEFAULT_MODELS[Math.floor(Math.random() * DEFAULT_MODELS.length)];
  if (!opponent) return res.status(400).json({ error: `unknown model: ${opponentId}` });

  const wait = cooledDown(req, lastMatchAt);
  if (wait) {
    return refuse(res, wait, "The house is buying these matches, so there is a minute between them. Bring your own key and you play as fast as you like. Next seat in");
  }
  if (housePays(req)) lastMatchAt.set(ipOf(req), Date.now());

  const players = [
    { label: "You", isHuman: true, powers: validPowers(powers?.human) },
    { modelId: opponent.id, label: opponent.label, powers: validPowers(powers?.ai) },
  ];
  const apiKey = visitorKey(req);
  // Either key path means real models spoke — the Index must record it as live.
  // Blind unless the visitor asked to see who they are up against.
  const match = createMatch({
    game, players, apiKey,
    live: liveMode() || Boolean(apiKey),
    blind: blind !== false,
  });
  wireDossier(match);
  await advance(match);
  await maybeRecord(match);
  putSession(match);
  res.json({ matchId: match.id, state: publicState(match) });
}));

app.get("/api/match/:id", (req, res) => {
  const match = getSession(req.params.id);
  if (!match) return res.status(404).json({ error: "match not found" });
  res.json(publicState(match));
});

// Lifting the mask, once, when the visitor asks. Only after the match is over:
// mid-hand it would just be a cheat code, and the whole point is that you
// decide without knowing.
app.post("/api/match/:id/reveal", (req, res) => {
  const match = getSession(req.params.id);
  if (!match) return res.status(404).json({ error: "match not found" });
  if (!match.done) return res.status(409).json({ error: "Not until it's settled. Play the hand first." });
  match.revealed = true;
  res.json(publicState(match));
});

app.post("/api/match/:id/input", wrap(async (req, res) => {
  const match = getSession(req.params.id);
  if (!match) return res.status(404).json({ error: "match not found" });
  // Re-read from THIS request rather than trusting the stored copy.
  setMatchKey(match, visitorKey(req));
  if (match.apiKey) match.live = true;
  match.keyError = null;
  try {
    humanInput(match, req.body || {});
  } catch (err) {
    return res.status(400).json({ error: scrub(err.message) });
  }
  await advance(match);
  await maybeRecord(match);
  res.json(publicState(match));
}));

// ---------------------------------------------------------------------------
// tournaments — one at a time, run in a detached loop
// ---------------------------------------------------------------------------
function emptyTournament() {
  return { running: false, game: null, progress: { done: 0, total: 0 }, matches: [], error: null, inPlay: null };
}
let tournament = emptyTournament();

// `inPlay` is the RAW match currently at the table — it carries pendingDecisions
// and an unmasked roster, so it is destructured off here and can never reach a
// client. What goes out is its publicState, appended to the finished ones, which
// is the whole point of a gallery: you watch the hand being played, not a
// counter ticking while six of them happen somewhere off screen.
// Newest first, live table at the top: the one card worth looking at then sits
// in the same place for the whole run instead of marching down the page ahead
// of the reader, and a match that finishes becomes the row directly beneath the
// next one rather than jumping to the bottom.
function tournamentView(t) {
  const { inPlay, ...rest } = t;
  const done = rest.matches.slice().reverse();
  return { ...rest, matches: inPlay ? [publicState(inPlay)].concat(done) : done };
}

function applyRig(players, rig) {
  const adv = rig?.advantaged;
  if (adv && POWERS[adv.power]?.kind === "power") {
    for (const p of players) if (p.modelId === adv.modelId) p.powers.push(adv.power);
  }
  const cap = rig?.handicapped;
  if (cap && POWERS[cap.handicap]?.kind === "handicap") {
    for (const p of players) if (p.modelId === cap.modelId) p.powers.push(cap.handicap);
  }
}

app.post("/api/tournament", wrap(async (req, res) => {
  if (tournament.running) {
    const { done, total } = tournament.progress;
    const name = (gameMeta().find((g) => g.id === tournament.game) || {}).name || "A";
    return res.status(409).json({
      error: `A ${name} tournament is already on the floor, ${done} of ${total} matches in. Watch it finish, or clear the table.`,
      tournament: { game: tournament.game, progress: tournament.progress },
    });
  }

  const { game, models, rig } = req.body || {};
  if (!GAMES[game]) return res.status(400).json({ error: `unknown game: ${game}` });
  if (!Array.isArray(models) || models.length < 2 || models.length > 6) {
    return res.status(400).json({ error: "models must be 2 to 6 entries" });
  }
  const roster = [];
  for (const m of models) {
    const known = DEFAULT_MODELS.find((d) => d.id === m?.id);
    if (!known) return res.status(400).json({ error: `unknown model: ${m?.id}` });
    roster.push(known);
  }

  const wait = cooledDown(req, lastTournamentAt);
  if (wait) {
    return refuse(res, wait, "One tournament a minute while the house is paying for them. Bring your own key and that ceiling lifts. Next one in");
  }
  if (housePays(req)) lastTournamentAt.set(ipOf(req), Date.now());

  const pairs = [];
  for (let i = 0; i < roster.length; i++)
    for (let j = i + 1; j < roster.length; j++) pairs.push([roster[i], roster[j]]);

  tournament = { running: true, game, progress: { done: 0, total: pairs.length }, matches: [], error: null, inPlay: null };
  const state = tournament;

  // The one place a visitor's key outlives a request. It is held in this
  // closure only — never on `tournament`, which is served to every client —
  // and the finally drops it whether the run finishes, is superseded or throws.
  let runKey = visitorKey(req);
  const live = liveMode() || Boolean(runKey);

  (async () => {
    try {
      for (const [a, b] of pairs) {
        if (state !== tournament) return; // reset while running: stop burning calls
        try {
          const players = [
            { modelId: a.id, label: a.label, powers: [] },
            { modelId: b.id, label: b.label, powers: [] },
          ];
          applyRig(players, rig);
          const match = createMatch({ game, players, live, apiKey: runKey });
          wireDossier(match);
          state.inPlay = match;              // the table the room is watching
          await runToCompletion(match);
          state.inPlay = null;
          state.matches.push(publicState(match));
          if (match.done && match.record) await addRecord(match.record);
        } catch (err) {
          state.inPlay = null;
          state.error = scrub(err.message);
        }
        state.progress.done += 1;
      }
    } finally {
      runKey = null;
      state.running = false;
    }
  })();

  res.json(tournamentView(tournament));
}));

app.get("/api/tournament", (req, res) => {
  res.json(tournamentView(tournament));
});

app.post("/api/tournament/reset", (req, res) => {
  tournament = emptyTournament();
  res.json({ ok: true });
});

// JSON errors for bad bodies and anything a route lets escape.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: scrub(err.message || "server error") });
});

// ---------------------------------------------------------------------------
// demo seeding — judges should never meet an empty board
// ---------------------------------------------------------------------------
// The plan itself lives in lib/seedplan.js, shared with scripts/bake-seed.mjs,
// so the pre-baked board and this fallback can never simulate different games.

// Pre-baked board (seed/records.json, generated from the same plan below).
// Autoscale containers are ephemeral and scale to zero, so without this every
// cold start would re-simulate 18 matches and a visitor arriving mid-seed
// would meet a half-empty Index. Loading the file makes the board instant.
async function loadBakedSeeds() {
  try {
    const raw = await readFile(path.join(__dirname, "seed", "records.json"), "utf8");
    const baked = JSON.parse(raw);
    if (!Array.isArray(baked) || !baked.length) return 0;
    for (const rec of baked) await addRecord(rec);
    return baked.length;
  } catch {
    return 0; // no bundled seeds — fall through to simulating them
  }
}

// Top-up rather than all-or-nothing: an interrupted boot (killed process,
// redeploy mid-seed) resumes where it left off instead of never finishing.
// Seeding follows the SERVER key, not "is anyone playing live". Our public
// deployment carries no key — visitors bring their own — so it must still ship
// a populated, clearly-labelled Index rather than an empty board.
async function seedIfEmpty() {
  if (hasServerKey()) {
    console.log("Server key present: skipping demo seeding; the board fills with real matches.");
    return;
  }
  if (!records().some((r) => String(r.id).startsWith("seed"))) {
    const n = await loadBakedSeeds();
    if (n) {
      console.log(`Board pre-loaded with ${n} baked demo matches (storage=${storageMode()}).`);
      return;
    }
  }
  const plan = seedPlan();
  const have = records().filter((r) => String(r.id).startsWith("seed")).length;
  if (have >= plan.length) return;

  console.log(`Seeding demo matches (${have}/${plan.length} present)...`);
  for (let i = have; i < plan.length; i++) {
    const step = plan[i];
    const players = [
      { modelId: step.a.id, label: step.a.label, powers: step.aPowers || [] },
      { modelId: step.b.id, label: step.b.label, powers: step.bPowers || [] },
    ];
    try {
      const match = createMatch({ game: step.game, players, live: false });
      await runToCompletion(match);
      if (match.done && match.record) {
        match.record.id = "seed-" + match.record.id;
        await addRecord(match.record);
      }
    } catch (err) {
      console.warn(`Seed match ${i + 1} failed: ${err.message}`);
    }
    if ((i + 1) % 4 === 0 || i + 1 === plan.length) console.log(`Seeded ${i + 1}/${plan.length}`);
  }
  console.log(`Seeding done. Board holds ${records().length} matches (storage=${storageMode()}).`);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
await initStore();
app.listen(PORT, () => {
  console.log(`Golden Arena on :${PORT} (${hasServerKey() ? "LIVE on the server key" : "DEMO — visitors may bring their own key"}, storage=${storageMode()})`);
  seedIfEmpty().catch((err) => console.warn(`Seeding failed: ${err.message}`));
});
