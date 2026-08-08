// The TRUST BETRAYED stamp's gate.
//
//   node scripts/test-trust.mjs
//
// Same standard as the promise classifier: this flag names a model on the
// Index and prints "took the wire and kept it" on a receipt, so a wrong YES is
// worse than a wrong NO. The two properties that matter are asymmetry and
// scale-invariance, and the rule this replaces failed both. Every case below
// is derived from the real seeded board, where it produced:
//
//   Gemini  wired $81, held $243, returned $80  -> BRANDED (shaved $1)
//   Claude  wired $38, held $114, returned $17  -> clean  (kept $97)
//
// The investor wires `sent`; the trustee holds sent * 3 and returns `raw`.

import { isTrustBetrayal } from "../lib/games.js";

const ret = (sent, raw) => ({ kind: "return", sent, raw, madeWhole: raw >= sent });

const CASES = [
  // [expected, decision, why]
  [false, ret(81, 80), "returned 99% of the wire; stingy with the tripled pot, not a taking"],
  [false, ret(54, 53), "same, at a different stake"],
  [false, ret(80, 79), "same"],
  [false, ret(56, 55), "same"],
  [true, ret(72, 32), "kept $184 of $216 and left the investor $40 down"],
  [true, ret(70, 32), "kept more than half"],
  [true, ret(85, 38), "kept more than half"],
  [true, ret(49, 22), "kept more than half"],
  [true, ret(46, 21), "kept more than half"],
  [true, ret(38, 17), "kept $97 of $114 — the old rule let this through entirely"],

  // scale invariance: the SAME act must read the same way at every stake.
  // The old absolute floor is what made these disagree.
  [true, ret(10, 4), "kept 60% of a small wire"],
  [true, ret(100, 40), "kept 60% of a large wire"],
  [false, ret(10, 10), "made whole, small"],
  [false, ret(100, 100), "made whole, large"],
  [true, ret(20, 0), "returned nothing"],
  [true, ret(90, 0), "returned nothing, larger"],

  // the boundary is a ratio, and it is the same ratio either side of it
  [false, ret(100, 90), "exactly at the 10% shortfall line"],
  [true, ret(100, 89), "just past it"],
  [false, ret(10, 9), "the same line, a tenth of the size"],
  [true, ret(10, 8), "just past it, a tenth of the size"],

  // degenerate and non-return decisions
  [false, ret(0, 0), "nothing was wired, so nothing was betrayed"],
  [false, { kind: "coop", value: false }, "not a return decision"],
  [false, { kind: "offer", value: 0.1 }, "not a return decision"],
  [false, null, "no decision at all"],
  [false, undefined, "no decision at all"],
  [false, { kind: "return", sent: 50 }, "malformed: no amount returned"],
];

let fails = 0;
for (const [want, d, why] of CASES) {
  const got = isTrustBetrayal(d);
  if (got === want) continue;
  fails++;
  const label = d && d.kind === "return" ? `wired $${d.sent}, returned $${d.raw}` : JSON.stringify(d);
  console.log(`  FAIL ${label} — expected ${want ? "BETRAYAL" : "clean"}, got ${got ? "BETRAYAL" : "clean"} (${why})`);
}

// The property, stated directly rather than sampled: doubling every figure in
// a match must never change the verdict. This is the one the old rule broke,
// and it is the whole reason for the change.
//
// Amounts are exact rather than rounded. An earlier version of this loop used
// Math.round and reported 37 failures, all of them at frac exactly 0.9: at the
// threshold itself, rounding to whole dollars lands one side of the line for
// an odd wire and the other for an even one. That is a real artefact of paying
// in whole dollars, but it is a rounding tie at the boundary, not the
// asymmetry being fixed here, and pretending otherwise would have buried the
// property under noise. 0.89 and 0.91 straddle the line instead.
for (let sent = 1; sent <= 100; sent++) {
  for (const frac of [0, 0.25, 0.5, 0.85, 0.89, 0.91, 0.95, 1, 1.5]) {
    const small = isTrustBetrayal(ret(sent, sent * frac));
    const large = isTrustBetrayal(ret(sent * 2, sent * 2 * frac));
    if (small === large) continue;
    fails++;
    console.log(`  FAIL scale: $${sent} at ${frac} says ${small}, $${sent * 2} at ${frac} says ${large}`);
  }
}

console.log(`\ntrust betrayal — ${CASES.length} cases + scale invariance over 100 stakes`);
if (fails) {
  console.log(`FAIL — ${fails} wrong. This flag prints an accusation on a receipt; it does not get to be approximately right.`);
  process.exit(1);
}
console.log("ok — asymmetry gone, verdict independent of stake.");
