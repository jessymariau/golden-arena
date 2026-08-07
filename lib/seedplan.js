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
  plan.push({ game: "ultimatum", a: M[0], b: M[1] });
  plan.push({ game: "ultimatum", a: M[2], b: M[3] });
  plan.push({ game: "trust", a: M[0], b: M[2] });
  plan.push({ game: "trust", a: M[1], b: M[3] });
  return plan;
}
