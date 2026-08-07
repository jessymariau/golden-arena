// Bake seed/records.json: the demo board a cold container serves instantly.
//
// Autoscale scales to zero and the deployment holds no key, so without a baked
// board every cold start would re-simulate 18 matches and a visitor arriving
// mid-seed would meet a half-empty Index. This script produces that file.
//
//   npm run bake:seed
//
// It rejects its own output rather than shipping a board that says nothing:
// every model row must carry a non-null corruption delta, which is the one
// column the product is actually about. Re-run it whenever the roster, the
// archetypes or the plan change, because the board is downstream of all three.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMatch, advance } from "../lib/games.js";
import { computeBoard } from "../lib/bench.js";
import { seedPlan } from "../lib/seedplan.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "seed", "records.json");

if (process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is set. The baked board must be scripted demo play, not paid calls.");
  console.error("Re-run without it in the environment.");
  process.exit(1);
}

const plan = seedPlan();
const records = [];

for (const [i, step] of plan.entries()) {
  const match = createMatch({
    game: step.game,
    live: false,
    players: [
      { modelId: step.a.id, label: step.a.label, powers: step.aPowers || [] },
      { modelId: step.b.id, label: step.b.label, powers: step.bPowers || [] },
    ],
  });
  for (let guard = 0; guard < 60 && !match.done && !match.waitingFor; guard++) await advance(match);
  if (!match.done || !match.record) {
    console.error(`Match ${i + 1} (${step.game}) never finished. Nothing written.`);
    process.exit(1);
  }
  match.record.id = "seed-" + match.record.id;
  records.push(match.record);
  process.stdout.write(`\r  simulated ${records.length}/${plan.length}`);
}
console.log("");

const board = computeBoard(records);
const blind = board.rows.filter((r) => !r.isHuman && r.corruption.delta === null);
if (blind.length) {
  console.error(`Rejected: ${blind.map((r) => r.label).join(", ")} came out with no corruption delta.`);
  console.error("That is the column the whole board exists for. Re-run for a different draw.");
  process.exit(1);
}

await writeFile(OUT, JSON.stringify(records, null, 0));
console.log(`Wrote ${records.length} records to seed/records.json`);
for (const r of board.rows) {
  if (r.isHuman) continue;
  const d = Math.round(r.corruption.delta * 100);
  const coop = r.axes.cooperation.value;
  console.log(
    `  ${r.label.padEnd(20)} cooperates ${String(Math.round(coop * 100)).padStart(3)}%  ` +
    `corruption ${d > 0 ? "+" : ""}${d}%  (n=${r.corruption.advantagedN}/${r.corruption.neutralN})`
  );
}
