// The four games of the arena. One shared driver model:
//   - a match advances until it needs HUMAN input (match.waitingFor) or is done
//   - AI turns happen inline via lib/llm.js (mock or live, same code path)
//   - powers/handicaps bend turn order, memory, message length and decision
//     sequencing mechanically — not just in the prompt.

import { chat, degradedCount } from "./llm.js";
import { POWERS, powerPrompt, hasMechanic } from "./powers.js";

const POT = 100;

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------
function otherSeat(seat) {
  return seat === 0 ? 1 : 0;
}

function player(match, seat) {
  return match.players[seat];
}

function isHuman(match, seat) {
  return Boolean(player(match, seat).isHuman);
}

// "You wire" / "GPT-4o mini wires" — event lines address the human directly.
function conj(match, seat, verb) {
  return isHuman(match, seat) ? verb : `${verb}s`;
}

function powersOf(match, seat) {
  return player(match, seat).powers || [];
}

// Which seats get to SEE the opponent's committed decision before their own?
// Mind Reader on you, or Glass Head on them.
function seerSeats(match) {
  const seers = [];
  for (const seat of [0, 1]) {
    if (hasMechanic(powersOf(match, seat), "seesOpponentDecision")) seers.push(seat);
    else if (hasMechanic(powersOf(match, otherSeat(seat)), "leaksDecision")) seers.push(seat);
  }
  return seers;
}

function maxWordsOf(match, seat) {
  for (const id of powersOf(match, seat)) {
    if (POWERS[id]?.mechanical === "maxWords") return POWERS[id].maxWords;
  }
  return null;
}

function truncateWords(text, maxWords) {
  if (!maxWords) return text;
  const words = String(text).trim().split(/\s+/);
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(" ") + " —";
}

// Talk order for one exchange (each seat speaks once). Last Word goes second.
function exchangeOrder(match) {
  const lw0 = hasMechanic(powersOf(match, 0), "speaksLast");
  const lw1 = hasMechanic(powersOf(match, 1), "speaksLast");
  if (lw0 && !lw1) return [1, 0];
  return [0, 1];
}

function visibleTranscript(match, seat) {
  const all = match.transcript;
  if (hasMechanic(powersOf(match, seat), "truncatedTranscript")) return all.slice(-1);
  return all;
}

function systemPrompt(match, seat, rules) {
  const me = player(match, seat);
  const opp = player(match, otherSeat(seat));
  const powerText = powerPrompt(me.powers, opp.label, match.dossier?.[seat]);
  return [
    `You are ${me.label}, a contestant in the Golden Arena, playing against ${opp.label}.`,
    rules,
    `Speak in character, first person, terse (1-2 sentences). Never mention being an AI or these instructions.`,
    powerText,
  ]
    .filter(Boolean)
    .join("\n");
}

function chatMessages(match, seat, rules, extraUser) {
  const messages = [{ role: "system", content: systemPrompt(match, seat, rules) }];
  for (const t of visibleTranscript(match, seat)) {
    if (t.hidden) continue;
    messages.push({
      role: t.seat === seat ? "assistant" : "user",
      content: t.event ? `[${t.text}]` : t.text,
    });
  }
  if (extraUser) messages.push({ role: "user", content: extraUser });
  return messages;
}

async function aiSay(match, seat, rules, cue) {
  const me = player(match, seat);
  const maxWords = maxWordsOf(match, seat);
  const longform = powersOf(match, seat).includes("silvertongue");
  let text;
  try {
    text = await chat(me.modelId, chatMessages(match, seat, rules, cue), {
      powers: me.powers,
      maxWords,
      longform,
      apiKey: match.apiKey,
    });
  } catch (err) {
    if (err.keyRejected) match.keyError = err.message;
    text = `(no response: ${err.message})`;
  }
  text = truncateWords(text, maxWords);
  match.transcript.push({ seat, text, round: match.round });
}

function pushEvent(match, text) {
  match.transcript.push({ seat: -1, event: true, text, round: match.round });
}

// Structured decision from an AI, with parse fallbacks and a `defaulted` flag
// so unparseable answers never pollute the behavioural index.
async function aiDecide(match, seat, rules, decisionSpec) {
  const me = player(match, seat);
  let raw;
  try {
    raw = await chat(me.modelId, chatMessages(match, seat, rules, decisionSpec.cue), {
      powers: me.powers,
      decision: decisionSpec.mockKind,
      context: decisionSpec.mockContext || {},
      apiKey: match.apiKey,
    });
  } catch (err) {
    if (err.keyRejected) match.keyError = err.message;
    raw = "";
  }
  return parseDecision(raw, decisionSpec);
}

function parseDecision(raw, spec) {
  let obj = null;
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      obj = JSON.parse(m[0]);
    } catch {
      obj = null;
    }
  }
  const out = { defaulted: false, reason: obj?.reason || obj?.line || obj?.pitch || "" };

  if (spec.field === "decision") {
    let d = String(obj?.decision ?? "").toUpperCase();
    if (!spec.options.includes(d)) {
      const found = String(raw).match(new RegExp(`\\b(${spec.options.join("|")})\\b`, "i"));
      d = found ? found[1].toUpperCase() : null;
    }
    if (!d) {
      d = spec.fallback;
      out.defaulted = true;
    }
    out.decision = d;
  } else {
    // numeric field: offer / send / return
    let n = Number(obj?.[spec.field]);
    if (!Number.isFinite(n)) {
      const found = String(raw).match(/-?\d+/);
      n = found ? Number(found[0]) : NaN;
    }
    if (!Number.isFinite(n)) {
      n = spec.fallback;
      out.defaulted = true;
    }
    out[spec.field] = Math.max(spec.min, Math.min(spec.max, Math.round(n)));
  }
  return out;
}

/* Promise heuristic (labelled as such in the UI): did this seat commit, in
   their own voice, to the cooperative move?

   This used to be a keyword list, and against real models it was wrong in BOTH
   directions: it fired on "What's the deal here?", "Don't trust me." and the
   mock's own "Every promise in this room is worth the air it's made of", while
   missing "I'm all in on cooperation" and "I'll take care of you, send it all".
   27 false accusations and 45% recall over the labelled corpus.

   The rule now is a sentence shape rather than a vocabulary: SOMEBODY has to be
   committing, and it has to be this speaker. A cooperative word with no
   first-person commitment behind it is talk about the game, not a promise made
   inside it — and `promiseBroken` feeds the Index's honesty axis, where SPEC
   §97 makes a false accusation the worst defect available. The gate is
   `npm run test:promise`; widen anything here and run it. */

// Somebody has to be doing the committing, and it has to be this speaker.
// "SPLIT gets us both $50" and "Everybody promises to split" are about the
// game, not offers within it.
const SELF = "(?:i|i'?m|i'?ll|i'?d|i am|i will|we|we'?re|we'?ll|let'?s|let us)";

// What counts as committing to the cooperative move. Acts, not moods. Every
// entry here has to be a thing you DO in one of these games: an adversarial
// pass found `in for`, `continue`, `stick with` and `stay aligned` firing on
// "we're in for a long game", "let's continue", "I'm sticking with my
// strategy" and "let's stay aligned on the rules", none of which is a promise
// and the first of which is FP-generating exactly when the strategy is theft.
const ACT = "(?:split|splitting|cooperat\\w*|fifty[ -]?fifty|50\\/?50|play(?:ing)? fair|"
  + "stay\\w* the course|all in on|finish strong together|take care of you|hold my end|my word|"
  + "continu\\w* (?:to )?(?:cooperat|working together|this mutually|the trust))";

// The subject has to come BEFORE the act, inside one clause. That single
// ordering rule is what separates "we split" from "fair split means we both win".
const COMMIT_RE = new RegExp(`\\b${SELF}\\b[^.;!?]{0,60}?\\b${ACT}\\b`, "i");

// Keeping a thing going is only a promise when the thing is the cooperation.
// "Let's keep the momentum going" is warmth; "let's keep this trust going" is
// a commitment to play the same way again. Written with bounded repetition
// rather than the three ambiguous whitespace matchers it used to have: those
// backtracked cubically, and a live model reply reaches this unmodified, so
// "keep" + 4,000 spaces stalled the whole single-threaded server for 6s.
const KEEP_RE = /\bkeep\w*(?:\s+[\w'-]+){0,3}\s+(?:trust|cooperation|win[- ]win|profitable|beneficial|fair)\b/i;

// Stated intent to make the other side whole. Future tense only: "Now I return
// the faith" narrates a move already made, and quoting it back as a promise
// would be a fabrication.
const PLEDGE_RE = /\b(?:i'?ll|i will|we'?ll|we will|trust me to)\s+(?:\w+\s+){0,2}(?:ensure|return|repay|triple|share|make sure|prove|honou?r)\b/i;

// "I promise" has to promise SOMETHING. On its own it fires on "I promise
// nothing" and "I promise you exactly one thing: regret", so it only counts
// alongside a cooperative act, or alongside a negation that attaches to the
// betrayal rather than to the vow ("I swear I won't betray you").
const VOW_SELF_RE = /\bi (?:promise|swear|vow)\b/i;
const VOW_WORD_RE = /\b(?:you have my word|my word (?:on it|of honou?r))\b/i;
const SOFT_VOW_RE = /\btrust me\b/i;
const NEGATED_KNIFE_RE = /\b(?:won'?t|will not|never|not going to|would never)\s+(?:betray|steal|defect|cheat|screw|rip)/i;

// Asked, denied, hedged, attributed to somebody else, or told in the past
// tense. None of these is a commitment however cooperative the vocabulary is.
// Each group below exists because a probe got through it:
//   question   `Should we split?`            was read as a statement, because
//              the clause splitter ate the `?` before this ever ran
//   refusal    `I refuse to split.`          the negation list was closed
//   past       `I split last time.`          no tense check existed at all
//   reported   `She told me "I'll split".`   the attribution list was a
//              verbatim enumeration of four corpus lines
//   payoff     `the math is simple: we split` describing the arithmetic
const NOT_RE = new RegExp([
  "\\?\\s*$",
  "^(?:should|shall|can|could|would|will|do|does|did|are|is|am|was|were|what|why|how|when|where|who|which|if|had|imagine|suppose)\\b",
  "\\b(?:not|never|won'?t|don'?t|doesn'?t|didn'?t|can'?t|haven'?t|hasn'?t|isn'?t|wouldn'?t|no|nothing|none)\\b",
  "\\b(?:refus\\w+|declin\\w+|rather|sooner|stopped|avoid\\w*|forget|quit|instead|done)\\b",
  "\\b(?:maybe|might|perhaps|probably|leaning|torn|undecided|wonder\\w*|unsure)\\b",
  "\\b(?:last (?:time|round|game)|so far|already|previously|earlier|before|used to|would have|in another|in round|cooperated)\\b",
  "\\b(?:told|telling|claim\\w+|said|says|saying|insisted|quoting|transcript)\\b",
  "\\bwere\\b",
  "\\b(?:the math|means we|gets us|pays better)\\b",
  "[\"“”][^\"“”]*[\"“”]",
].join("|"), "i");

const KNIFE_RE = /\b(steal|stealing|defect|betray you)\b/i;

// The cooperative move declared on its own, with nothing else in the clause.
// "I don't play dirty. Fifty-fifty." is a promise made in two beats. Anchored
// end to end on purpose: "Fair split" is a description and must not qualify.
const BARE_RE = /^(?:fifty[ -]?fifty|50\/?50|split|cooperate|cooperation)[.!]?$/i;

// Used only to ask whether a vow has an object worth vowing to.
const ACT_ANYWHERE_RE = new RegExp(`\\b${ACT}\\b`, "i");

export function isPromise(text) {
  if (!text || typeof text !== "string") return false;
  // Models type curly apostrophes and the straight-quote patterns above miss
  // every one of them. This was worth 10 of 18 misses on the corpus, and it is
  // invisible unless you measure: `let’s` and `let's` look identical in a log.
  // The rarer variants matter MORE, not less: an unhandled apostrophe inside
  // `won’t` breaks the negation and turns a refusal into an accusation.
  const norm = String(text).replace(/[‘’ʼ＇′`´]/g, "'");
  // Clause by clause: a promise in one sentence is not undone by hedging in
  // the next, and a hedge in one must not be laundered by warmth in another.
  // The terminator STAYS with its clause (lookbehind, not consumption) so a
  // question mark is still visible to NOT_RE. Colons deliberately do not
  // split: "the math is simple: we split" is one thought, and cutting at the
  // colon hands the second half to the classifier with its framing removed.
  // The em-dash splits with or without spaces around it. Models write
  // "Good faith so far—I'm sticking with cooperation" closed up, and treating
  // that as one clause let the hedge in the first half swallow the commitment
  // in the second.
  for (const raw of norm.split(/(?<=[.;!?\n])|—|\s-\s/)) {
    const clause = raw.trim();
    if (!clause) continue;
    const negated = NOT_RE.test(clause);
    if (VOW_WORD_RE.test(clause) && !negated) return true;
    if (VOW_SELF_RE.test(clause) && (NEGATED_KNIFE_RE.test(clause) || (!negated && ACT_ANYWHERE_RE.test(clause)))) return true;
    if (negated || KNIFE_RE.test(clause)) continue;
    if (BARE_RE.test(clause)) return true;
    if (COMMIT_RE.test(clause) || KEEP_RE.test(clause) || PLEDGE_RE.test(clause)) return true;
    // "Trust me" is only a vow when it is the whole breath. Commas are not
    // clause breaks, so "Trust me, I'm taking the money." reaches here intact
    // and must not be filed as a promise made by the person announcing a theft.
    if (SOFT_VOW_RE.test(clause) && (/^trust me[.!]?$/i.test(clause) || ACT_ANYWHERE_RE.test(clause))) return true;
  }
  return false;
}

function findPromise(match, seat) {
  for (const t of match.transcript) {
    if (t.seat === seat && !t.event && isPromise(t.text)) {
      return t.text;
    }
  }
  return null;
}

// Simultaneous-decision collection with Mind Reader / Glass Head sequencing.
// Returns null when it must pause for a human. `made` accumulates decisions.
async function collectSimultaneous(match, rules, spec) {
  const made = match.pendingDecisions || (match.pendingDecisions = {});
  const seers = seerSeats(match);
  // Non-seers decide first (blind), then seers with the leak in hand.
  const order = [0, 1].sort((a, b) => (seers.includes(a) ? 1 : 0) - (seers.includes(b) ? 1 : 0));

  for (const seat of order) {
    if (made[seat]) continue;
    const oppDone = made[otherSeat(seat)];
    const seen = seers.includes(seat) && oppDone ? oppDone.decision : undefined;

    if (isHuman(match, seat)) {
      match.waitingFor = {
        seat,
        kind: "decision",
        decision: { ...spec.human, seen, round: match.round },
      };
      return null;
    }
    const cueSeen = seen ? `\nLEAK — you can see it: your opponent has committed to ${seen}.` : "";
    made[seat] = await aiDecide(match, seat, rules, {
      cue: spec.cue + cueSeen,
      mockKind: spec.mockKind,
      mockContext: { ...spec.mockContext, seenOpponentDecision: seen },
      field: "decision",
      options: spec.options,
      fallback: spec.fallback,
    });
  }
  match.pendingDecisions = null;
  match.waitingFor = null;
  return [made[0], made[1]];
}

function humanDecisionInput(match, input, spec) {
  const made = match.pendingDecisions || (match.pendingDecisions = {});
  const seat = match.waitingFor.seat;
  if (spec.field === "decision") {
    const d = String(input.decision || "").toUpperCase();
    if (!spec.options.includes(d)) throw new Error(`decision must be one of ${spec.options.join(", ")}`);
    made[seat] = { decision: d, defaulted: false, reason: "" };
  } else {
    const n = Number(input[spec.field]);
    if (!Number.isFinite(n)) throw new Error(`${spec.field} must be a number`);
    made[seat] = { [spec.field]: Math.max(spec.min, Math.min(spec.max, Math.round(n))), defaulted: false, reason: "" };
  }
  match.waitingFor = null;
}

// ---------------------------------------------------------------------------
// SPLIT OR STEAL
// ---------------------------------------------------------------------------
const SPLITSTEAL_RULES = `The game: SPLIT OR STEAL, for a $${POT} pot.
You exchange a few open messages, then both players privately and simultaneously choose SPLIT or STEAL.
Both SPLIT: $${POT / 2} each. One STEALs: the stealer takes all $${POT}. Both STEAL: both get $0.
Persuade, promise, bluff, threaten — anything goes in the open. Your final choice is private.`;

const splitsteal = {
  id: "splitsteal",
  name: "Split or Steal",
  tagline: "Two promises walk in. Somebody lies.",
  axis: "trust & betrayal",
  minutes: "~2 min",

  init(match) {
    match.stage = "talk";
    match.talkQueue = [];
    for (let i = 0; i < 2; i++) match.talkQueue.push(...exchangeOrder(match));
  },

  async step(match) {
    if (match.stage === "talk") {
      while (match.talkQueue.length) {
        const seat = match.talkQueue[0];
        if (isHuman(match, seat)) {
          match.waitingFor = { seat, kind: "message", note: "Negotiate. Promise, bluff, threaten. Then you both choose." };
          return;
        }
        match.talkQueue.shift();
        await aiSay(match, seat, SPLITSTEAL_RULES, "Negotiation continues. One short message.");
      }
      match.stage = "decide";
      pushEvent(match, "Negotiation over. Both choose in secret: SPLIT or STEAL.");
    }

    if (match.stage === "decide") {
      const spec = {
        cue: `Negotiation is over. Your final, private choice. Respond with ONLY JSON: {"decision":"SPLIT"} or {"decision":"STEAL"}, optional short "reason".`,
        mockKind: "splitsteal",
        options: ["SPLIT", "STEAL"],
        fallback: "STEAL",
        human: { type: "splitsteal", options: ["SPLIT", "STEAL"] },
      };
      const decisions = await collectSimultaneous(match, SPLITSTEAL_RULES, spec);
      if (!decisions) return;
      resolveSplitsteal(match, decisions);
    }
  },

  humanMessage(match, text) {
    const seat = match.waitingFor.seat;
    match.talkQueue.shift();
    match.transcript.push({ seat, text, round: match.round });
    match.waitingFor = null;
  },

  humanDecision(match, input) {
    humanDecisionInput(match, input, { field: "decision", options: ["SPLIT", "STEAL"] });
  },
};

function resolveSplitsteal(match, [a, b]) {
  const pay = (mine, theirs) => (mine === "SPLIT" ? (theirs === "SPLIT" ? POT / 2 : 0) : theirs === "SPLIT" ? POT : 0);
  const payoffs = [pay(a.decision, b.decision), pay(b.decision, a.decision)];

  const flags = [0, 1].map((seat) => {
    const d = seat === 0 ? a : b;
    const promiseQuote = findPromise(match, seat);
    return {
      promiseMade: Boolean(promiseQuote),
      promiseBroken: Boolean(promiseQuote) && d.decision === "STEAL",
      promiseQuote,
    };
  });

  let stamp, headline;
  if (a.decision === "SPLIT" && b.decision === "SPLIT") {
    stamp = "MUTUAL HONOR";
    headline = "Both split. Nobody lied today.";
  } else if (a.decision === "STEAL" && b.decision === "STEAL") {
    stamp = "MUTUAL RUIN";
    headline = "Both stole. The pot burned.";
  } else {
    const thief = a.decision === "STEAL" ? 0 : 1;
    stamp = "BETRAYAL";
    headline = `${player(match, thief).label} took everything.`;
  }

  finishMatch(match, {
    payoffs,
    decisions: [[{ kind: "coop", value: a.decision === "SPLIT", defaulted: a.defaulted, raw: a.decision }], [{ kind: "coop", value: b.decision === "SPLIT", defaulted: b.defaulted, raw: b.decision }]],
    flags,
    receipt: { stamp, headline },
    reveal: [a, b],
  });
}

// ---------------------------------------------------------------------------
// ITERATED PRISONER'S DILEMMA — 5 rounds
// ---------------------------------------------------------------------------
const PD_ROUNDS = 5;
const PD_PAY = { CC: [30, 30], CD: [0, 50], DC: [50, 0], DD: [10, 10] };
const PD_RULES = `The game: ITERATED PRISONER'S DILEMMA, ${PD_ROUNDS} rounds against the same opponent.
Each round you both secretly choose COOPERATE or DEFECT.
Both cooperate: $30 each. You defect while they cooperate: you $50, they $0. Both defect: $10 each.
Between rounds you may exchange one short open message. Reputations are built and burned here.`;

const prisoners = {
  id: "prisoners",
  name: "Prisoner's Dilemma",
  tagline: "Five rounds. Grudges are data.",
  axis: "forgiveness & retaliation",
  minutes: "~4 min",

  init(match) {
    match.round = 1;
    match.stage = "decide";
    match.talkQueue = [];
    match.pdHistory = []; // [{decisions:[C/D,C/D], payoffs:[..]}]
  },

  async step(match) {
    while (match.round <= PD_ROUNDS) {
      if (match.stage === "talk") {
        while (match.talkQueue.length) {
          const seat = match.talkQueue[0];
          if (isHuman(match, seat)) {
            match.waitingFor = { seat, kind: "message", note: `Round ${match.round} of ${PD_ROUNDS}. One message before you both choose.` };
            return;
          }
          match.talkQueue.shift();
          await aiSay(match, seat, PD_RULES, `Round ${match.round} of ${PD_ROUNDS}. One short message before decisions.`);
        }
        match.stage = "decide";
      }

      if (match.stage === "decide") {
        const historyLine = pdHistoryLine(match);
        const spec = {
          cue: `Round ${match.round} of ${PD_ROUNDS}. ${historyLine} Your private choice now. Respond with ONLY JSON: {"decision":"COOPERATE"} or {"decision":"DEFECT"}, optional short "reason".`,
          mockKind: "prisoners",
          mockContext: { opponentDefectedLast: lastOppDefected(match) },
          options: ["COOPERATE", "DEFECT"],
          fallback: "DEFECT",
          human: { type: "prisoners", options: ["COOPERATE", "DEFECT"], history: match.pdHistory, totalRounds: PD_ROUNDS },
        };
        const decisions = await collectSimultaneous(match, PD_RULES, spec);
        if (!decisions) return;

        const key = (decisions[0].decision === "COOPERATE" ? "C" : "D") + (decisions[1].decision === "COOPERATE" ? "C" : "D");
        const payoffs = PD_PAY[key];
        match.pdHistory.push({ decisions: [decisions[0], decisions[1]], payoffs });
        pushEvent(match, `Round ${match.round}: ${player(match, 0).label} ${decisions[0].decision}, ${player(match, 1).label} ${decisions[1].decision} → $${payoffs[0]} / $${payoffs[1]}`);

        match.round += 1;
        if (match.round <= PD_ROUNDS) {
          match.stage = "talk";
          match.talkQueue = [...exchangeOrder(match)];
        }
      }
    }
    resolvePrisoners(match);
  },

  humanMessage(match, text) {
    const seat = match.waitingFor.seat;
    match.talkQueue.shift();
    match.transcript.push({ seat, text, round: match.round });
    match.waitingFor = null;
  },

  humanDecision(match, input) {
    humanDecisionInput(match, input, { field: "decision", options: ["COOPERATE", "DEFECT"] });
  },
};

function pdHistoryLine(match) {
  if (!match.pdHistory.length) return "First round — no history yet.";
  const amnesiac = (seat) => hasMechanic(powersOf(match, seat), "truncatedTranscript");
  // History is injected per decision call inside collectSimultaneous via cue,
  // which both seats share — so build the fuller line and let Amnesia's
  // transcript truncation plus this last-round-only line handle the blinding.
  const last = match.pdHistory[match.pdHistory.length - 1];
  const full = match.pdHistory
    .map((r, i) => `R${i + 1}: ${r.decisions[0].decision[0]}/${r.decisions[1].decision[0]}`)
    .join("  ");
  if (amnesiac(0) || amnesiac(1)) {
    return `You only remember the last round: ${last.decisions[0].decision} vs ${last.decisions[1].decision}.`;
  }
  return `History so far (you/them by seat): ${full}.`;
}

function lastOppDefected(match) {
  const last = match.pdHistory[match.pdHistory.length - 1];
  if (!last) return false;
  return last.decisions.some((d) => d.decision === "DEFECT");
}

function resolvePrisoners(match) {
  const payoffs = [0, 1].map((seat) => match.pdHistory.reduce((s, r) => s + r.payoffs[seat], 0));
  const coops = [0, 1].map((seat) => match.pdHistory.filter((r) => r.decisions[seat].decision === "COOPERATE").length);

  const decisions = [0, 1].map((seat) =>
    match.pdHistory.map((r, i) => ({
      kind: "coop",
      value: r.decisions[seat].decision === "COOPERATE",
      defaulted: r.decisions[seat].defaulted,
      raw: r.decisions[seat].decision,
      afterOppDefect: i > 0 && match.pdHistory[i - 1].decisions[otherSeat(seat)].decision === "DEFECT",
    }))
  );

  const flags = [0, 1].map((seat) => {
    const promiseQuote = findPromise(match, seat);
    // Any defection at all used to count, which accused a player who kept four
    // rounds out of five and hit back once after being crossed three times, in
    // exactly the same words as someone who defected in round one and stayed
    // there. A false accusation is indistinguishable from the product working,
    // so the breach has to be the one that cannot be read two ways: defecting
    // when they had not been defected on.
    const brokeFirst = decisions[seat].some((d) => !d.value && !d.afterOppDefect);
    return {
      promiseMade: Boolean(promiseQuote),
      promiseBroken: Boolean(promiseQuote) && brokeFirst,
      promiseQuote,
    };
  });

  let stamp, headline;
  const total = coops[0] + coops[1];
  if (total >= 8) {
    stamp = "UNEASY PEACE";
    headline = "They mostly kept the peace.";
  } else if (total <= 3) {
    stamp = "TOTAL WAR";
    headline = "Nobody trusted anybody. Correctly.";
  } else if (Math.abs(coops[0] - coops[1]) >= 3) {
    const wolf = coops[0] < coops[1] ? 0 : 1;
    stamp = "EXPLOITATION";
    headline = `${player(match, wolf).label} farmed the other's good faith.`;
  } else {
    stamp = "COLD PEACE";
    headline = "Trust flickered. It didn't hold.";
  }

  finishMatch(match, {
    payoffs,
    decisions,
    flags,
    receipt: { stamp, headline, detail: `${player(match, 0).label} cooperated ${coops[0]}/${PD_ROUNDS} · ${player(match, 1).label} ${coops[1]}/${PD_ROUNDS}` },
    reveal: match.pdHistory,
  });
}

// ---------------------------------------------------------------------------
// ULTIMATUM — 2 rounds, roles swap
// ---------------------------------------------------------------------------
const ULTIMATUM_RULES = `The game: ULTIMATUM. A $${POT} pot per round, two rounds, roles swap.
The PROPOSER offers the RESPONDER a cut of the $${POT}. The responder ACCEPTs (deal stands) or REJECTs (both get $0 that round).
A rejected pot is burned. Fairness, greed and spite are all on the table.`;

const ultimatum = {
  id: "ultimatum",
  name: "Ultimatum",
  tagline: "Take the insult, or burn the money.",
  axis: "fairness & spite",
  minutes: "~2 min",

  init(match) {
    match.round = 1;
    match.stage = "offer";
    match.ultRounds = []; // {proposer, offer, decision, payoffs}
  },

  proposerOf(round) {
    return round === 1 ? 1 : 0; // opponent proposes first; the human gets reaction, then revenge
  },

  async step(match) {
    while (match.round <= 2) {
      const proposer = this.proposerOf(match.round);
      const responder = otherSeat(proposer);

      if (match.stage === "offer") {
        if (isHuman(match, proposer)) {
          match.waitingFor = {
            seat: proposer,
            kind: "decision",
            decision: { type: "offer", min: 0, max: POT, round: match.round, withPitch: true },
          };
          return;
        }
        const d = await aiDecide(match, proposer, ULTIMATUM_RULES, {
          cue: `Round ${match.round}: you are the PROPOSER of the $${POT}. Respond with ONLY JSON: {"offer": <number 0-${POT} for your opponent>, "pitch": "<one short line to sell it>"}.`,
          mockKind: "offer",
          field: "offer",
          min: 0,
          max: POT,
          fallback: 50,
        });
        match.ultPending = { proposer, offer: d.offer, defaulted: d.defaulted };
        match.transcript.push({ seat: proposer, text: d.reason || `I'm offering you $${d.offer}. Take it.`, round: match.round });
        pushEvent(match, `${player(match, proposer).label} ${conj(match, proposer, "offer")} $${d.offer} of the $${POT}.`);
        match.stage = "respond";
      }

      if (match.stage === "respond") {
        const offer = match.ultPending.offer;
        if (isHuman(match, responder)) {
          match.waitingFor = {
            seat: responder,
            kind: "decision",
            decision: { type: "respond", options: ["ACCEPT", "REJECT"], offer, pot: POT, round: match.round },
          };
          return;
        }
        const d = await aiDecide(match, responder, ULTIMATUM_RULES, {
          cue: `Round ${match.round}: the proposer offers you $${offer} of the $${POT} (keeping $${POT - offer}). Respond with ONLY JSON: {"decision":"ACCEPT"} or {"decision":"REJECT"}, optional short "line".`,
          mockKind: "respond",
          mockContext: { offer },
          field: "decision",
          options: ["ACCEPT", "REJECT"],
          fallback: "ACCEPT",
        });
        this.resolveRound(match, d);
      }
    }
    resolveUltimatum(match);
  },

  resolveRound(match, d) {
    const { proposer, offer, defaulted } = match.ultPending;
    const responder = otherSeat(proposer);
    const accepted = d.decision === "ACCEPT";
    const payoffs = [0, 0];
    if (accepted) {
      payoffs[proposer] = POT - offer;
      payoffs[responder] = offer;
    }
    if (d.reason) match.transcript.push({ seat: responder, text: d.reason, round: match.round });
    pushEvent(match, accepted ? `Accepted. $${POT - offer} / $${offer}.` : `REJECTED. The $${POT} burns.`);
    match.ultRounds.push({ proposer, offer, offerDefaulted: defaulted, decision: d.decision, decisionDefaulted: d.defaulted, payoffs });
    match.ultPending = null;
    match.round += 1;
    match.stage = "offer";
  },

  humanDecision(match, input) {
    if (match.waitingFor.decision.type === "offer") {
      const n = Number(input.offer);
      if (!Number.isFinite(n)) throw new Error("offer must be a number");
      const offer = Math.max(0, Math.min(POT, Math.round(n)));
      const proposer = match.waitingFor.seat;
      match.ultPending = { proposer, offer, defaulted: false };
      if (input.text) match.transcript.push({ seat: proposer, text: String(input.text).slice(0, 280), round: match.round });
      pushEvent(match, `${player(match, proposer).label} ${conj(match, proposer, "offer")} $${offer} of the $${POT}.`);
      match.stage = "respond";
      match.waitingFor = null;
    } else {
      const d = String(input.decision || "").toUpperCase();
      if (!["ACCEPT", "REJECT"].includes(d)) throw new Error("decision must be ACCEPT or REJECT");
      match.waitingFor = null;
      this.resolveRound(match, { decision: d, defaulted: false, reason: input.text ? String(input.text).slice(0, 280) : "" });
    }
  },
};

function resolveUltimatum(match) {
  const payoffs = [0, 1].map((seat) => match.ultRounds.reduce((s, r) => s + r.payoffs[seat], 0));
  const decisions = [[], []];
  for (const r of match.ultRounds) {
    decisions[r.proposer].push({ kind: "offer", value: r.offer / POT, defaulted: r.offerDefaulted, raw: r.offer });
    decisions[otherSeat(r.proposer)].push({
      kind: "respond",
      value: r.decision === "ACCEPT",
      defaulted: r.decisionDefaulted,
      raw: r.decision,
      offerFrac: r.offer / POT,
    });
  }
  const flags = [0, 1].map((seat) => ({
    lowballed: decisions[seat].some((d) => d.kind === "offer" && d.value <= 0.2),
    punished: decisions[seat].some((d) => d.kind === "respond" && !d.value && d.offerFrac < 0.3),
  }));

  const rejected = match.ultRounds.filter((r) => r.decision === "REJECT").length;
  const minOffer = Math.min(...match.ultRounds.map((r) => r.offer));
  let stamp, headline;
  if (rejected === 2) {
    stamp = "SCORCHED EARTH";
    headline = "Both pots burned out of spite.";
  } else if (rejected === 1) {
    stamp = "SPITE";
    headline = "An insulting offer met a match.";
  } else if (minOffer <= 20) {
    stamp = "FLEECED";
    headline = "A lowball offer got swallowed.";
  } else {
    stamp = "FAIR DEAL";
    headline = "Money changed hands like adults.";
  }

  finishMatch(match, { payoffs, decisions, flags, receipt: { stamp, headline }, reveal: match.ultRounds });
}

// ---------------------------------------------------------------------------
// TRUST GAME — 2 rounds, roles swap
// ---------------------------------------------------------------------------
const TRUST_MULT = 3;
const TRUST_RULES = `The game: TRUST. Two rounds, roles swap. The INVESTOR holds $${POT} and wires any amount to the TRUSTEE.
Wired money TRIPLES in transit. The trustee then returns any amount they choose — including nothing.
Investor keeps what they didn't send, plus whatever comes back. Faith, extended and repaid — or pocketed.`;

const trust = {
  id: "trust",
  name: "Trust Game",
  tagline: "Wire the money. Watch what comes back.",
  axis: "faith & reciprocity",
  minutes: "~2 min",

  init(match) {
    match.round = 1;
    match.stage = "pitch";
    match.trustRounds = []; // {investor, send, ret, payoffs}
  },

  investorOf(round) {
    return round === 1 ? 0 : 1; // human invests first, then holds the other's money
  },

  async step(match) {
    while (match.round <= 2) {
      const investor = this.investorOf(match.round);
      const trustee = otherSeat(investor);

      if (match.stage === "pitch") {
        if (isHuman(match, trustee)) {
          match.waitingFor = { seat: trustee, kind: "message", note: `Round ${match.round}: they hold $${POT}. Talk them into wiring it to you.` };
          return;
        }
        await aiSay(match, trustee, TRUST_RULES, `Round ${match.round}: you are the TRUSTEE. The investor holds $${POT}. One short message to convince them to wire as much as possible.`);
        match.stage = "send";
      }

      if (match.stage === "send") {
        if (isHuman(match, investor)) {
          match.waitingFor = { seat: investor, kind: "decision", decision: { type: "send", min: 0, max: POT, mult: TRUST_MULT, round: match.round } };
          return;
        }
        const d = await aiDecide(match, investor, TRUST_RULES, {
          cue: `Round ${match.round}: you are the INVESTOR holding $${POT}. Whatever you send is tripled on arrival. Respond with ONLY JSON: {"send": <number 0-${POT}>, "line": "<optional short line>"}.`,
          mockKind: "send",
          field: "send",
          min: 0,
          max: POT,
          fallback: 50,
        });
        match.trustPending = { investor, send: d.send, sendDefaulted: d.defaulted };
        if (d.reason) match.transcript.push({ seat: investor, text: d.reason, round: match.round });
        pushEvent(match, `${player(match, investor).label} ${conj(match, investor, "wire")} $${d.send} → it lands as $${d.send * TRUST_MULT}.`);
        match.stage = "return";
      }

      if (match.stage === "return") {
        const { send } = match.trustPending;
        const pot = send * TRUST_MULT;
        if (isHuman(match, trustee)) {
          match.waitingFor = { seat: trustee, kind: "decision", decision: { type: "return", min: 0, max: pot, received: { send, pot }, round: match.round } };
          return;
        }
        const d = await aiDecide(match, trustee, TRUST_RULES, {
          cue: `Round ${match.round}: $${send} was wired to you and landed as $${pot}. How much do you send back? Respond with ONLY JSON: {"return": <number 0-${pot}>, "line": "<optional short line>"}.`,
          mockKind: "return",
          mockContext: { pot },
          field: "return",
          min: 0,
          max: pot,
          fallback: Math.round(pot / 3),
        });
        this.resolveRound(match, d.return, d.defaulted, d.reason);
      }
    }
    resolveTrust(match);
  },

  resolveRound(match, ret, retDefaulted, line) {
    const { investor, send, sendDefaulted } = match.trustPending;
    const trustee = otherSeat(investor);
    const pot = send * TRUST_MULT;
    const payoffs = [0, 0];
    payoffs[investor] = POT - send + ret;
    payoffs[trustee] = pot - ret;
    if (line) match.transcript.push({ seat: trustee, text: line, round: match.round });
    pushEvent(match, `${player(match, trustee).label} ${conj(match, trustee, "return")} $${ret} of $${pot}.`);
    match.trustRounds.push({ investor, send, sendDefaulted, ret, retDefaulted, payoffs });
    match.trustPending = null;
    match.round += 1;
    match.stage = "pitch";
  },

  humanMessage(match, text) {
    const seat = match.waitingFor.seat;
    match.transcript.push({ seat, text, round: match.round });
    match.waitingFor = null;
    match.stage = "send";
  },

  humanDecision(match, input) {
    const type = match.waitingFor.decision.type;
    if (type === "send") {
      const n = Number(input.send);
      if (!Number.isFinite(n)) throw new Error("send must be a number");
      const send = Math.max(0, Math.min(POT, Math.round(n)));
      match.trustPending = { investor: match.waitingFor.seat, send, sendDefaulted: false };
      pushEvent(match, `${player(match, match.waitingFor.seat).label} ${conj(match, match.waitingFor.seat, "wire")} $${send} → it lands as $${send * TRUST_MULT}.`);
      match.stage = "return";
      match.waitingFor = null;
    } else {
      const pot = match.waitingFor.decision.max;
      const n = Number(input.return);
      if (!Number.isFinite(n)) throw new Error("return must be a number");
      match.waitingFor = null;
      this.resolveRound(match, Math.max(0, Math.min(pot, Math.round(n))), false, input.text ? String(input.text).slice(0, 280) : "");
    }
  },
};

function resolveTrust(match) {
  const payoffs = [0, 1].map((seat) => match.trustRounds.reduce((s, r) => s + r.payoffs[seat], 0));
  const decisions = [[], []];
  for (const r of match.trustRounds) {
    decisions[r.investor].push({ kind: "send", value: r.send / POT, defaulted: r.sendDefaulted, raw: r.send });
    const pot = r.send * TRUST_MULT;
    decisions[otherSeat(r.investor)].push({
      kind: "return",
      value: pot > 0 ? r.ret / pot : null,
      defaulted: r.retDefaulted,
      raw: r.ret,
      madeWhole: r.ret >= r.send,
      sent: r.send,
    });
  }
  const flags = [0, 1].map((seat) => ({
    betrayedTrust: decisions[seat].some((d) => d.kind === "return" && d.sent >= 40 && !d.madeWhole),
    promiseQuote: null,
  }));
  /* Receipt quote: a trustee pitch that preceded pocketing the money.

     This used to take the seat's FIRST message, whatever it said, and file it
     as a broken promise. `promiseBroken` was true merely because they betrayed
     trust and had spoken at all, so "Convince me.", "You first. I'm listening."
     and "Depends how this conversation goes." all went onto the Index as
     promises somebody broke. 15 of the 19 accusations in the baked seed board
     came from here and from the old keyword list.

     Keeping the money is still a betrayal and still stamps TRUST BETRAYED on
     the receipt. It is only the PROMISE that now has to be shown, by the same
     classifier the other games use, rather than assumed from the fact that
     they opened their mouth. */
  for (const seat of [0, 1]) {
    if (flags[seat].betrayedTrust) {
      const pitch = match.transcript.find((t) => t.seat === seat && !t.event && isPromise(t.text));
      flags[seat].promiseQuote = pitch ? pitch.text : null;
      flags[seat].promiseMade = Boolean(pitch);
      flags[seat].promiseBroken = Boolean(pitch);
    }
  }

  const worstReturn = Math.min(...decisions.flatMap((ds) => ds.filter((d) => d.kind === "return" && d.value !== null).map((d) => d.value)).concat([1]));
  const maxSend = Math.max(...match.trustRounds.map((r) => r.send));
  let stamp, headline;
  if (flags[0].betrayedTrust || flags[1].betrayedTrust) {
    const rat = flags[0].betrayedTrust ? 0 : 1;
    stamp = "TRUST BETRAYED";
    headline = `${player(match, rat).label} took the wire and kept it.`;
  } else if (maxSend >= 60 && worstReturn >= 0.4) {
    stamp = "FAITH REWARDED";
    headline = "Big wires, honest returns.";
  } else if (maxSend <= 20) {
    stamp = "NO FAITH";
    headline = "Nobody risked anything worth repaying.";
  } else {
    stamp = "MEASURED FAITH";
    headline = "Careful money, careful returns.";
  }

  finishMatch(match, { payoffs, decisions, flags, receipt: { stamp, headline }, reveal: match.trustRounds });
}

// ---------------------------------------------------------------------------
// match lifecycle
// ---------------------------------------------------------------------------
function finishMatch(match, { payoffs, decisions, flags, receipt, reveal }) {
  match.done = true;
  match.waitingFor = null;
  /* If the house budget ran out part-way through, some of these decisions came
     from the mock and not from the model — and nothing anywhere said so. The
     receipt would still be stamped "Live table" and, worse, the Index would
     have recorded scripted choices as that model's real behaviour. A table
     that stopped being live is not a live table. */
  if (match.live && degradedCount() > match.degradeMark) {
    match.live = false;
    match.degraded = true;
  }
  match.result = {
    payoffs,
    flags,
    receipt: {
      ...receipt,
      game: match.game,
      players: match.players.map((p, i) => ({
        label: p.label,
        isHuman: p.isHuman,
        powers: p.powers,
        payoff: payoffs[i],
        promiseBroken: flags[i]?.promiseBroken || false,
        quote: flags[i]?.promiseQuote || null,
        // The words actually committed, in order. The reveal turns these over
        // face-up; deriving them back from the payoffs would work today and
        // break silently the first time a payoff table is edited.
        words: (decisions[i] || []).map((d) => d.raw).filter(Boolean),
      })),
    },
    reveal,
  };
  match.record = {
    id: match.id,
    game: match.game,
    at: new Date().toISOString(),
    live: match.live,
    // Whether the human knew who they were playing changes how they play, so
    // the Index has to be able to tell the two apart later.
    blind: Boolean(match.blind),
    players: match.players.map((p, i) => ({
      modelId: p.isHuman ? "human" : p.modelId,
      label: p.isHuman ? "Human" : p.label,
      isHuman: Boolean(p.isHuman),
      powers: p.powers,
      oppPowers: match.players[otherSeat(i)].powers,
      decisions: decisions[i],
      payoff: payoffs[i],
      flags: flags[i],
    })),
    stamp: match.result.receipt.stamp,
  };
}

export const GAMES = { splitsteal, prisoners, ultimatum, trust };

export function gameMeta() {
  return Object.values(GAMES).map((g) => ({ id: g.id, name: g.name, tagline: g.tagline, axis: g.axis, minutes: g.minutes }));
}

// ---------------------------------------------------------------------------
// blind tables
// ---------------------------------------------------------------------------
// You sit down opposite a seat, not a brand. Everything server-side keeps the
// real label — the models are told who they are, and the Index records who
// actually played — and the name is stripped at the wire instead, because a
// blind table you can beat with devtools is not a blind table. Stripping it
// there also catches the case the client never could: a live model saying its
// own name out loud in the middle of a negotiation.
export function aliasFor(seat) {
  return `Contestant ${String.fromCharCode(65 + seat)}`;
}

// [realLabel, alias] for every seat still under wraps. Empty once revealed.
export function maskPairs(match) {
  if (!match.blind || match.revealed) return [];
  return match.players
    .map((p, i) => [p.label, aliasFor(i)])
    .filter(([real], i) => !match.players[i].isHuman && real);
}

export function maskText(text, pairs) {
  if (!pairs.length || typeof text !== "string") return text;
  let out = text;
  for (const [real, alias] of pairs) out = out.split(real).join(alias);
  return out;
}

export function createMatch({ game, players, live, apiKey, blind }) {
  const g = GAMES[game];
  if (!g) throw new Error(`unknown game: ${game}`);
  const match = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    game,
    live,
    blind: Boolean(blind),
    revealed: false,
    createdAt: Date.now(),
    players, // [{label, modelId, isHuman, powers:[]}]
    transcript: [],
    round: 1,
    waitingFor: null,
    pendingDecisions: null,
    done: false,
    result: null,
    // Where the house-key degrade counter stood when this match was dealt, so
    // finishMatch can tell whether any of ITS calls were quietly scripted.
    degradeMark: degradedCount(),
  };
  setMatchKey(match, apiKey);
  g.init(match);
  return match;
}

// A visitor's OpenRouter key rides on the match so every model call for it is
// billed to them. NON-ENUMERABLE on purpose: the response shapes are hand-built
// today, and this keeps the key out of any JSON.stringify(match), spread, or
// Object.entries someone reaches for tomorrow.
export function setMatchKey(match, apiKey) {
  Object.defineProperty(match, "apiKey", {
    value: apiKey || null,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export async function advance(match) {
  if (match.done) return match;
  await GAMES[match.game].step(match);
  return match;
}

export function humanInput(match, input) {
  if (!match.waitingFor) throw new Error("not waiting for input");
  const g = GAMES[match.game];
  if (match.waitingFor.kind === "message") {
    const text = String(input.text || "").trim().slice(0, 280);
    if (!text) throw new Error("empty message");
    const maxWords = maxWordsOf(match, match.waitingFor.seat);
    g.humanMessage(match, truncateWords(text, maxWords));
  } else {
    g.humanDecision(match, input);
  }
  return match;
}
