// Verify every model in DEFAULT_MODELS is actually reachable and returns a
// decision we can parse.
//
// Why this exists: OpenRouter retires model ids. A retired id 404s with
// "No endpoints found", and because the arena degrades errors into a
// scripted reply, a dead roster looks EXACTLY like a working one — the
// banner still says LIVE and the transcripts still fill up. Two of the four
// launch models had rotted this way and it was invisible until something
// asserted on it. That is what this script is for.
//
//   OPENROUTER_API_KEY=... npm run check:models
//
// Exits non-zero if any model is unreachable or unparseable.

import { DEFAULT_MODELS, chat, liveMode } from "../lib/llm.js";

if (!liveMode()) {
  console.error("No OPENROUTER_API_KEY set — nothing to check (demo mode needs no models).");
  process.exit(2);
}

const PROMPT = `Negotiation is over. Give your final, private decision. Respond with ONLY strict JSON: {"decision":"SPLIT"} or {"decision":"STEAL"}, optionally with a short "reason".`;

let failed = 0;
for (const m of DEFAULT_MODELS) {
  let status;
  try {
    const raw = await chat(m.id, [
      { role: "system", content: "You are a contestant in a trust game. Be terse." },
      { role: "user", content: PROMPT },
    ], { decision: "splitsteal" });

    const slice = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const decision = String(JSON.parse(slice).decision || "").toUpperCase();
    if (!["SPLIT", "STEAL"].includes(decision)) throw new Error(`unusable decision: ${JSON.stringify(raw.slice(0, 80))}`);
    status = `ok    ${m.label} (${m.id}) → ${decision}`;
  } catch (err) {
    failed += 1;
    status = `DEAD  ${m.label} (${m.id}) → ${err.message.slice(0, 120)}`;
  }
  console.log(status);
}

if (failed) {
  console.error(`\n${failed}/${DEFAULT_MODELS.length} models unusable. Fix DEFAULT_MODELS in lib/llm.js before shipping — a dead roster is invisible at runtime.`);
  process.exit(1);
}
console.log(`\nAll ${DEFAULT_MODELS.length} models live and parseable.`);
