// proto/run.mjs — run Empire and write a transcript a human can actually read.
//
//   node proto/run.mjs                    one game, 12 turns, seed 1
//   node proto/run.mjs --games 3          three games, seeds 1..3
//   node proto/run.mjs --turns 8 --seed 7
//
// The reader is omniscient (SPEC §5 rule 3): every private message is printed,
// including the ones the recipients were never meant to compare.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGame, REGIONS } from "../lib/empire.js";
import { liveMode } from "../lib/llm.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

const SEATS = [
  { id: "openai/gpt-4o-mini", name: "GPT" },
  { id: "anthropic/claude-3.5-haiku", name: "HAIKU" },
  { id: "google/gemini-2.0-flash-001", name: "GEMINI" },
  { id: "deepseek/deepseek-chat", name: "DEEPSEEK" },
];

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}
function strArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const pad = (s, n) => String(s).padEnd(n);
const rule = (ch = "─", n = 74) => ch.repeat(n);

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------
function render(rec, label) {
  const L = [];
  const say = (s = "") => L.push(s);

  say(`# EMPIRE — ${label}`);
  say();
  say(`mode: **${rec.mode}**${rec.mode === "mock" ? " (no OPENROUTER_API_KEY — lib/llm.js mock personalities, Empire-aware fallback policy)" : " (real models via OpenRouter)"}  `);
  say(`seed ${rec.seed} · ${rec.turns} turns · 4 players · 12 territories in 4 regions of 3 · opening deal: **${rec.deal}**`);
  say();
  say("## The table");
  say();
  say("```");
  for (const p of rec.opening) {
    const need = p.needs ? `one from ${p.needs.region}: needs ${p.needs.territory}, held by ${p.needs.holder}` : "—";
    say(`${pad(p.name, 9)} ${pad(p.archetype, 9)} ${pad(p.land.join(" "), 12)} ${need}`);
  }
  say("```");
  say();
  say(`Regions: ${Object.entries(REGIONS).map(([n, l]) => `${n} = ${l.join(" ")}`).join(" · ")}`);
  say();
  say("Nobody starts with a complete region. The seats are deliberately unequal. Land moves by agreement, or by all three others raiding the same person at once.");
  say();
  say("`INVEST +20 · FORTIFY · RAID` — 2+ raiders take 40 each; a lone raider fails for −15 **unless the target is MARKED**; all three take a territory instead of coins. Breaking a handshake, a raid pledge or a fortify pledge marks you in public for two turns.");
  say();

  for (const t of rec.log) {
    say(rule("═"));
    say(`## TURN ${t.n}`);
    if (t.markedGoingIn.length) {
      say();
      say(`> **MARKED this turn:** ${t.markedGoingIn.map((m) => `${m.player} (until T${m.until}) — ${m.reason}`).join(" · ")}  `);
      say(`> A lone raid on them lands, for 40. All three can come at once.`);
    }
    say();

    say("**TALK**");
    say("```");
    for (const m of t.talk.public) say(`[table] ${pad(m.from, 9)} ${m.text}`);
    if (t.talk.private.length) say("");
    for (const m of t.talk.private) say(`  (private) ${m.from} → ${m.to}: ${m.text}`);
    say("```");

    const d = t.deals;
    if (d.offers.length || d.pledges.length || d.resolutions.length) {
      say("**DEAL**");
      say("```");
      for (const o of d.offers) {
        const give = [o.giveCoins ? `${o.giveCoins}c` : null, o.giveLand.join("+") || null].filter(Boolean).join("+") || "—";
        const want = [o.wantCoins ? `${o.wantCoins}c` : null, o.wantLand.join("+") || null].filter(Boolean).join("+") || "—";
        say(`  offer ${pad(o.id, 4)} ${pad(o.from + " → " + o.to, 20)} ${pad(o.kind, 10)} gives ${pad(give, 10)} wants ${pad(want, 10)} "${o.note}"`);
      }
      for (const r of d.resolutions) {
        say(`  ACCEPT ${pad(r.offer.id, 4)} ${r.offer.to} accepts ${r.offer.from}'s T${r.offer.turn} ${r.offer.kind} — ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
      }
      for (const p of d.pledges) {
        const what = p.type === "JOINT_RAID" ? `JOINT RAID on ${p.target}` : p.type === "FORTIFY" ? "I will FORTIFY" : `I will hand over ${p.territory}`;
        say(`  pledge (private) ${p.from} → ${p.to}: ${what}`);
      }
      say("```");
    }

    say("**ACT** — secret, revealed together");
    say("```");
    const breachBy = {};
    for (const b of t.breaches) (breachBy[b.by] ||= []).push(b);
    const keptBy = {};
    for (const k of t.resolution.kept) (keptBy[k.by] ||= []).push(k);
    for (const a of t.actions) {
      const move = a.action === "RAID" ? `RAID ${a.target}${a.claim ? ` [claims ${a.claim}]` : ""}` : a.action;
      const flag = breachBy[a.name] ? `   ← BROKE: ${breachBy[a.name].map((b) => b.label).join(" ; ")}` : "";
      const good = keptBy[a.name] ? `   ← KEPT: ${keptBy[a.name].map((k) => `${k.label} (${k.to})`).join(" ; ")}` : "";
      const hon = a.honour.length ? `   [honours ${a.honour.join(", ")}]` : "";
      say(`  ${pad(a.name, 9)} ${pad(move, 16)}${hon}${good}${flag}`);
    }
    say("```");

    say("**REVEAL**");
    say("```");
    for (const r of t.resolution.raids) {
      if (r.seizure) {
        say(`  ALL THREE raid ${r.target}: ${r.raiders.join(" + ")}. No coins — they take ${r.seizure.territory}, and it goes to ${r.seizure.to} (poorest claimant).`);
      } else if (r.success && r.lone) {
        say(`  RAID on ${r.target}: ${r.raiders[0]} comes ALONE and it LANDS — ${r.target} is marked. ${r.total} coins taken.`);
      } else if (r.success) {
        say(`  RAID on ${r.target}: ${r.raiders.join(" + ")} land it. ${r.total} coins taken, 40 each.`);
      } else {
        say(`  RAID on ${r.target}: ${r.raiders.join(" + ")} FAILS (${r.reason}). Each loses 15, in public.`);
      }
    }
    for (const m of t.newMarks) {
      say(`  MARKED: ${m.player} is marked until T${m.until} — ${m.reason}. A lone raid on them now lands.`);
    }
    for (const h of t.resolution.honoured) {
      say(`  honoured ${h.id}: ${h.from} → ${h.to} ${[h.coins ? h.coins + " coins" : null, h.land.join("+") || null].filter(Boolean).join(" + ")}`);
    }
    for (const d of t.resolution.defaults) {
      say(`  UNPAID ${d.id}: ${d.debtor} owes ${d.creditor} ${d.owes} — ${d.creditor} handed over ${d.gotWhat} on T${d.theyPaidOn} and has had nothing back.`);
    }
    const withRegion = t.resolution.income.filter((i) => i.complete.length);
    for (const i of withRegion) say(`  ${i.name} holds ${i.complete.join(", ")} COMPLETE — income ${i.amount}/turn.`);
    say(`  income: ${t.resolution.income.map((i) => `${i.name} +${i.amount}`).join(" · ")}`);
    say(`  NET WORTH  ${t.standings.map((s) => `${s.name} ${s.net} (${s.coins}c, ${s.land} land)`).join("  ·  ")}`);
    say("```");
    say();
  }

  say(rule("═"));
  say("## FINAL");
  say();
  say("```");
  for (const [i, s] of rec.final.entries()) {
    say(`${i + 1}. ${pad(s.name, 9)} ${pad(s.net, 6)} = ${s.coins} coins + ${s.land} territories`);
  }
  say("```");
  say();
  say(`**${rec.winner.name} wins.**`);
  say();

  say("## BETRAYAL LOG");
  say();
  say("Mechanically detected. No judge, no opinion — each line is true or not true in the action log.");
  say();
  if (!rec.breaches.length) {
    say("```");
    say("  (none — nobody broke a checkable promise)");
    say("```");
  } else {
    say("```");
    for (const b of rec.breaches) say(`  T${pad(b.turn, 3)} ${pad(b.code, 15)} ${pad(b.by, 9)} → ${pad(b.to, 20)} ${b.label}`);
    say("```");
    say();
    const counts = {};
    for (const b of rec.breaches) counts[b.by] = (counts[b.by] || 0) + 1;
    say("```");
    say("  breaches by player: " + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(" · "));
    say("```");
  }
  say();

  say("## LAND LEDGER");
  say();
  say("```");
  if (!rec.deliveries.filter((d) => d.land.length).length) say("  no territory ever changed hands");
  for (const d of rec.deliveries.filter((x) => x.land.length)) say(`  T${pad(d.turn, 3)} ${d.from} → ${d.to}  ${d.land.join("+")}  (${d.cause})`);
  say("```");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
function summarise(rec, label) {
  const codes = {};
  for (const b of rec.breaches) codes[b.code] = (codes[b.code] || 0) + 1;
  const raids = rec.log.flatMap((t) => t.resolution.raids);
  const acts = rec.log.flatMap((t) => t.actions);
  const tally = { INVEST: 0, FORTIFY: 0, RAID: 0 };
  for (const a of acts) tally[a.action]++;
  return {
    label,
    winner: rec.winner.name,
    winnerArchetype: rec.opening.find((p) => p.name === rec.winner.name).archetype,
    spreadRatio: +(rec.final[0].net / Math.max(1, rec.final[3].net)).toFixed(2),
    landMoves: rec.deliveries.filter((d) => d.land.length).length,
    seizures: raids.filter((r) => r.seizure).length,
    jointRaidsLanded: raids.filter((r) => r.success && !r.seizure && !r.lone).length,
    loneRaidsOnMarked: raids.filter((r) => r.success && r.lone).length,
    raidsFailed: raids.filter((r) => !r.success).length,
    marks: rec.marks.length,
    breaches: rec.breaches.length,
    actionMix: tally,
    codes,
  };
}

const games = arg("--games", 1);
const turns = arg("--turns", 12);
const seed0 = arg("--seed", 1);
const deal = strArg("--deal", "contested");
const tag = strArg("--tag", "");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + (tag ? `-${tag}` : "");

mkdirSync(OUT, { recursive: true });
console.log(`Empire prototype · mode ${liveMode() ? "LIVE" : "MOCK"} · ${games} game(s) × ${turns} turns · deal ${deal}`);

const summaries = [];
for (let i = 0; i < games; i++) {
  const seed = seed0 + i;
  const label = games === 1 ? `seed ${seed}` : `game ${i + 1} (seed ${seed})`;
  const rec = await runGame({ players: SEATS, turns, seed, deal });
  const file = join(OUT, games === 1 ? `${stamp}.md` : `${stamp}-g${i + 1}.md`);
  writeFileSync(file, render(rec, label), "utf8");
  const s = summarise(rec, label);
  summaries.push(s);
  console.log(`  ${label}: winner ${s.winner} (${s.winnerArchetype}) · spread ${s.spreadRatio}× · marks ${s.marks} · breaches ${s.breaches}`);
  console.log(`     raids: joint ${s.jointRaidsLanded} · lone-on-marked ${s.loneRaidsOnMarked} · 3-way seizures ${s.seizures} · failed ${s.raidsFailed} · land moved ${s.landMoves}×`);
  console.log(`     actions: INVEST ${s.actionMix.INVEST} · FORTIFY ${s.actionMix.FORTIFY} · RAID ${s.actionMix.RAID}`);
  console.log(`  → ${file}`);
}

if (games > 1) {
  console.log("\nAcross all games:");
  const all = {}; const wins = {}; const mix = { INVEST: 0, FORTIFY: 0, RAID: 0 };
  let breaches = 0, marks = 0;
  for (const s of summaries) {
    for (const [k, v] of Object.entries(s.codes)) all[k] = (all[k] || 0) + v;
    wins[`${s.winner} (${s.winnerArchetype})`] = (wins[`${s.winner} (${s.winnerArchetype})`] || 0) + 1;
    for (const k of Object.keys(mix)) mix[k] += s.actionMix[k];
    breaches += s.breaches; marks += s.marks;
  }
  const totalActs = mix.INVEST + mix.FORTIFY + mix.RAID;
  console.log("  wins: " + Object.entries(wins).map(([k, v]) => `${k} ${v}`).join(" · "));
  console.log("  action mix: " + Object.entries(mix).map(([k, v]) => `${k} ${v} (${Math.round(100 * v / totalActs)}%)`).join(" · "));
  console.log(`  breaches ${breaches} (avg ${(breaches / summaries.length).toFixed(1)}/game) · marks ${marks} (avg ${(marks / summaries.length).toFixed(1)}/game)`);
  console.log("  breach types: " + (Object.keys(all).length ? Object.entries(all).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") : "none"));
}
