// Golden Arena server. Four behavioural games, human-vs-model matches,
// rigged tournaments, and a persistent behavioural index.
// The API shapes here are a shared contract with public/ — change both or neither.

import express from "express";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { liveMode, budgetState, DEFAULT_MODELS } from "./lib/llm.js";
import { POWERS, validPowers } from "./lib/powers.js";
import { GAMES, gameMeta, createMatch, advance, humanInput } from "./lib/games.js";
import { initStore, records, addRecord, storageMode } from "./lib/storage.js";
import { computeBoard } from "./lib/bench.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

// ---------------------------------------------------------------------------
// sessions + per-IP rate limits
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_CAP = 300;
const sessions = new Map(); // matchId -> match (insertion order = age)
const lastMatchAt = new Map(); // ip -> ts
const lastTournamentAt = new Map();

function ipOf(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
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
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// shared shapes
// ---------------------------------------------------------------------------
// pendingDecisions stays server-side; the only sanctioned leak of a committed
// choice is waitingFor.decision.seen, which games.js controls.
function publicState(match) {
  return {
    id: match.id,
    game: match.game,
    done: match.done,
    liveMode: match.live,
    players: match.players.map((p) => ({ label: p.label, isHuman: !!p.isHuman, powers: p.powers })),
    transcript: match.transcript,
    round: match.round,
    waitingFor: match.waitingFor,
    result: match.done ? match.result : null,
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
// human vs model matches
// ---------------------------------------------------------------------------
app.post("/api/match", wrap(async (req, res) => {
  const { game, opponentId, powers } = req.body || {};
  if (!GAMES[game]) return res.status(400).json({ error: `unknown game: ${game}` });
  const opponent = DEFAULT_MODELS.find((m) => m.id === opponentId);
  if (!opponent) return res.status(400).json({ error: `unknown model: ${opponentId}` });

  const ip = ipOf(req);
  if (Date.now() - (lastMatchAt.get(ip) || 0) < 15_000) {
    return res.status(429).json({ error: "Easy now. One new match every 15 seconds." });
  }
  lastMatchAt.set(ip, Date.now());

  const players = [
    { label: "You", isHuman: true, powers: validPowers(powers?.human) },
    { modelId: opponent.id, label: opponent.label, powers: validPowers(powers?.ai) },
  ];
  const match = createMatch({ game, players, live: liveMode() });
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

app.post("/api/match/:id/input", wrap(async (req, res) => {
  const match = getSession(req.params.id);
  if (!match) return res.status(404).json({ error: "match not found" });
  try {
    humanInput(match, req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  await advance(match);
  await maybeRecord(match);
  res.json(publicState(match));
}));

// ---------------------------------------------------------------------------
// tournaments — one at a time, run in a detached loop
// ---------------------------------------------------------------------------
function emptyTournament() {
  return { running: false, game: null, progress: { done: 0, total: 0 }, matches: [], error: null };
}
let tournament = emptyTournament();

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
  if (tournament.running) return res.status(409).json({ error: "A tournament is already running." });

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

  const ip = ipOf(req);
  if (Date.now() - (lastTournamentAt.get(ip) || 0) < 60_000) {
    return res.status(429).json({ error: "One tournament per minute. Let this one settle first." });
  }
  lastTournamentAt.set(ip, Date.now());

  const pairs = [];
  for (let i = 0; i < roster.length; i++)
    for (let j = i + 1; j < roster.length; j++) pairs.push([roster[i], roster[j]]);

  tournament = { running: true, game, progress: { done: 0, total: pairs.length }, matches: [], error: null };
  const state = tournament;

  (async () => {
    for (const [a, b] of pairs) {
      if (state !== tournament) return; // reset while running: stop burning calls
      try {
        const players = [
          { modelId: a.id, label: a.label, powers: [] },
          { modelId: b.id, label: b.label, powers: [] },
        ];
        applyRig(players, rig);
        const match = createMatch({ game, players, live: liveMode() });
        wireDossier(match);
        await runToCompletion(match);
        state.matches.push(publicState(match));
        if (match.done && match.record) await addRecord(match.record);
      } catch (err) {
        state.error = err.message;
      }
      state.progress.done += 1;
    }
    state.running = false;
  })();

  res.json(tournament);
}));

app.get("/api/tournament", (req, res) => {
  res.json(tournament);
});

app.post("/api/tournament/reset", (req, res) => {
  tournament = emptyTournament();
  res.json({ ok: true });
});

// JSON errors for bad bodies and anything a route lets escape.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || "server error" });
});

// ---------------------------------------------------------------------------
// demo seeding — judges should never meet an empty board
// ---------------------------------------------------------------------------
// The plan is deterministic and rigged-heavy on purpose: every model plays two
// advantaged prisoners matches (10 counted decisions) and at least two neutral
// ones, so the corruption column has real data the first time a judge sees it.
// Prisoners rounds are what fill the pools — one match is five decisions.
function seedPlan() {
  const M = DEFAULT_MODELS;
  const plan = [];
  for (let k = 0; k < M.length; k++) {
    plan.push({ game: "prisoners", a: M[k], b: M[(k + 1) % M.length], aPowers: ["mindreader"] });
    plan.push({ game: "prisoners", a: M[k], b: M[(k + 2) % M.length], bPowers: ["muzzled"] });
  }
  plan.push({ game: "prisoners", a: M[0], b: M[1] });
  plan.push({ game: "prisoners", a: M[2], b: M[3] });
  plan.push({ game: "prisoners", a: M[0], b: M[2] });
  plan.push({ game: "prisoners", a: M[1], b: M[3] });
  plan.push({ game: "splitsteal", a: M[0], b: M[3] });
  plan.push({ game: "splitsteal", a: M[1], b: M[2] });
  plan.push({ game: "ultimatum", a: M[0], b: M[1] });
  plan.push({ game: "ultimatum", a: M[2], b: M[3] });
  plan.push({ game: "trust", a: M[0], b: M[2] });
  plan.push({ game: "trust", a: M[1], b: M[3] });
  return plan;
}

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
async function seedIfEmpty() {
  if (liveMode()) {
    console.log("Live mode: skipping demo seeding; the board fills with real matches.");
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
  console.log(`Golden Arena on :${PORT} (${liveMode() ? "LIVE" : "DEMO"} mode, storage=${storageMode()})`);
  seedIfEmpty().catch((err) => console.warn(`Seeding failed: ${err.message}`));
});
