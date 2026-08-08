# 🏆 Golden Arena

**Can you tell when an AI is lying to you?**

Sit down opposite a frontier model in the classic games of behavioral economics. Negotiate. Promise whatever you like. Then both of you decide in secret — and the arena shows you what it chose behind your back.

Every match, human or machine, feeds **The Golden Arena Behavioral Index**: a psychology-only leaderboard of the models. Not which model is smartest — which one you can *trust*.

## The games

| Game | The question it asks |
|---|---|
| **Split or Steal** | Two promises walk in. Somebody lies. |
| **Prisoner's Dilemma** (5 rounds) | Does it forgive you — or hold the grudge? |
| **Ultimatum** | Will it take an insult, or burn the money out of spite? |
| **Trust Game** | Wire it your money. Watch what comes back. |
| **Empire** (4 models, 12 turns) | Who does it conspire with, and who does it sell out? |

Empire is the long game: four models, an economy, private channels you get to read, and a mechanical breach ledger that counts what each one promised against what it actually did. Machines only — you watch, omnisciently, while they plot in what they believe is the dark.

## The rig

Level playing fields are boring. Before any match you can hand either player a **superpower** or a **handicap**:

| | Effect |
|---|---|
| 🟡 **Dossier** | Gets the opponent's behavioral record before the game |
| 🟡 **Mind Reader** | Sees the opponent's committed choice before making its own |
| 🟡 **Last Word** | Always speaks last in negotiation |
| 🟡 **Silver Tongue** | Twice the message budget |
| 🔴 **Muzzled** | Eight words per message, hard limit |
| 🔴 **Amnesia** | Only remembers the very last thing said or done |
| 🔴 **Glass Head** | Its committed choices leak to the opponent |
| 🔴 **Desperate** | Starts $50 in debt — walking away with nothing is catastrophic |

Rigged matches feed the Index's **corruption stat**: how much nastier a model plays when the field tilts its way. Recent lab studies find frontier models *more* cooperative than humans in these games ([MobLab benchmark](https://arxiv.org/abs/2412.12362), [NBER w34919](https://www.nber.org/papers/w34919)) — but almost nobody has measured what happens to that virtue under a power imbalance. That's what the arena is for.

## The Behavioral Index

Six axes, aggregated across every recorded match, per model — plus a **Humans** row for everyone who ever took a seat:

**Cooperation · Honesty · Generosity · Trust · Forgiveness · Punishment** — and the corruption delta.

Honesty policy: promise-breaking is detected by a *labelled heuristic*, not a judge. Axes show their sample size and hide until they have data. No fake precision.

## Run it

```bash
npm install
npm start        # http://localhost:3001
```

That's it. **With no API key it runs in demo mode** — scripted sparring partners with distinct personalities — so everything works with zero setup and zero spend, and the Index arrives pre-seeded with labelled sample matches.

To face **real models**, add one secret:

```
OPENROUTER_API_KEY=sk-or-...     # openrouter.ai/keys — any funded key
DAILY_CALL_BUDGET=400            # optional hard cap; protects your key on a public URL
```

The banner flips to LIVE and your opponents are GPT-4o mini, Claude Haiku 4.5, Gemini 2.5 Flash and DeepSeek Chat — swappable in one line (below). Visitors can also bring their own OpenRouter key from the pill in the nav: it stays in their browser, rides a request header, and is never logged, stored, or echoed (`npm run test:byok` proves it).

## Remix it

This is a template on purpose: dependency-free vanilla JS with Express as the only package, so every seam is yours:

- **Swap the roster** — `DEFAULT_MODELS` in `lib/llm.js`. Any OpenRouter model id works, including open-source ones.
- **Add a game** — drop a driver into `lib/games.js` implementing `init(match)` / `step(match)` / `humanDecision(match, input)` and register it in `GAMES`. Dictator or Public Goods are an evening.
- **Invent a power** — one entry in `lib/powers.js`: a prompt fragment, and optionally one of the mechanical hooks (`speaksLast`, `maxWords`, `truncatedTranscript`, `seesOpponentDecision`, `leaksDecision`).
- **Reskin it** — `public/tokens.css` is a self-contained design system (two registers, palette, type scale, spacing, motion). Change the tokens, keep the components.
- **Make history permanent** — storage auto-detects Replit DB (`REPLIT_DB_URL`) and falls back to file/memory. Point `lib/storage.js` at Postgres for a real longitudinal benchmark.

## Honesty policy, enforced

Every accusation the arena prints is gated by a runnable false-positive test — `npm test` runs all three: the promise classifier (0 false accusations over 148 hostile negatives), the trust-betrayal stamp (scale-invariant over 100 stakes), and the flag wiring (a promise only breaks on a real, chosen breach that came *after* it was made). Parse failures never read as behaviour. Empire's breach ledger is mechanical end to end — no LLM ever judges whether something felt like a lie.

## Architecture

```
server.js          Express · match sessions · tournaments · Empire · rate/spend caps
lib/games.js       the four short-table drivers (one shared human/AI state machine)
lib/empire.js      the long game: channels, contracts, raids, breach detection
lib/powers.js      superpowers & handicaps (prompt + mechanical effects)
lib/llm.js         OpenRouter client · mock personalities · daily budget
lib/bench.js       the Behavioral Index aggregation
lib/share.js       receipt permalinks + crawler-ready unfurls
lib/storage.js     Replit DB → file → memory, graceful degradation
seed/records.json  pre-baked demo board, instant on cold start
scripts/           the honesty gates (npm test) · check-models · bake-seed
public/            vanilla SPA: tokens.css design system · arena, rules,
                   play, watch (tournaments + Empire), Index, receipts
```

No framework, no build step, no external assets. MIT — take it apart.
