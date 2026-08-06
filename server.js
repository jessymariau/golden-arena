import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS, playMatch, roundRobinPairs, computeLeaderboard } from "./lib/game.js";
import { liveMode } from "./lib/openrouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory tournament state — a buildathon demo doesn't need a database.
let state = {
  running: false,
  models: DEFAULT_MODELS,
  matches: [],
  progress: { done: 0, total: 0 },
  error: null,
};

app.get("/api/state", (req, res) => {
  res.json({
    running: state.running,
    liveMode: liveMode(),
    defaultModels: DEFAULT_MODELS,
    models: state.models,
    matches: state.matches,
    leaderboard: computeLeaderboard(state.matches),
    progress: state.progress,
    error: state.error,
  });
});

app.post("/api/tournament", async (req, res) => {
  if (state.running) return res.status(409).json({ error: "Tournament already running" });

  const requested = Array.isArray(req.body?.models) ? req.body.models : DEFAULT_MODELS;
  const models = requested.filter((m) => m && m.id && m.label).slice(0, 8);
  if (models.length < 2) return res.status(400).json({ error: "Need at least 2 models" });

  state = { running: true, models, matches: [], progress: { done: 0, total: 0 }, error: null };
  res.json({ started: true });

  const pairs = roundRobinPairs(models);
  state.progress.total = pairs.length;

  (async () => {
    for (const [a, b] of pairs) {
      try {
        const match = await playMatch(a, b);
        state.matches.push(match);
      } catch (err) {
        state.error = err.message;
      }
      state.progress.done += 1;
    }
    state.running = false;
  })();
});

app.post("/api/reset", (req, res) => {
  state = { running: false, models: DEFAULT_MODELS, matches: [], progress: { done: 0, total: 0 }, error: null };
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Golden Arena listening on :${PORT} (${liveMode() ? "LIVE" : "DEMO"} mode)`);
});
