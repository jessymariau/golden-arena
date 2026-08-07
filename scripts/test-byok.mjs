// Bring-your-own-key regression test.
//
// Boots a real server with NO server key on a spare port, plays a full
// Split-or-Steal match with a deliberately bogus key in the header, and then
// hunts for that key everywhere it must never appear.
//
// The canary is deliberately NOT shaped like `sk-or-…`: scrub() would mask a
// real leak of a realistically-shaped key and the test would pass on a lie.
// A separate case checks scrub() itself against a realistic shape.
//
//   node scripts/test-byok.mjs

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.TEST_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const CANARY = "GA-CANARY-not-a-real-key-0123456789abcdef";
const EXPECTED_SEEDS = 18;

let failures = 0;
const seen = []; // every response body this test has been shown

function ok(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

async function call(pathname, { method = "GET", body, key } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (key) headers["X-OpenRouter-Key"] = key;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  seen.push(`${method} ${pathname} -> ${text}`);
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function waitForBoot(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(BASE + "/api/config");
      if (res.ok) { await res.text(); return true; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "golden-arena-test-"));
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir };
  delete env.OPENROUTER_API_KEY;   // the whole point: no server key
  delete env.REPLIT_DB_URL;        // force the file backend so we can read it

  const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  server.stdout.on("data", (b) => logs.push(String(b)));
  server.stderr.on("data", (b) => logs.push(String(b)));

  try {
    if (!await waitForBoot()) throw new Error("server never came up:\n" + logs.join(""));

    console.log("\n· config");
    const cfg = await call("/api/config");
    ok("serverLive is false without a server key", cfg.json?.serverLive === false, JSON.stringify(cfg.json?.serverLive));
    ok("liveMode is false without a server key", cfg.json?.liveMode === false);
    const model = cfg.json?.models?.[0]?.id;
    ok("models are advertised", Boolean(model));

    console.log("\n· seeding (server key absent => baked board still ships)");
    let board = null;
    for (let i = 0; i < 60; i++) {
      board = (await call("/api/board")).json;
      if ((board?.totals?.matches || 0) >= EXPECTED_SEEDS) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    ok(`board seeded with ${EXPECTED_SEEDS} baked matches`, board?.totals?.matches >= EXPECTED_SEEDS, `got ${board?.totals?.matches}`);
    ok("seeded flag is set", board?.seeded === true);
    const seededLive = board?.totals?.liveMatches || 0;

    console.log("\n· a full Split-or-Steal match with a bogus key");
    const created = await call("/api/match", { method: "POST", key: CANARY, body: { game: "splitsteal", opponentId: model, powers: {} } });
    ok("match created", created.status === 200 && Boolean(created.json?.matchId), created.text.slice(0, 120));
    const matchId = created.json?.matchId;
    let state = created.json?.state;

    ok("match is flagged live on the visitor-key path", state?.liveMode === true);

    for (let guard = 0; guard < 20 && state && !state.done; guard++) {
      const wf = state.waitingFor;
      if (!wf || wf.seat !== 0) {
        state = (await call(`/api/match/${matchId}`)).json;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const payload = wf.kind === "message" ? { text: "Fifty-fifty. My word on it." } : { decision: "SPLIT" };
      const step = await call(`/api/match/${matchId}/input`, { method: "POST", key: CANARY, body: payload });
      ok(`input accepted (${wf.kind})`, step.status === 200, step.text.slice(0, 160));
      state = step.json;
    }

    ok("match finished rather than crashing", state?.done === true);
    ok("a result was produced", Boolean(state?.result?.receipt?.stamp));
    const transcript = (state?.transcript || []).map((t) => t.text).join(" | ");
    ok("the rejected key degrades with a visible error, not silence",
      /no response: OpenRouter refused this key \(40\d\)/.test(transcript), transcript.slice(0, 200));
    ok("keyError is surfaced to the client", typeof state?.keyError === "string" && state.keyError.length > 0);

    console.log("\n· the key never comes back");
    ok("publicState carries no apiKey field", !("apiKey" in (state || {})));
    ok("no response body contains the key", !seen.some((s) => s.includes(CANARY)),
      (seen.find((s) => s.includes(CANARY)) || "").slice(0, 200));

    const boardAfter = await call("/api/board");
    ok("/api/board contains no key", !boardAfter.text.includes(CANARY));
    ok("the live match was recorded as live", (boardAfter.json?.totals?.liveMatches || 0) > seededLive,
      `${seededLive} -> ${boardAfter.json?.totals?.liveMatches}`);

    // Give the serialised write-through a moment to land on disk.
    await new Promise((r) => setTimeout(r, 400));
    const persisted = await readFile(path.join(dataDir, "records.json"), "utf8");
    ok("the persisted record file contains no key", !persisted.includes(CANARY));
    ok("no persisted record has an apiKey field", !/"apiKey"/.test(persisted));

    ok("nothing the server logged contains the key", !logs.join("").includes(CANARY));

    console.log("\n· /api/verify-key");
    const bad = await call("/api/verify-key", { method: "POST", key: CANARY });
    ok("a bogus key is rejected with a message", bad.json?.ok === false && typeof bad.json?.error === "string", bad.text.slice(0, 160));
    ok("the rejection does not echo the key", !bad.text.includes(CANARY));
    const naked = await call("/api/verify-key", { method: "POST" });
    ok("a keyless check is a 400", naked.status === 400);

    let limited = false;
    for (let i = 0; i < 8; i++) {
      const r = await call("/api/verify-key", { method: "POST", key: CANARY });
      if (r.status === 429) { limited = true; break; }
    }
    ok("verify-key is rate limited per IP", limited);

    console.log("\n· scrub() masks a realistically-shaped key");
    const { scrub } = await import("../lib/llm.js");
    const shaped = "sk-or-v1-abcdef0123456789abcdef0123456789";
    ok("scrub replaces an sk-or- key", !scrub(`boom ${shaped} boom`).includes(shaped), scrub(`boom ${shaped} boom`));
  } finally {
    server.kill();
    await rm(dataDir, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nAll BYOK checks passed.\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("test harness error:", err);
  process.exit(1);
});
