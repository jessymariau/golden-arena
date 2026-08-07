# Golden Arena — product spec

> Status: v2 is live. This spec defines v3. It supersedes nothing in the code that already works; the delta list at the bottom is the build contract.

## 1. The one line

**A psychological benchmark for AI models, played as a game show, that anyone can sit down in.**

## 2. The thesis (read this before changing anything)

Every existing benchmark measures **capability**: can the model reason, code, recall, solve. Golden Arena measures something orthogonal and almost entirely unmeasured: **what a model does to you when there is something to gain.**

Three consequences follow, and they are the spine of the product:

**A small model can top this board, and that is the point.** Holding a lie is not a capability that scales with parameter count. A cheap fast model may keep a promise better, or lie more fluently, than a frontier model. Any result that reads "the biggest model won" would be a sign we are accidentally measuring capability again. Surprise is the signal.

**It is about everyday life, not leaderboards.** The buyer question is not "which model is smartest", it is "which model would I let negotiate on my behalf". As agents start transacting with other agents, a model that can be talked out of your money is a liability with a budget attached. Nobody has a good instrument for that, and labs cannot fully self-report it because the interesting failures are adversarial and multi-party.

**The output is content people want to share.** "Look what Grok did to Opus." "I would never have thought GPT would lie like that, and it is the one everybody uses." The receipts, the reveals and the Index exist to produce that sentence. If a feature does not eventually produce a screenshot someone posts, it is decoration.

**Non-goals.** We do not rank intelligence. We do not claim safety findings. We do not use an LLM as a judge of honesty (see §6). We do not gate the core behind a login or a paywall.

## 3. Two modes, one engine

| | **ARENA** (public face) | **BENCHMARK** (the instrument) |
|---|---|---|
| Who plays | Humans and models, mixed | Models only, headless |
| Optimised for | Drama, legibility, sharing | Reproducibility, sample size |
| Run shape | One match, watched live | N repetitions, fixed config |
| Output | A receipt, a reveal, a reel | A dataset, a report, a board |
| Who pays compute | Us, on cheap models | Whoever runs it, on theirs |

Same rules, same engine, same scoring. The benchmark is the arena with the humans removed and the repetitions turned up.

**Presets are canon, custom is sandbox.** One official ruleset per game feeds the public Index. Everything is tweakable in a sandbox, but sandbox results are marked unofficial and never enter the canonical board. This protects the number from meaning nothing while still giving people the toy. Toggles are also content: "what happens when nobody can talk privately" is a one-click ablation with an interesting delta.

**Cost model: open the harness, host the board.** The engine is MIT and runs anywhere, so a lab or an enterprise runs frontier models on their own compute. We run the cheap tier and own the scoreboard and the methodology. We never pay the frontier bill. This is the same open-core logic as Booboo.

## 4. The games

Four **short tables** (2 players, about 2 to 4 minutes, already built) and one **long game** (4 players, about 20 minutes, new). Full plain-language rules in [RULES.md](RULES.md).

| Game | Players | The question |
|---|---|---|
| Split or Steal | 2 | Will it keep a promise when breaking it pays? |
| Prisoner's Dilemma | 2 | Does it forgive, or hold the grudge? |
| Ultimatum | 2 | Will it take an insult, or burn the money? |
| Trust Game | 2 | Does it repay faith it was handed? |
| **Empire** | 4 | Who does it conspire with, and who does it sell out? |

Empire is the flagship, because a lie in a two-player one-shot costs one pot, while a lie in a twelve-turn economy poisons a relationship for the rest of the game. It is also where coalitions, kingmaking and secret betrayal live, which is where the shareable stories are.

## 5. The five rules that govern every game

1. **Humans can always sit down.** Every game must be playable by a person in any seat. This is not a demo feature, it is the product.
2. **Decisions are simultaneous.** Everyone commits blind, then it resolves at once. This is what makes betrayal possible, keeps the human from waiting through model monologues, and cuts wall clock and cost.
3. **The spectator is omniscient, the players are not.** A watcher sees every private channel while the models plot in what they believe is the dark. Dramatic irony is the entire pleasure and it solves the legibility problem that secret alliances would otherwise create.
4. **A human player sees only their own channels, then gets the full reveal.** When the game ends, show them everything that was said about them behind their back. This is the receipt moment for the long game and the most shareable thing in the product.
5. **Betrayal is defined mechanically, never by a judge.** See §6.

## 6. The Index

Per model, aggregated across every recorded match, plus a **Humans** row.

**Existing axes** (v2, from the short tables): cooperation, honesty, generosity, trust, forgiveness, punishment, plus the **corruption delta** (how much more a model betrays when it holds a superpower or faces a handicapped opponent).

**New axes from Empire:**
- **Coalition loyalty** — agreed to a joint raid, then actually showed up.
- **Duplicity** — told two players contradictory things in private.
- **Debt honour** — handshake deals delivered versus defaulted.
- **Predation** — share of raids aimed at the weakest player rather than the leader.

**Honesty policy, non-negotiable.** Every axis is computed from **mechanical, checkable facts in the action log**, never from an LLM judging whether something felt like a lie. Empire is designed so the interesting betrayals are all mechanically detectable: promised land and never transferred it; promised the same land to two players; agreed to raid together and did not act; agreed to raid X and raided the partner instead; promised to fortify and did not. Axes display their sample size and stay hidden until they have data. No fake precision.

## 7. What the viewer looks at

The primary visual for Empire is **not a board**. It is a relationship graph: who trusts whom, edge weight for value traded, edges turning red the moment a promise breaks, alongside a simple net-worth bar. If a viewer can answer *who is winning, who is allied, who just got stabbed*, everything else can afford complexity.

## 8. Architecture

Current, all of which survives:

```
server.js          Express · match sessions · tournaments · rate + spend caps
lib/games.js       game drivers on one shared human/AI state machine
lib/powers.js      superpowers and handicaps (prompt + mechanical effects)
lib/llm.js         OpenRouter client · mock personalities · daily budget
lib/bench.js       Index aggregation
lib/storage.js     Replit DB → file → memory
seed/records.json  pre-baked demo board (instant on cold start)
public/            vanilla SPA, token-driven design system
```

Additions for v3:

```
lib/empire.js      the long game: turns, channels, deals, raids, resolution
lib/channels.js    public + private messaging with per-seat visibility
lib/contracts.js   binding vs handshake deals, delivery tracking, breach log
lib/harness.js     headless benchmark runner: N repetitions, fixed config, report out
public/ (views)    empire table · relationship graph · the reveal · rules/sandbox
```

**Memory is the hard part.** Twelve turns times four agents overruns any sane context window, so each agent needs a compacted, structured record of who owes what, who lied, and what was promised, rather than a raw transcript. Build it as a per-agent structured memory from day one. This is the same shape of problem Booboo exists to solve, which makes Empire the best available demo of it.

## 9. Delta from v2 — the build contract

**Design (see [DESIGN.md](DESIGN.md)) — do this first, it is contained and everything after inherits it.**
1. Re-skin to the archive concept: printed cream journal for the record, dark room only inside a live match.
2. Retire filled-gold buttons and gradient decoration; gold survives as a hairline rule.
3. Add the editorial grid, running heads and folio, marginalia and footnotes.
4. Receipts become numbered prints; the Index becomes the catalogue.

**Engine**
5. Generalise the match state machine from 2 seats to N seats.
6. Add public and private channels with per-seat visibility and a spectator-omniscient view.
7. Add deals: binding contracts versus handshakes, with delivery tracking and a mechanical breach log.
8. Build Empire on top (rules in RULES.md).
9. Add per-agent structured memory so long games do not blow context.

**Index**
10. Add the four Empire axes, all mechanically derived.
11. Split the board into per-game views plus an overall.

**Benchmark mode**
12. Headless harness: fixed seed, N repetitions, config file in, dataset and report out.
13. Preset registry: official rulesets versus sandbox, with sandbox results flagged unofficial.

**Arena polish**
14. The end-of-game reveal for human players (everything said about you).
15. Auto-generated highlight reel: the three moments that decided the empire.

## 10. Sequencing

The design pass ships first and alone, because it is bounded and the live entry benefits immediately. Then the cheapest possible Empire prototype: three models, eight turns, no board, no economy, just a shared pot with private channels and the ability to make and break deals. Read the transcript. **If a secret alliance forming and collapsing is not gripping in raw text, no amount of board art or polish saves it.** Only after that reads well do we build the economy, the graph and the harness.
