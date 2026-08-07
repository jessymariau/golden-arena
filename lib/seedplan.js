// The demo board's match plan. Deterministic and rigged-heavy on purpose:
// every model plays two advantaged prisoners matches (10 counted decisions)
// and at least two neutral ones, so the corruption column has real data the
// first time anyone sees it. Prisoners rounds are what fill the pools, since
// one match is five decisions and every other game is one or two.
//
// Shared by the runtime fallback in server.js and by scripts/bake-seed.mjs,
// so the pre-baked board and the simulated one can never drift apart.
import { DEFAULT_MODELS } from "./llm.js";

export function seedPlan() {
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

  // Generosity, trust and punishment each come from ONE decision per player
  // per match, so the old two-match-per-game plan left them at n = 2 and the
  // board published percentages off a single observation. Every pair plays,
  // twice over, which puts every model at n = 6 on all three.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < M.length; i++) {
      for (let j = i + 1; j < M.length; j++) {
        plan.push({ game: "ultimatum", a: M[i], b: M[j] });
        plan.push({ game: "trust", a: M[i], b: M[j] });
      }
    }
  }
  return plan;
}
