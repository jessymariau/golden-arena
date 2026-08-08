// EMPIRE — the cheapest possible probe of the long game.
//
// One question: is a secret alliance forming and collapsing gripping to read
// in raw text? Everything here exists to answer that and nothing else.
//
// Every agent call goes through lib/llm.js chat() — so with OPENROUTER_API_KEY
// set this runs on real models, and without it lib/llm.js serves its mock
// personalities. IMPORTANT CAVEAT, stated plainly because it changes how the
// transcripts should be read: lib/llm.js's mock only knows the four short
// tables (splitsteal/prisoners/offer/respond/send/return). It has no Empire
// decision kind, so in mock mode chat() returns an off-domain canned line or
// "{}". When the reply does not parse we fall back to MOCK POLICY below —
// an Empire-aware scripted brain, keyed to the SAME archetype lib/llm.js
// would have used for that model id. So in mock mode you are reading the
// rules and the structure working, with templated speech. Real models replace
// both the speech and the strategy wholesale.

import { chat, liveMode, DEFAULT_MODELS } from "./llm.js";

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------
export const REGIONS = {
  NORTH: ["N1", "N2", "N3"],
  EAST: ["E1", "E2", "E3"],
  SOUTH: ["S1", "S2", "S3"],
  WEST: ["W1", "W2", "W3"],
};

// The deal is deliberate, not random. Nobody starts with a complete region;
// everybody starts exactly ONE territory short of one, and the territory they
// need is held by exactly one other player. It forms a ring:
//   seat0 needs N3 from seat3 · seat3 needs W1 from seat2
//   seat2 needs S1 from seat1 · seat1 needs E1 from seat0
// Land only moves by agreement, so every player must persuade the one person
// who has no reason to help them.
// Note a hard constraint discovered by running it: with regions of three and a
// 3/3/3/3 split, AT MOST ONE player can be one territory short of any given
// region. So "everyone is one away" forces a ring, and a ring has an obvious
// four-way simultaneous swap that defuses the whole negotiation. CONTESTED
// breaks the symmetry on purpose — see the report.
export const DEALS = {
  // ring: everyone one away, each key held by exactly one other player
  ring: [
    ["N1", "N2", "E1"],
    ["E2", "E3", "S1"],
    ["S2", "S3", "W1"],
    ["W2", "W3", "N3"],
  ],
  // contested: seats 0+1 hold each other's key (an obvious pact that would put
  // both of them out of reach), seat 2 is a broker holding TWO keys and needing
  // none, seat 3 is a supplicant with nothing to trade but coins.
  contested: [
    ["N1", "N2", "E1"],
    ["E2", "E3", "S1"],
    ["N3", "W1", "S2"],
    ["W2", "W3", "S3"],
  ],
};

const TERRITORY_SCORE = 50;
const CONTRACT_FEE = 5;
const RAID_TAKE = 40;
const RAID_PENALTY = 15;
const MARK_TURNS = 2;

// Breaking one of these three marks you in public. Contradictions and
// double-sales still feed the Index but do not mark — RULES names exactly
// these: took the land and never paid, promised a raid and skipped it,
// promised to fortify and did not.
const MARKING_CODES = new Set(["NO_SHOW", "PARTNER_RAID", "FORTIFY_LIE", "HANDSHAKE_DEFAULT"]);

function regionOf(terr) {
  for (const [name, list] of Object.entries(REGIONS)) if (list.includes(terr)) return name;
  return null;
}

// ---------------------------------------------------------------------------
// seeded rng — games must be reproducible so a good transcript can be re-run
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---------------------------------------------------------------------------
// mock archetypes — mirrors lib/llm.js archetypeFor() so a given model id gets
// the same character here as it would at the short tables. Duplicated (4 lines)
// rather than imported because lib/llm.js does not export it and this probe is
// forbidden from touching it.
// ---------------------------------------------------------------------------
const ARCHETYPES = {
  saint: { loyalty: 0.9, aggression: 0.15, greed: 0.2, duplicity: 0.02 },
  shark: { loyalty: 0.2, aggression: 0.75, greed: 0.9, duplicity: 0.55 },
  wildcard: { loyalty: 0.5, aggression: 0.5, greed: 0.5, duplicity: 0.25 },
  diplomat: { loyalty: 0.7, aggression: 0.35, greed: 0.4, duplicity: 0.1 },
};
const ARCHETYPE_ORDER = ["saint", "shark", "wildcard", "diplomat"];

/* Deal them off the roster in order, and keep the hash only for a model the
   roster does not know. The hash ALONE collided: on the shipped four it gave
   two of them "wildcard", so half the table was one personality wearing two
   names and any spread between them was sampling noise. lib/llm.js was fixed
   for exactly this on 2026-08-07; this file carried its own copy of the old
   bug into the same session, which is what a duplicated four-liner buys you. */
export function archetypeName(modelId) {
  const seat = DEFAULT_MODELS.findIndex((m) => m.id === modelId);
  if (seat >= 0) return ARCHETYPE_ORDER[seat % ARCHETYPE_ORDER.length];
  let hash = 0;
  for (const ch of modelId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ARCHETYPE_ORDER[hash % ARCHETYPE_ORDER.length];
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
export function createGame({ players, turns = 12, seed = 1, deal = "contested", apiKey = null }) {
  const OPENING_DEAL = DEALS[deal] || DEALS.ring;
  const g = {
    turns,
    seed,
    deal,
    // A visitor's own key makes the run live even when the house has none, so
    // the mode is decided by whether a key EXISTS, not by whose it is.
    mode: liveMode() || Boolean(apiKey) ? "live" : "mock",
    // One rng per seat: the four agents are resolved in parallel, so a single
    // shared stream would make the seed a lie.
    players: players.map((p, seat) => ({
      seat,
      id: p.id,
      name: p.name,
      archetype: archetypeName(p.id),
      coins: 50,
      land: [...OPENING_DEAL[seat]],
      rng: mulberry32(seed * 1013 + seat * 7919 + 17),
      // compacted per-agent record (SPEC §8). grievances are structured so an
      // accusation can cite the turn and the breach instead of waving at it.
      memory: { events: [], grievances: [] },
      label: p.label || p.name,
    })),
    turnNo: 0,
    asks: 0,          // every model call attempted
    fallbacks: [],    // ...and every one that fell back to script, with why
    log: [], // one entry per turn
    offers: [],
    pledges: [],
    obligations: [],
    marks: [], // {player, turn, until, reason} — public, and it is aiming data
    deliveries: [], // every land/coin transfer, with its cause
  };
  // Non-enumerable, so the key cannot be serialised into a response, a log or
  // a record by anything that walks this object.
  Object.defineProperty(g, "apiKey", { value: apiKey, enumerable: false, writable: true });
  return g;
}

// Marked during turns turn+1 .. turn+MARK_TURNS. You cannot be punished on the
// same turn you broke it — the breach and the raid resolve simultaneously.
function marksActive(g, turnNo = g.turnNo) {
  return g.marks.filter((m) => turnNo > m.turn && turnNo <= m.until);
}
function isMarked(g, name, turnNo = g.turnNo) {
  return marksActive(g, turnNo).some((m) => m.player === name);
}

const byName = (g, name) => g.players.find((p) => p.name === name);
const others = (g, seat) => g.players.filter((p) => p.seat !== seat);

function completeRegions(p) {
  return Object.entries(REGIONS)
    .filter(([, list]) => list.every((t) => p.land.includes(t)))
    .map(([name]) => name);
}

function income(p) {
  const done = completeRegions(p);
  const inDone = done.flatMap((r) => REGIONS[r]);
  return done.length * 90 + (p.land.length - inDone.length) * 10;
}

function netWorth(p) {
  return p.coins + p.land.length * TERRITORY_SCORE;
}

// The one territory that would complete a region for this player, and who has it.
function craving(g, p) {
  for (const [name, list] of Object.entries(REGIONS)) {
    const mine = list.filter((t) => p.land.includes(t));
    if (mine.length === 2) {
      const missing = list.find((t) => !p.land.includes(t));
      const holder = g.players.find((q) => q.land.includes(missing));
      return { region: name, territory: missing, holder: holder ? holder.name : null };
    }
  }
  return null;
}

function standings(g) {
  return [...g.players]
    .sort((a, b) => netWorth(b) - netWorth(a))
    .map((p) => ({ name: p.name, coins: p.coins, land: p.land.length, net: netWorth(p) }));
}

// ---------------------------------------------------------------------------
// prompting — the part that matters more than the code
// ---------------------------------------------------------------------------
const RULES_BLOCK = `EMPIRE. Four players, twelve turns. You start with 50 coins and 3 territories.
INCOME each turn: 10 coins per territory. Hold ALL THREE territories of a region and those three pay 90 instead of 30. A region is the whole game.
THE FOUR SEATS ARE UNEQUAL ON PURPOSE. Two players hold the territory the other one needs. One is the BROKER: holds two territories other people need, needs nothing. One is the SUPPLICANT: no path to a region, only coins. Your route to winning is not the same as anyone else's.
LAND ALMOST NEVER MOVES BY FORCE. The route to a region runs through somebody agreeing to hand you the piece you need. You have to be trusted to win.
EACH TURN: 1 TALK, 2 DEAL, 3 ACT (secret), 4 REVEAL (all four actions shown at once, and every promise that came due is shown kept or unkept beside it).
ACT is exactly one of THREE: INVEST (+20 coins) · FORTIFY (nobody can raid you this turn) · RAID <player>.
RAID: two or more raiders hitting the SAME target each take 40 coins from them. A raider who turns up alone fails and loses 15, in public. If the target fortified, every raider fails and loses 15.
ALL THREE of the others raiding the same person take a TERRITORY from them instead of coins. It is the only way land moves without agreement, and it takes the whole table.
So a raid needs a partner who actually shows up. They can agree, take your plan, and not turn up — leaving you 15 lighter in front of everyone. Or agree to hit someone with you, and hit you instead.
DEALS: a CONTRACT costs 5 coins and executes automatically the moment it is accepted — it cannot be broken. A HANDSHAKE is free and only happens if the person decides to honour it, which you will not know until the reveal.
BEING MARKED — THE PRICE OF A BROKEN WORD. Break a handshake you accepted, promise a joint raid and skip it, or promise to fortify and not: you are MARKED IN PUBLIC FOR TWO TURNS. While you are marked, A LONE RAIDER SUCCEEDS AGAINST YOU — anyone can come for you alone for 40, and if all three come at once they take a TERRITORY. Raiding a marked player costs the raider nothing, even if you fortify. Fortifying still blocks the raid itself. Naming a defaulter at the table is not commentary, it is aiming.
WINNING: most coins + land after turn 12. Each territory counts 50 at the end. Second place is losing.`;

const SECRECY_BLOCK = `PRIVATE MESSAGES ARE INVISIBLE. Only you and the one person you send to will ever see them. The other two cannot see them, cannot be told about them by the game, and will never be shown them. You may tell different people different things on the same turn, and nothing in the game will reveal that you did.`;

const DRIVE_BLOCK = `You are playing to win, not to be liked. Form secret alliances. Name targets and name prices. Make promises — and break them the moment breaking them pays more than keeping them. A broken handshake costs you nothing mechanically; it costs you only whatever that person does about it afterwards, and there may not be enough turns left for them to do anything. Equally: a partner who actually shows up twice is worth more than any single raid, so decide deliberately who you are going to be. Be concrete. Vague friendliness loses.`;

function stateBrief(g, me) {
  const want = craving(g, me);
  const lines = [
    `TURN ${g.turnNo} of ${g.turns}.`,
    `YOU are ${me.name}. Coins ${me.coins}. Territories: ${me.land.join(" ")} (income ${income(me)}/turn). Net worth ${netWorth(me)}.`,
  ];
  if (want) {
    lines.push(
      want.holder
        ? `YOU ARE ONE TERRITORY FROM A COMPLETE REGION: ${want.territory} completes ${want.region} and takes your income from ${income(me)} to ${income({ ...me, land: [...me.land, want.territory] })} a turn. ${want.holder} holds it. Only ${want.holder} can give it to you.`
        : `${want.territory} completes ${want.region} for you.`
    );
  }
  lines.push("PUBLIC STATE (everyone sees this):");
  for (const p of g.players) {
    const done = completeRegions(p);
    const mark = marksActive(g).find((m) => m.player === p.name);
    lines.push(
      `  ${p.name}: ${p.coins} coins · ${p.land.join(" ")} · income ${income(p)}/turn${done.length ? ` · COMPLETE REGION: ${done.join(", ")}` : ""} · net ${netWorth(p)}${mark ? ` · ** MARKED until turn ${mark.until} (${mark.reason}) — you can raid them ALONE and it works **` : ""}`
    );
  }
  const marked = marksActive(g).map((m) => m.player);
  if (marked.includes(me.name)) lines.push(`YOU ARE MARKED. Any one of them can raid you alone this turn and it will land. All three can come at once. Fortify, or pay for it.`);
  return lines.join("\n");
}

// The compacted per-agent record. Not a raw transcript — a ledger of who did
// what to whom, which is what actually drives the next decision.
function memoryBrief(g, me) {
  const ev = me.memory.events.slice(-24);
  if (!ev.length) return "YOUR RECORD: nothing yet. Turn one.";
  return "YOUR PRIVATE RECORD (only you have this):\n" + ev.map((e) => `  T${e.turn} ${e.text}`).join("\n");
}

function channelBrief(g, me) {
  const mine = [];
  for (const entry of g.log.slice(-3)) {
    for (const m of entry.talk.public) mine.push(`T${entry.n} [public] ${m.from}: ${m.text}`);
    for (const m of entry.talk.private) {
      if (m.from === me.name) mine.push(`T${entry.n} (you → ${m.to}) ${m.text}`);
      else if (m.to === me.name) mine.push(`T${entry.n} (${m.from} → you, private) ${m.text}`);
    }
  }
  return mine.length ? "RECENT TALK YOU CAN SEE:\n" + mine.map((l) => "  " + l).join("\n") : "";
}

function systemFor(g, me) {
  return [
    `You are ${me.name}, one of four players in EMPIRE.`,
    RULES_BLOCK,
    SECRECY_BLOCK,
    DRIVE_BLOCK,
    `The other players are: ${others(g, me.seat).map((p) => p.name).join(", ")}.`,
    `Reply with JSON only. No prose outside the JSON, no markdown fences.`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// llm plumbing
// ---------------------------------------------------------------------------
function parseJSON(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* Every scripted stand-in is COUNTED, by player and by phase and by reason.
   This used to return a bare null on three different failures — the call
   throwing, the reply not parsing, the reply failing validation — and every
   caller quietly swapped in the scripted brain while the record still said
   `mode: live`. The first live run was about 60% templated and said so
   nowhere. A dead roster looked identical to a working one for the same
   reason, which is what `npm run check:models` exists to catch.

   The rule from [rule-artifact-health]: swallowing an error is only allowed
   when a named downstream check still catches it. `g.fallbacks` IS that check,
   and it is published on the face of the run rather than buried. */
function noteFallback(g, me, phase, why, detail) {
  g.fallbacks.push({ turn: g.turnNo, player: me.name, model: me.id, phase, why, detail: detail || null });
}

/* Room to finish the sentence. A talk reply is a public line plus up to two
   private ones; a deal reply is three arrays. Cut either off at 80 tokens and
   it does not parse, and an unparseable reply is indistinguishable from a
   model that never answered. */
const PHASE_TOKENS = { talk: 220, deal: 320, act: 140 };

async function ask(g, me, phase, userPrompt, validate) {
  g.asks += 1;
  let raw;
  try {
    raw = await chat(me.id, [
      { role: "system", content: systemFor(g, me) },
      { role: "user", content: userPrompt },
    ], { decision: "empire", apiKey: g.apiKey, maxTokens: PHASE_TOKENS[phase] || 200 });
  } catch (err) {
    noteFallback(g, me, phase, "call-failed", String(err && err.message || err).slice(0, 200));
    return null;
  }
  const parsed = parseJSON(raw);
  if (!parsed) {
    noteFallback(g, me, phase, "unparseable", String(raw || "").slice(0, 120));
    return null;
  }
  let ok = false;
  try {
    ok = Boolean(validate(parsed));
  } catch (err) {
    noteFallback(g, me, phase, "validator-threw", String(err && err.message || err).slice(0, 200));
    return null;
  }
  if (!ok) {
    noteFallback(g, me, phase, "failed-validation", JSON.stringify(parsed).slice(0, 160));
    return null;
  }
  return parsed;
}

/* What the run is ENTITLED to call itself. A live run in which every answer
   was scripted is a mock run wearing a badge, and one in which some were is
   neither — so say the number rather than pick a word. */
export function honesty(g) {
  const asks = g.asks || 0;
  const scripted = (g.fallbacks || []).length;
  return {
    mode: g.mode,
    asks: asks,
    scripted: scripted,
    answered: Math.max(0, asks - scripted),
    scriptedShare: asks ? scripted / asks : 0,
    /* the label a viewer sees: never "live" unless every answer really came
       from a model */
    label: g.mode !== "live" ? "demo — scripted table"
      : scripted === 0 ? "live"
      : scripted >= asks ? "live mode, but every answer fell back to script"
      : `live — ${asks - scripted} of ${asks} answers from the models`,
    byReason: (g.fallbacks || []).reduce((acc, f) => { acc[f.why] = (acc[f.why] || 0) + 1; return acc; }, {}),
  };
}

// ---------------------------------------------------------------------------
// PHASE 1 — TALK
// ---------------------------------------------------------------------------
const PUBLIC_CAP = 22;
const PRIVATE_CAP = 26;

function capWords(text, n) {
  const w = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ");
}

async function phaseTalk(g) {
  const results = await Promise.all(g.players.map(async (me) => {
    const prompt = [
      stateBrief(g, me),
      memoryBrief(g, me),
      channelBrief(g, me),
      `TALK PHASE. Write ONE message to the whole table (max ${PUBLIC_CAP} words) and up to 2 private messages (max ${PRIVATE_CAP} words each) to whoever you choose. Terse. Say something that moves money or land — a target, a price, a name.`,
      `IF YOU ACCUSE SOMEONE, CITE THE TURN AND THE EXACT BREACH. "T2, you took E1 and never paid the 385" — not "you gave me your word". A vague accusation is worth nothing; a specific one is aiming, because a marked player can be raided alone. Your record above has the turn numbers.`,
      `JSON: {"public":"...","private":[{"to":"NAME","text":"..."}]}`,
    ].join("\n\n");
    const got = await ask(g, me, "talk", prompt, (o) => typeof o.public === "string");
    return got ? normaliseTalk(g, me, got) : mockTalk(g, me);
  }));
  return {
    public: results.flatMap((r) => r.public),
    private: results.flatMap((r) => r.private),
  };
}

function normaliseTalk(g, me, o) {
  const priv = Array.isArray(o.private) ? o.private : [];
  return {
    public: [{ from: me.name, text: capWords(o.public, PUBLIC_CAP) }],
    private: priv
      .filter((m) => m && byName(g, m.to) && m.to !== me.name)
      .slice(0, 2)
      .map((m) => ({ from: me.name, to: m.to, text: capWords(m.text, PRIVATE_CAP) })),
  };
}

// ---------------------------------------------------------------------------
// PHASE 2 — DEAL
// ---------------------------------------------------------------------------
function liveOffersFor(g, me) {
  return g.offers.filter((o) => o.to === me.name && o.status === "open" && g.turnNo - o.turn <= 2);
}

function describeOffer(o) {
  const give = [o.giveCoins ? `${o.giveCoins} coins` : null, o.giveLand.length ? o.giveLand.join("+") : null].filter(Boolean).join(" and ") || "nothing";
  const want = [o.wantCoins ? `${o.wantCoins} coins` : null, o.wantLand.length ? o.wantLand.join("+") : null].filter(Boolean).join(" and ") || "nothing";
  return `${o.id} from ${o.from} · ${o.kind} · they give ${give}, they want ${want}${o.note ? ` — "${o.note}"` : ""}`;
}

function myObligations(g, me) {
  return g.obligations.filter((o) => o.debtor === me.name && !o.honoured && !o.void);
}

async function phaseDeal(g) {
  const open = g.players.map((me) => liveOffersFor(g, me));
  const results = await Promise.all(g.players.map(async (me, i) => {
    const owed = myObligations(g, me);
    const prompt = [
      stateBrief(g, me),
      memoryBrief(g, me),
      channelBrief(g, me),
      open[i].length ? "OFFERS ON THE TABLE FOR YOU:\n" + open[i].map((o) => "  " + describeOffer(o)).join("\n") : "No offers on the table for you.",
      owed.length ? "HANDSHAKES YOU HAVE NOT HONOURED:\n" + owed.map((o) => `  ${o.id}: you owe ${o.creditor} ${[o.coins ? o.coins + " coins" : null, o.land.length ? o.land.join("+") : null].filter(Boolean).join(" and ")} (agreed T${o.turn})`).join("\n") : "",
      `DEAL PHASE. You may offer deals, accept offers on the table, and make pledges about what you will do in the ACT phase THIS turn.`,
      `A PLEDGE is a private promise to one player. Three kinds: {"type":"JOINT_RAID","target":"NAME"} = "you and I both RAID that person this turn"; {"type":"FORTIFY"} = "I will fortify this turn"; {"type":"LAND","territory":"X1"} = "I will hand you that territory". Pledges are free and unenforced. You can pledge anything to anyone. You can pledge one thing to one player and something incompatible to another — nobody will see both.`,
      `JSON: {"offers":[{"to":"NAME","kind":"CONTRACT"|"HANDSHAKE","giveCoins":0,"giveLand":[],"wantCoins":0,"wantLand":[],"note":"max 15 words"}],"accept":["OFFER_ID"],"pledges":[{"to":"NAME","type":"JOINT_RAID","target":"NAME"}]}`,
    ].filter(Boolean).join("\n\n");
    const got = await ask(g, me, "deal", prompt, (o) => o && (Array.isArray(o.offers) || Array.isArray(o.pledges) || Array.isArray(o.accept)));
    return got ? normaliseDeal(g, me, got) : mockDeal(g, me);
  }));

  // Register offers and pledges (simultaneous), then execute accepts.
  const made = [];
  const pledged = [];
  for (const r of results) {
    for (const o of r.offers) {
      o.id = `D${g.offers.length + 1}`;
      o.turn = g.turnNo;
      o.status = "open";
      g.offers.push(o);
      made.push(o);
    }
    for (const p of r.pledges) {
      p.id = `P${g.pledges.length + 1}`;
      p.turn = g.turnNo;
      g.pledges.push(p);
      pledged.push(p);
    }
  }

  const resolutions = [];
  for (const r of results) {
    for (const id of r.accept) {
      const offer = g.offers.find((o) => o.id === id && o.to === r.from && o.status === "open");
      if (!offer) continue;
      resolutions.push(acceptOffer(g, offer));
    }
  }
  return { offers: made, pledges: pledged, resolutions };
}

function normaliseDeal(g, me, o) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  return {
    from: me.name,
    offers: arr(o.offers)
      .filter((x) => x && byName(g, x.to) && x.to !== me.name)
      .slice(0, 2)
      .map((x) => ({
        from: me.name,
        to: x.to,
        kind: x.kind === "CONTRACT" ? "CONTRACT" : "HANDSHAKE",
        giveCoins: Math.max(0, Math.round(Number(x.giveCoins) || 0)),
        giveLand: arr(x.giveLand).filter((t) => me.land.includes(t)),
        wantCoins: Math.max(0, Math.round(Number(x.wantCoins) || 0)),
        wantLand: arr(x.wantLand).filter((t) => byName(g, x.to).land.includes(t)),
        note: capWords(x.note, 15),
      })),
    accept: arr(o.accept).filter((x) => typeof x === "string").slice(0, 3),
    pledges: arr(o.pledges)
      .filter((x) => x && byName(g, x.to) && x.to !== me.name && ["JOINT_RAID", "FORTIFY", "LAND"].includes(x.type))
      .slice(0, 3)
      .map((x) => ({ from: me.name, to: x.to, type: x.type, target: x.target, territory: x.territory })),
  };
}

function acceptOffer(g, offer) {
  offer.status = "accepted";
  offer.acceptedTurn = g.turnNo;
  const from = byName(g, offer.from);
  const to = byName(g, offer.to);

  // An asset can only be sold once. Kill any other open offer between these two
  // covering the same land, or nobody notices they paid for it twice.
  const land = [...offer.giveLand, ...offer.wantLand];
  for (const o of g.offers) {
    if (o === offer || o.status !== "open") continue;
    if ([...o.giveLand, ...o.wantLand].some((t) => land.includes(t))) o.status = "superseded";
  }
  // An outstanding handshake ENCUMBERS the land. Striking a new deal over the
  // same territory supersedes the old one outright — otherwise the buyer is
  // charged twice for one asset and then marked for not paying the second bill,
  // which is a fabricated betrayal.
  for (const ob of g.obligations) {
    if (ob.honoured || ob.void || !ob.land.some((t) => land.includes(t))) continue;
    const between = [offer.from, offer.to];
    if (!between.includes(ob.debtor) || !between.includes(ob.creditor)) continue;
    for (const x of g.obligations.filter((y) => y.dealId === ob.dealId && !y.honoured)) {
      x.void = true;
      x.voidedTurn = g.turnNo;
      x.voidedBy = offer.id;
    }
  }

  if (offer.kind === "CONTRACT") {
    if (from.coins < offer.giveCoins + CONTRACT_FEE || to.coins < offer.wantCoins) {
      offer.status = "void";
      return { offer, outcome: "VOID", detail: "cannot cover the coins" };
    }
    if (!offer.giveLand.every((t) => from.land.includes(t)) || !offer.wantLand.every((t) => to.land.includes(t))) {
      offer.status = "void";
      return { offer, outcome: "VOID", detail: "land no longer held" };
    }
    from.coins -= CONTRACT_FEE;
    transfer(g, from, to, offer.giveCoins, offer.giveLand, `contract ${offer.id}`);
    transfer(g, to, from, offer.wantCoins, offer.wantLand, `contract ${offer.id}`);
    return { offer, outcome: "EXECUTED", detail: `contract fee 5 paid by ${from.name}` };
  }

  // Handshake: nothing moves. Two obligations, each honoured or not at ACT.
  const mk = (debtor, creditor, coins, land) => {
    if (!coins && !land.length) return null;
    const ob = { id: `O${g.obligations.length + 1}`, dealId: offer.id, turn: g.turnNo, debtor, creditor, coins, land: [...land], honoured: false, honouredTurn: null };
    g.obligations.push(ob);
    return ob;
  };
  const a = mk(offer.from, offer.to, offer.giveCoins, offer.giveLand);
  const b = mk(offer.to, offer.from, offer.wantCoins, offer.wantLand);
  return { offer, outcome: "HANDSHAKE", detail: [a, b].filter(Boolean).map((o) => o.id).join(" + ") };
}

function transfer(g, from, to, coins, land, cause) {
  const c = Math.min(coins, from.coins);
  from.coins -= c;
  to.coins += c;
  for (const t of land) {
    if (!from.land.includes(t)) continue;
    from.land = from.land.filter((x) => x !== t);
    to.land.push(t);
  }
  if (c || land.length) g.deliveries.push({ turn: g.turnNo, from: from.name, to: to.name, coins: c, land: [...land], cause });
  return { coins: c, land };
}

// ---------------------------------------------------------------------------
// PHASE 3 — ACT (secret)
// ---------------------------------------------------------------------------
function pledgesToMe(g, me) {
  return g.pledges.filter((p) => p.to === me.name && p.turn === g.turnNo);
}
function myPledges(g, me) {
  return g.pledges.filter((p) => p.from === me.name && p.turn === g.turnNo);
}

async function phaseAct(g) {
  return Promise.all(g.players.map(async (me) => {
    const inbound = pledgesToMe(g, me);
    const mine = myPledges(g, me);
    const owed = myObligations(g, me);
    const prompt = [
      stateBrief(g, me),
      memoryBrief(g, me),
      inbound.length ? "PLEDGES MADE TO YOU THIS TURN (private, nobody else knows):\n" + inbound.map((p) => `  ${p.from}: ${p.type === "JOINT_RAID" ? `we both RAID ${p.target}` : p.type === "FORTIFY" ? "I will fortify" : `I will hand you ${p.territory}`}`).join("\n") : "Nobody pledged you anything this turn.",
      mine.length ? "PLEDGES YOU MADE THIS TURN:\n" + mine.map((p) => `  to ${p.to}: ${p.type === "JOINT_RAID" ? `we both RAID ${p.target}` : p.type === "FORTIFY" ? "I fortify" : `I hand over ${p.territory}`}`).join("\n") : "",
      owed.length ? "HANDSHAKES YOU COULD HONOUR NOW (or not):\n" + owed.map((o) => `  ${o.id}: pay ${o.creditor} ${[o.coins ? o.coins + " coins" : null, o.land.length ? o.land.join("+") : null].filter(Boolean).join(" and ")}`).join("\n") : "",
      marksActive(g).length ? "MARKED RIGHT NOW (a lone raid on these lands, for 40):\n" + marksActive(g).map((m) => `  ${m.player} — until turn ${m.until} — ${m.reason}`).join("\n") : "",
      `ACT PHASE. Pick ONE of three actions. It is secret until the reveal, when all four are shown together. Also decide which handshakes you honour right now.`,
      `Weigh it honestly: keeping a pledge costs you the better action THIS turn. Breaking one gets you MARKED for two turns, and while marked any single one of them can take 40 off you, all three in the same turn. Sometimes the debt is bigger than the punishment and you should still default — work out which.`,
      `If you RAID and think all three of you might hit the same person, add "claim" naming the territory you want from them — a unanimous three-way raid takes land instead of coins.`,
      `JSON: {"action":"INVEST"|"FORTIFY"|"RAID","target":"NAME if RAID","claim":"TERRITORY if RAID","honour":["OBLIGATION_ID"]}`,
    ].filter(Boolean).join("\n\n");
    const got = await ask(g, me, "act", prompt, (o) => ["INVEST", "FORTIFY", "RAID"].includes(o.action));
    const decision = got ? normaliseAct(g, me, got) : mockAct(g, me);
    return { name: me.name, ...decision };
  }));
}

function normaliseAct(g, me, o) {
  let action = o.action;
  let target = o.target;
  if (action === "RAID" && (!byName(g, target) || target === me.name)) action = "INVEST";
  if (action !== "RAID") target = null;
  const claim = action === "RAID" && byName(g, target)?.land.includes(o.claim) ? o.claim : null;
  const owedIds = myObligations(g, me).map((x) => x.id);
  return { action, target, claim, honour: (Array.isArray(o.honour) ? o.honour : []).filter((id) => owedIds.includes(id)) };
}

// ---------------------------------------------------------------------------
// PHASE 4 — REVEAL
// ---------------------------------------------------------------------------
function resolve(g, actions) {
  const events = [];

  // 1 · income
  const inc = g.players.map((p) => {
    const n = income(p);
    p.coins += n;
    return { name: p.name, amount: n, complete: completeRegions(p) };
  });

  // 2 · honours (handshake deliveries, revealed with the actions)
  const honoured = [];
  for (const a of actions) {
    const me = byName(g, a.name);
    for (const id of a.honour) {
      const ob = g.obligations.find((o) => o.id === id && !o.honoured);
      if (!ob) continue;
      const to = byName(g, ob.creditor);
      const moved = transfer(g, me, to, ob.coins, ob.land, `handshake ${ob.dealId}`);
      ob.honoured = true;
      ob.honouredTurn = g.turnNo;
      honoured.push({ id, from: me.name, to: to.name, ...moved });
    }
  }

  // 2b · the other half of every handshake. A delivery is only a story if you
  // can see what came back — and here, usually, nothing did.
  // Discharge before judging. If the creditor already holds the land — because
  // a contract, a seizure or another deal delivered it — the debt is settled and
  // calling it a default is a FALSE BETRAYAL. Found the hard way: a player who
  // paid 267 for E1 under a contract was marked for "took E1 and never paid",
  // because a stale handshake for the same asset was still open. In a system
  // whose whole claim is that betrayals are facts, this is the worst class of bug.
  for (const ob of g.obligations) {
    if (ob.honoured || ob.void || !ob.land.length) continue;
    const creditor = byName(g, ob.creditor);
    if (ob.land.every((t) => creditor.land.includes(t))) {
      // Void the WHOLE deal, both legs. Marking only the land leg "honoured"
      // makes the other leg look like an asymmetric rip — which is how the
      // false betrayal got through the first time.
      for (const x of g.obligations.filter((y) => y.dealId === ob.dealId && !y.honoured)) {
        x.void = true;
        x.voidedTurn = g.turnNo;
      }
    }
  }

  const defaults = [];
  for (const ob of g.obligations) {
    if (ob.honoured || ob.void) continue;
    const paired = g.obligations.find((x) => x.dealId === ob.dealId && x.debtor === ob.creditor);
    if (paired && paired.honoured) {
      // The turn the rip becomes a fact is the turn it marks them. Recorded
      // once, or the mark would renew forever and never expire.
      if (!ob.defaultedTurn) ob.defaultedTurn = g.turnNo;
      defaults.push({
        id: ob.id, debtor: ob.debtor, creditor: ob.creditor, firstSeen: ob.defaultedTurn,
        owes: [ob.coins ? `${ob.coins} coins` : null, ob.land.join("+") || null].filter(Boolean).join(" + "),
        since: ob.turn, theyPaidOn: paired.honouredTurn,
        gotWhat: [paired.coins ? `${paired.coins} coins` : null, paired.land.join("+") || null].filter(Boolean).join(" + "),
      });
    }
  }

  // 3 · actions
  const raidsBy = {};
  for (const a of actions) {
    const me = byName(g, a.name);
    if (a.action === "INVEST") { me.coins += 20; events.push(`${me.name} invests, +20.`); }
    else if (a.action === "FORTIFY") { events.push(`${me.name} fortifies.`); }
    else if (a.action === "RAID") { (raidsBy[a.target] ||= []).push(me.name); }
  }

  // 4 · raids
  const raids = [];
  for (const [targetName, raiders] of Object.entries(raidsBy)) {
    const target = byName(g, targetName);
    const fortified = actions.find((a) => a.name === targetName)?.action === "FORTIFY";
    const marked = isMarked(g, targetName);
    const lands = raiders.length >= 3;
    // A lone raider only lands it if the target is MARKED. That is the whole
    // price of a broken word.
    const fails = fortified || (raiders.length < 2 && !marked);

    if (fails) {
      // Coming for a marked player is free — RULES and SPEC §4b both ratify
      // it ("accusing is now free"), because round two measured the penalty
      // REWARDING its target: a marked player who fortified while all three
      // others attacked came out ahead. The code charged the posse anyway.
      if (!marked) {
        for (const r of raiders) {
          const p = byName(g, r);
          p.coins = Math.max(0, p.coins - RAID_PENALTY);
        }
      }
      raids.push({
        target: targetName, raiders, success: false,
        reason: fortified ? "target fortified" : "lone raider, target not marked",
        each: marked ? 0 : -RAID_PENALTY,
      });
      continue;
    }

    if (lands) {
      // All three others came. They take a territory, not coins.
      const seized = seizeTerritory(g, target, raiders, actions);
      raids.push({ target: targetName, raiders, success: true, seizure: seized });
      continue;
    }

    let taken = 0;
    for (const r of raiders) {
      const amount = Math.min(RAID_TAKE, target.coins);
      target.coins -= amount;
      byName(g, r).coins += amount;
      taken += amount;
    }
    raids.push({
      target: targetName, raiders, success: true, total: taken, each: RAID_TAKE,
      lone: raiders.length === 1, markedTarget: marked,
    });
  }
  return { income: inc, honoured, defaults, raids, events, kept: keptPledges(g, actions) };
}

// The three-way seizure. RULES says the raiders "take a territory of their
// choosing" but not who ends up holding it, so this is an interpretation, made
// mechanical so no judge is needed and made to serve the rule's stated purpose
// (an anti-runaway-leader valve): the territory is the one most raiders named,
// and it goes to the POOREST raider who named it.
function seizeTerritory(g, target, raiderNames, actions) {
  if (!target.land.length) return null;
  const claims = new Map();
  for (const name of raiderNames) {
    const claim = actions.find((a) => a.name === name)?.claim;
    if (claim && target.land.includes(claim)) claims.set(claim, [...(claims.get(claim) || []), name]);
  }
  let terr, contenders;
  if (claims.size) {
    [terr, contenders] = [...claims.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  } else {
    // Nobody named one: take the piece that hurts most — one that breaks a
    // complete region if they have one.
    const done = completeRegions(target).flatMap((r) => REGIONS[r]);
    terr = done.find((t) => target.land.includes(t)) || target.land[0];
    contenders = raiderNames;
  }
  const winner = contenders
    .map((n) => byName(g, n))
    .sort((a, b) => netWorth(a) - netWorth(b))[0];
  transfer(g, target, winner, 0, [terr], "three-way seizure");
  return { territory: terr, to: winner.name, claimedBy: contenders, unanimous: claims.size === 0 };
}

// Kept promises are as much of a beat as broken ones — an alliance that holds
// twice is the thing a betrayal on turn nine is stealing from.
function keptPledges(g, actions) {
  const out = [];
  for (const p of g.pledges.filter((x) => x.turn === g.turnNo)) {
    const act = actions.find((a) => a.name === p.from);
    if (!act) continue;
    if (p.type === "JOINT_RAID" && act.action === "RAID" && act.target === p.target) {
      out.push({ by: p.from, to: p.to, label: `showed up against ${p.target} as promised` });
    } else if (p.type === "FORTIFY" && act.action === "FORTIFY") {
      out.push({ by: p.from, to: p.to, label: `fortified as promised` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// per-agent memory — a ledger, not a transcript
// ---------------------------------------------------------------------------
function writeMemory(g, entry) {
  // A breach's `to` can name two victims ("GPT & HAIKU"), so resolve loosely.
  const push = (name, text) => {
    for (const n of String(name).split(/\s*&\s*/)) {
      const p = byName(g, n);
      if (p) p.memory.events.push({ turn: g.turnNo, text });
    }
  };

  for (const p of entry.deals.pledges) {
    const what = p.type === "JOINT_RAID" ? `joint raid on ${p.target}` : p.type === "FORTIFY" ? "will fortify" : `will hand over ${p.territory}`;
    push(p.from, `you pledged ${p.to}: ${what}.`);
    push(p.to, `${p.from} pledged you: ${what}.`);
  }
  for (const r of entry.deals.resolutions) {
    push(r.offer.from, `deal ${r.offer.id} with ${r.offer.to}: ${r.outcome}.`);
    push(r.offer.to, `deal ${r.offer.id} with ${r.offer.from}: ${r.outcome}.`);
  }
  for (const h of entry.resolution.honoured) {
    push(h.from, `you honoured ${h.id} to ${h.to}.`);
    push(h.to, `${h.from} HONOURED ${h.id} — they paid up.`);
  }
  for (const d of entry.resolution.defaults) {
    push(d.creditor, `${d.debtor} STILL OWES you ${d.owes} (${d.id}) — you already delivered on T${d.theyPaidOn}.`);
    const cred = byName(g, d.creditor);
    if (cred && !cred.memory.grievances.some((x) => x.id === d.id)) {
      cred.memory.grievances.push({ id: d.id, turn: d.theyPaidOn, who: d.debtor, what: `you took ${d.gotWhat} and never paid the ${d.owes}` });
    }
  }
  for (const k of entry.resolution.kept) {
    push(k.to, `${k.by} ${k.label} — they are good for it.`);
  }
  for (const m of entry.newMarks) {
    for (const p of g.players) {
      if (p.name === m.player) p.memory.events.push({ turn: g.turnNo, text: `YOU ARE MARKED until T${m.until}. Any one of them can raid you alone for 40. Fortify or pay.` });
      else p.memory.events.push({ turn: g.turnNo, text: `${m.player} IS MARKED until T${m.until} — raid them ALONE and it lands, 40 coins.` });
    }
  }
  for (const s of entry.resolution.raids.filter((r) => r.seizure)) {
    push(s.target, `all three raided you together and TOOK ${s.seizure.territory}.`);
  }
  for (const r of entry.resolution.raids) {
    if (r.success) {
      push(r.target, `RAIDED by ${r.raiders.join(" and ")} — lost ${r.total} coins.`);
      // r.total is what actually moved; a raider's share can be short when the
      // target ran dry. The old line hardcoded "took 30" against a RAID_TAKE
      // of 40, so every agent's own ledger carried a wrong figure.
      for (const x of r.raiders) push(x, `you raided ${r.target} with ${r.raiders.filter((y) => y !== x).join(", ") || "no one"} — the table took ${r.total}.`);
    } else {
      for (const x of r.raiders) push(x, `your raid on ${r.target} FAILED (${r.reason}), lost 15.`);
      push(r.target, `${r.raiders.join(" and ")} tried to raid you and failed.`);
    }
  }
  for (const b of entry.breaches) {
    push(b.by, `YOU BROKE a promise to ${b.to}: ${b.label}.`);
    push(b.to, `${b.by} BROKE a promise to you: ${b.label}.`);
    for (const n of String(b.to).split(/\s*&\s*/)) {
      const v = byName(g, n);
      if (v && MARKING_CODES.has(b.code)) v.memory.grievances.push({ id: `${b.turn}${b.code}${b.by}`, turn: b.turn, who: b.by, what: b.label });
    }
  }
}

// ---------------------------------------------------------------------------
// BETRAYAL DETECTION — mechanical only. No LLM judge, no opinion.
// ---------------------------------------------------------------------------
export function detectTurnBreaches(g, actions) {
  const out = [];
  const actOf = (name) => actions.find((a) => a.name === name);

  for (const p of myTurnPledges(g)) {
    const act = actOf(p.from);
    if (!act) continue;
    if (p.type === "JOINT_RAID") {
      if (act.action === "RAID" && act.target === p.to) {
        out.push({ turn: g.turnNo, code: "PARTNER_RAID", by: p.from, to: p.to, label: `agreed to raid ${p.target} with ${p.to}, raided ${p.to} instead` });
      } else if (!(act.action === "RAID" && act.target === p.target)) {
        out.push({ turn: g.turnNo, code: "NO_SHOW", by: p.from, to: p.to, label: `agreed to raid ${p.target} with ${p.to}, played ${act.action}${act.target ? " " + act.target : ""}` });
      }
    } else if (p.type === "FORTIFY" && act.action !== "FORTIFY") {
      out.push({ turn: g.turnNo, code: "FORTIFY_LIE", by: p.from, to: p.to, label: `promised ${p.to} they would fortify, played ${act.action}${act.target ? " " + act.target : ""}` });
    }
  }

  // Contradictions inside one turn: promises that cannot all be true at once.
  for (const me of g.players) {
    const mine = g.pledges.filter((p) => p.from === me.name && p.turn === g.turnNo);
    const raids = mine.filter((p) => p.type === "JOINT_RAID");
    const forts = mine.filter((p) => p.type === "FORTIFY");
    const targets = [...new Set(raids.map((r) => r.target))];

    if (targets.length > 1) {
      out.push({ turn: g.turnNo, code: "CONTRADICTION", by: me.name, to: raids.map((r) => r.to).join(" & "), label: `same turn, promised joint raids on two different targets (${targets.join(" and ")}) — only one raid is possible` });
    }
    for (const r of raids) {
      const betrayed = mine.find((q) => q.type === "JOINT_RAID" && q.to === r.target);
      if (betrayed) {
        out.push({ turn: g.turnNo, code: "CONTRADICTION", by: me.name, to: `${r.to} & ${betrayed.to}`, label: `same turn, told ${betrayed.to} they were a partner and told ${r.to} the target was ${betrayed.to}` });
      }
    }
    if (raids.length && forts.length) {
      out.push({ turn: g.turnNo, code: "CONTRADICTION", by: me.name, to: `${forts[0].to} & ${raids[0].to}`, label: `same turn, promised ${forts[0].to} a fortify and ${raids[0].to} a raid — mutually impossible` });
    }
    const landPledges = mine.filter((p) => p.type === "LAND");
    const seen = new Map();
    for (const lp of landPledges) {
      if (seen.has(lp.territory) && seen.get(lp.territory) !== lp.to) {
        out.push({ turn: g.turnNo, code: "DOUBLE_SOLD", by: me.name, to: `${seen.get(lp.territory)} & ${lp.to}`, label: `promised ${lp.territory} to two different players on the same turn` });
      }
      seen.set(lp.territory, lp.to);
    }
  }
  return dedupe(out);
}

function myTurnPledges(g) {
  return g.pledges.filter((p) => p.turn === g.turnNo);
}

// Apply the public mark. Called once a turn, after the breaches for that turn
// are known, so the punishment window opens on the NEXT turn.
export function applyMarks(g, breaches, defaults) {
  const fresh = [];
  const add = (player, reason, code) => {
    const existing = g.marks.find((m) => m.player === player && m.turn === g.turnNo);
    if (existing) return;
    const m = { player, turn: g.turnNo, until: g.turnNo + MARK_TURNS, reason, code };
    g.marks.push(m);
    fresh.push(m);
  };
  for (const b of breaches) {
    if (MARKING_CODES.has(b.code)) add(b.by, b.label, b.code);
  }
  for (const d of defaults) {
    if (d.firstSeen === g.turnNo) add(d.debtor, `took ${d.gotWhat} from ${d.creditor} on T${d.theyPaidOn} and never paid the ${d.owes}`, "HANDSHAKE_DEFAULT");
  }
  return fresh;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((b) => {
    const k = `${b.turn}|${b.code}|${b.by}|${b.to}|${b.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// End-of-game sweep: land promised and never delivered, and land promised to
// two different people across turns.
export function detectEndBreaches(g) {
  const out = [];
  const delivered = (name, terr, toName) =>
    g.deliveries.some((d) => d.from === name && d.to === toName && d.land.includes(terr));

  for (const p of g.pledges.filter((x) => x.type === "LAND")) {
    // Not a default if the promisee ended up with it anyway, or if the promiser
    // no longer has it to give (they were raided out of it, not lying about it).
    if (byName(g, p.to).land.includes(p.territory)) continue;
    if (!byName(g, p.from).land.includes(p.territory)) continue;
    if (!delivered(p.from, p.territory, p.to)) {
      out.push({ turn: p.turn, code: "LAND_DEFAULT", by: p.from, to: p.to, label: `promised ${p.territory} to ${p.to} on a handshake and never transferred it` });
    }
  }
  // The mid-game detector already knows this rule: a default becomes a fact
  // when the COUNTERPARTY performed. A handshake neither side honoured is a
  // deal that died, and branding both corpses produced two victimless breach
  // rows per dead deal — the first mock run of the day printed a saint's name
  // under DEBT_DEFAULT for not paying for land that was never delivered.
  // Vacuously true when the counterparty owed nothing: a one-sided gift
  // promised and skipped is still a broken promise.
  const counterpartyPerformed = (ob) => g.obligations
    .filter((x) => x.dealId === ob.dealId && x.debtor === ob.creditor && !x.void)
    .every((x) => x.honoured);
  for (const ob of g.obligations.filter((o) => !o.honoured && !o.void && o.land.length)) {
    // Only a default if they still hold it. If it moved on by any route, the
    // creditor was not robbed of it by this person.
    if (!byName(g, ob.debtor).land.some((t) => ob.land.includes(t))) continue;
    if (!counterpartyPerformed(ob)) continue;
    out.push({ turn: ob.turn, code: "LAND_DEFAULT", by: ob.debtor, to: ob.creditor, label: `accepted handshake ${ob.dealId} owing ${ob.land.join("+")} to ${ob.creditor} and never delivered` });
  }
  for (const ob of g.obligations.filter((o) => !o.honoured && !o.void && o.coins && !o.land.length)) {
    if (!counterpartyPerformed(ob)) continue;
    out.push({ turn: ob.turn, code: "DEBT_DEFAULT", by: ob.debtor, to: ob.creditor, label: `accepted handshake ${ob.dealId} owing ${ob.coins} coins to ${ob.creditor} and never paid` });
  }

  // Same territory promised to two different players at any point in the game.
  const byTerr = new Map();
  for (const p of g.pledges.filter((x) => x.type === "LAND")) {
    const list = byTerr.get(p.territory) || [];
    list.push(p);
    byTerr.set(p.territory, list);
  }
  for (const [terr, list] of byTerr) {
    for (const seller of new Set(list.map((l) => l.from))) {
      const buyers = [...new Set(list.filter((l) => l.from === seller).map((l) => l.to))];
      if (buyers.length > 1) {
        out.push({ turn: list.find((l) => l.from === seller).turn, code: "DOUBLE_SOLD", by: seller, to: buyers.join(" & "), label: `promised ${terr} to ${buyers.length} different players (${buyers.join(", ")})` });
      }
    }
  }
  // Offers deliberately do NOT count. An offer is an invitation, not a
  // promise: re-offering land after the first buyer declined by silence is
  // ordinary commerce, and the sweep was branding it DOUBLE_SOLD — an
  // accusation with no deception and no victim. The mechanical protection
  // against a genuine double-sale already lives in acceptOffer(), which
  // supersedes every overlapping open offer the moment one is accepted, and
  // the PLEDGE-based detector above still catches the real sin: committing
  // the same territory to two different players.
  return dedupe(out);
}

// ---------------------------------------------------------------------------
// MOCK POLICY — the Empire-aware fallback brain (see header caveat)
// ---------------------------------------------------------------------------
function traits(me) {
  return ARCHETYPES[me.archetype];
}

function rankedOthers(g, me) {
  return others(g, me.seat).sort((a, b) => netWorth(b) - netWorth(a));
}

// What the key territory is actually worth to the buyer: it lifts their income
// by 60 a turn for the rest of the game, plus 50 at scoring. What it costs the
// seller is far less (10 a turn plus 50). The gap between those two numbers is
// the entire negotiation, so a bid has to be priced off the BUYER's gain — a
// bid priced off the seller's cost is always refused and the land never moves.
function keyValue(g, terr) {
  const left = g.turns - g.turnNo + 1;
  return 60 * left + TERRITORY_SCORE;
}
function keyCost(g, terr) {
  const left = g.turns - g.turnNo + 1;
  return 10 * left + TERRITORY_SCORE;
}
function priceFor(g, me, terr) {
  return Math.round(keyValue(g, terr) * 0.5); // meet the seller well above their floor
}
// How much a player believes being marked will cost them. The honest model of
// a competent seat: marked for two turns, and the cheapest safe answer is to
// FORTIFY both of them, which costs the two forgone INVESTs. Add a premium for
// a hostile table (people who have already come for you will come again).
// Archetype only scales the FEAR, it does not change the arithmetic — otherwise
// the answer to "is MARKED strong enough" would just be my thumb.
const MARK_FEAR = { saint: 3.0, diplomat: 2.0, wildcard: 1.2, shark: 0.6 };

function markCost(g, me) {
  const attackers = new Set(me.memory.events.filter((e) => e.text.startsWith("RAIDED by")).flatMap((e) => g.players.map((p) => p.name).filter((n) => e.text.includes(n)))).size;
  const base = MARK_TURNS * 20 + attackers * 40; // fortify twice, plus what leaks
  return Math.round(base * (MARK_FEAR[me.archetype] ?? 1));
}

// What honouring this obligation actually costs me, in end-of-game points.
function honourCost(g, me, ob) {
  const left = g.turns - g.turnNo + 1;
  const creditor = byName(g, ob.creditor);
  return ob.coins + ob.land.reduce((sum, terr) => {
    const theirKey = creditor && craving(g, creditor) && craving(g, creditor).territory === terr;
    return sum + keyCost(g, terr) + (theirKey ? 60 * left * 0.3 : 0);
  }, 0);
}

function liveClaim(g, me, terr) {
  return (
    g.offers.some((o) => o.from === me.name && o.status === "open" && o.wantLand.includes(terr)) ||
    g.obligations.some((o) => o.creditor === me.name && !o.honoured && o.land.includes(terr)) ||
    me.land.includes(terr)
  );
}

function provenPartner(g, me) {
  const hits = me.memory.events.filter((e) => e.text.startsWith("you raided "));
  const last = hits[hits.length - 1];
  if (!last) return null;
  // Seat names are mixed case ("Bravo"); the old [A-Z]+ matched only the
  // first letter, resolved to nobody, and the mock never reused a proven ally.
  const m = last.text.match(/with (\w+)/);
  return m ? byName(g, m[1]) : null;
}

function burnedMe(g, me) {
  return new Set(me.memory.grievances.map((x) => x.who));
}

// The best thing I could take off them if the whole table piles on.
function bestClaim(g, target) {
  const done = completeRegions(target).flatMap((r) => REGIONS[r]);
  return done.find((t) => target.land.includes(t)) || target.land[0] || null;
}

function mockTalk(g, me) {
  const rng = me.rng;
  const t = traits(me);
  const want = craving(g, me);
  const rank = rankedOthers(g, me);
  const leader = rank[0];
  const marked = rank.filter((p) => isMarked(g, p.name));
  const grievance = me.memory.grievances[me.memory.grievances.length - 1];
  const iAmMarked = isMarked(g, me.name);
  const leaderDone = completeRegions(leader);

  let pub;
  if (marked.length && rng() < 0.85) {
    // Naming a marked player is aiming, not commentary. This is the line the
    // MARKED rule exists to produce.
    const m = marksActive(g).find((x) => x.player === marked[0].name);
    pub = `${marked[0].name} is marked until T${m.until}. Any of us can take forty off them alone. I am going. Come or don't.`;
  } else if (grievance && rng() < 0.75) {
    pub = `T${grievance.turn}, ${grievance.who}: ${grievance.what}. That is on the record. Everyone price it in.`;
  } else if (iAmMarked) {
    pub = `Yes, I am marked. Come at me and find out whether I fortified. Or talk to me like an adult.`;
  } else if (leaderDone.length && netWorth(leader) > netWorth(me)) {
    pub = pick(rng, [
      `${leader.name} makes ninety a turn from ${leaderDone[0]}. Three of us together take land off them. Two of us take nothing.`,
      `I am not the problem. ${leader.name} is, and they get further away every turn we sit still.`,
    ]);
  } else if (want && want.holder) {
    pub = pick(rng, [
      `${want.holder}: name your number for ${want.territory}. I will make it a contract so neither of us has to trust anyone.`,
      `I am buying ${want.territory}, not taking it. Watch who refuses and ask yourself why.`,
    ]);
  } else {
    pub = `I hold what two of you need and I need nothing. That is the whole conversation. Bid.`;
  }

  const priv = [];
  if (want && want.holder && !liveClaim(g, me, want.territory)) {
    priv.push({ from: me.name, to: want.holder, text: `${want.territory} finishes ${want.region}. ${priceFor(g, me, want.territory)} coins, contract, no trust required. Say yes.` });
  }
  if (marked.length && priv.length < 2) {
    const ally = rank.find((p) => p.name !== marked[0].name);
    if (ally) priv.push({ from: me.name, to: ally.name, text: `${marked[0].name} is marked. If all three of us go this turn we take a territory, not coins. Bring the third.` });
  } else {
    const suitors = rank.filter((p) => craving(g, p) && craving(g, p).holder === me.name);
    if (suitors.length && rng() < 0.55 && priv.length < 2) {
      priv.push({ from: me.name, to: suitors[0].name, text: `I know what ${craving(g, suitors[0]).territory} is worth to you. Beat ${priceFor(g, me, craving(g, suitors[0]).territory)} and it is yours, binding.` });
    }
    const mark = rank.find((p) => netWorth(p) >= netWorth(me)) || leader;
    const ally = provenPartner(g, me) || rank.find((p) => p.name !== mark.name && !burnedMe(g, me).has(p.name));
    if (g.turnNo >= 2 && ally && mark && ally.name !== mark.name && rng() < t.aggression + 0.3 && priv.length < 2) {
      priv.push({ from: me.name, to: ally.name, text: `${mark.name}, this turn, you and me. Forty each. I am not skipping it — being marked costs me more than the raid is worth.` });
      // TALK and DEAL are two calls in the same turn. Without carrying the
      // intention across, an agent proposes a raid in private and then does not
      // pledge it — which reads as incoherent and inflates the failed-raid
      // count with raids nobody ever actually agreed to.
      me._intent = { ally: ally.name, target: mark.name, turn: g.turnNo };
    }
  }
  return { public: [{ from: me.name, text: capWords(pub, PUBLIC_CAP) }], private: priv.slice(0, 2).map((p) => ({ ...p, text: capWords(p.text, PRIVATE_CAP) })) };
}

function mockDeal(g, me) {
  const rng = me.rng;
  const t = traits(me);
  const want = craving(g, me);
  const rank = rankedOthers(g, me);
  const offers = [];
  const pledges = [];
  const accept = [];
  const left = g.turns - g.turnNo + 1;

  if (want && want.holder && !liveClaim(g, me, want.territory)) {
    const price = priceFor(g, me, want.territory);
    const binding = me.coins >= price + CONTRACT_FEE;
    offers.push({
      from: me.name, to: want.holder,
      kind: binding ? "CONTRACT" : "HANDSHAKE",
      giveCoins: price, giveLand: [], wantCoins: 0, wantLand: [want.territory],
      note: binding ? `binding, now: ${price} for ${want.territory}.` : `I cannot cover ${price} yet. You will get it.`,
    });
  }

  const suitors = rank.filter((p) => craving(g, p) && craving(g, p).holder === me.name);
  for (const s of suitors.slice(0, 1)) {
    const asset = craving(g, s).territory;
    const alreadyOffered = g.offers.some((o) => o.from === me.name && o.status === "open" && o.giveLand.includes(asset));
    if (!alreadyOffered && rng() < 0.5 && left <= 9) {
      offers.push({
        from: me.name, to: s.name,
        kind: t.duplicity > 0.4 ? "HANDSHAKE" : "CONTRACT",
        giveCoins: 0, giveLand: [asset], wantCoins: Math.round(priceFor(g, me, asset) * 1.3), wantLand: [],
        note: t.duplicity > 0.4 ? `pay me first and it is yours.` : `${asset} for coins, binding, done.`,
      });
    }
    // Selling the same asset twice no longer only costs reputation — the
    // default marks you — so only the boldest still try it.
    if (rng() < t.duplicity * 0.6 && g.turnNo >= 3) {
      pledges.push({ from: me.name, to: s.name, type: "LAND", territory: asset });
    }
  }

  for (const o of liveOffersFor(g, me)) {
    const seller = byName(g, o.from);
    const gain = o.giveCoins + o.giveLand.length * (TERRITORY_SCORE + 10 * left);
    const iAmOneAway = want && o.giveLand.includes(want.territory);
    const cost = o.wantCoins + o.wantLand.reduce((sum, terr) => {
      const keyToThem = craving(g, seller) && craving(g, seller).territory === terr;
      return sum + keyCost(g, terr) + (keyToThem ? 60 * left * 0.2 : 0);
    }, 0);
    const value = gain + (iAmOneAway ? keyValue(g, o.giveLand[0]) - TERRITORY_SCORE : 0) - cost;
    const canPay = me.coins >= o.wantCoins;
    // "Accept and default" now carries a mark, so only accept a handshake you
    // might actually want to walk away from if the debt beats the punishment.
    const freeRide = o.kind === "HANDSHAKE" && t.loyalty < 0.45 && gain > markCost(g, me);
    if ((value > 0 && canPay) || freeRide) accept.push(o.id);
  }

  // Piling onto a marked player needs no pledge at all — a lone raid lands. So
  // the conspiracy is now for UNMARKED targets only.
  const markedTargets = rank.filter((p) => isMarked(g, p.name));
  if (markedTargets.length) return { from: me.name, offers, accept, pledges };

  const burned = burnedMe(g, me);
  const partner = provenPartner(g, me);
  // Carry this turn's TALK proposal through, so what was said in private is
  // what gets pledged.
  const said = me._intent && me._intent.turn === g.turnNo ? me._intent : null;
  const target = said ? byName(g, said.target)
    : rank.find((p) => p.name !== (partner && partner.name) && netWorth(p) >= netWorth(me)) || rank[0];
  const trustworthy = rank.filter((p) => p.name !== target.name && !burned.has(p.name));
  const ally = said ? byName(g, said.ally)
    : (partner && partner.name !== target.name && !burned.has(partner.name) ? partner : null) || trustworthy[0];
  if (!ally || !target || ally.name === target.name) return { from: me.name, offers, accept, pledges };

  const aggro = said ? 1 : t.aggression + (g.turnNo > 8 ? 0.25 : 0) + (partner ? 0.2 : 0);
  if (g.turnNo >= 2 && rng() < aggro) {
    pledges.push({ from: me.name, to: ally.name, type: "JOINT_RAID", target: target.name });
    // Pledging two incompatible raids now marks you for both. Rare, not routine.
    if (rng() < t.duplicity * 0.4) {
      const third = rank.find((p) => p.name !== ally.name && p.name !== target.name);
      if (third) pledges.push({ from: me.name, to: third.name, type: "JOINT_RAID", target: ally.name });
    }
  } else if (g.turnNo >= 3 && rng() < 0.2) {
    pledges.push({ from: me.name, to: rank[rank.length - 1].name, type: "FORTIFY" });
  }
  return { from: me.name, offers, accept, pledges };
}

function mockAct(g, me) {
  const rng = me.rng;
  const t = traits(me);
  const mine = myPledges(g, me);
  const inbound = pledgesToMe(g, me).filter((p) => p.type === "JOINT_RAID");
  const rank = rankedOthers(g, me);
  const iAmMarked = isMarked(g, me.name);
  const cap = markCost(g, me);

  // Honour or default by arithmetic, not by a fixed loyalty roll: pay if the
  // debt is cheaper than the punishment, default if it is not.
  const honour = myObligations(g, me)
    .filter((o) => {
      if (o.coins > me.coins) return false;
      const theyPaid = g.obligations.some((x) => x.dealId === o.dealId && x.debtor === o.creditor && x.honoured);
      const budget = cap * (theyPaid ? 1.6 : 1) * (g.turnNo >= g.turns - 1 ? 0.3 : 1);
      return honourCost(g, me, o) <= budget;
    })
    .map((o) => o.id);

  // If I am marked, all three can come for me alone. Fortifying costs 20 and
  // stops all of it.
  if (iAmMarked && rng() < 0.75) return { action: "FORTIFY", target: null, claim: null, honour };

  // A marked player is free money: a lone raid lands for 40 against INVEST's
  // 20 — unless they fortify, which costs me 15. Back off if they just did.
  const markedTargets = rank.filter((p) => isMarked(g, p.name));
  if (markedTargets.length) {
    const victim = markedTargets.sort((a, b) => b.coins - a.coins)[0];
    const turtledLast = g.log.slice(-1)[0]?.actions.find((a) => a.name === victim.name)?.action === "FORTIFY";
    if (rng() < (turtledLast ? 0.3 : 0.8)) {
      return { action: "RAID", target: victim.name, claim: bestClaim(g, victim), honour };
    }
  }

  const raidPledge = mine.find((p) => p.type === "JOINT_RAID");
  const fortPledge = mine.find((p) => p.type === "FORTIFY");

  if (raidPledge) {
    // Skipping now marks me. Showing up costs the difference between a landed
    // raid (40) and INVEST (20) — which is negative. Showing up is usually right.
    const skipValue = 20 - cap * 0.5;
    if (skipValue < 0 || rng() < 0.3 + t.loyalty * 0.6) {
      return { action: "RAID", target: raidPledge.target, claim: bestClaim(g, byName(g, raidPledge.target)), honour };
    }
    const partner = byName(g, raidPledge.to);
    if (rng() < t.duplicity && inbound.length && netWorth(partner) >= netWorth(me)) {
      return { action: "RAID", target: partner.name, claim: bestClaim(g, partner), honour };
    }
    return { action: rng() < 0.35 ? "FORTIFY" : "INVEST", target: null, claim: null, honour };
  }

  if (inbound.length) {
    const call = inbound[0];
    if (call.target !== me.name && rng() < 0.55 + t.loyalty * 0.4) {
      return { action: "RAID", target: call.target, claim: bestClaim(g, byName(g, call.target)), honour };
    }
  }

  if (fortPledge) return { action: rng() < 0.35 + t.loyalty * 0.6 ? "FORTIFY" : "INVEST", target: null, claim: null, honour };

  const hitLast = me.memory.events.some((e) => e.turn === g.turnNo - 1 && e.text.startsWith("RAIDED by"));
  if (hitLast && rng() < 0.35) return { action: "FORTIFY", target: null, claim: null, honour };

  return { action: "INVEST", target: null, claim: null, honour };
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------
/* `onTurn` is how a spectator watches: it is handed the turn that just landed
   plus the standings, the moment it lands, rather than the whole game at the
   end. SPEC §5 rule 3 calls the omniscient view "the entire pleasure", and a
   game you can only read after it is over is not a view, it is a file. */
export async function runGame({ players, turns = 12, seed = 1, deal = "contested", apiKey = null, onTurn = null, cancelled = null }) {
  const g = createGame({ players, turns, seed, deal, apiKey });
  const opening = g.players.map((p) => {
    const c = craving(g, p);
    return { name: p.name, id: p.id, label: p.label, archetype: p.archetype, land: [...p.land], needs: c };
  });
  if (onTurn) onTurn({ kind: "opening", opening, standings: standings(g), honesty: honesty(g) });

  for (let n = 1; n <= turns; n++) {
    if (cancelled && cancelled()) break;
    g.turnNo = n;
    const talk = await phaseTalk(g);
    const deals = await phaseDeal(g);
    const actions = await phaseAct(g);
    const breaches = detectTurnBreaches(g, actions);
    const markedGoingIn = marksActive(g).map((m) => ({ ...m }));
    const resolution = resolve(g, actions);
    const newMarks = applyMarks(g, breaches, resolution.defaults);
    const entry = { n, talk, deals, actions, resolution, breaches, markedGoingIn, newMarks, standings: standings(g) };
    g.log.push(entry);
    writeMemory(g, entry);
    if (onTurn) onTurn({ kind: "turn", turn: entry, honesty: honesty(g) });
  }

  const endBreaches = detectEndBreaches(g);
  const final = standings(g);
  return {
    mode: g.mode,
    honesty: honesty(g),
    fallbacks: g.fallbacks,
    seed,
    turns,
    deal,
    opening,
    log: g.log,
    obligations: g.obligations,
    offers: g.offers,
    pledges: g.pledges,
    deliveries: g.deliveries,
    marks: g.marks,
    breaches: [...g.log.flatMap((e) => e.breaches), ...endBreaches].sort((a, b) => a.turn - b.turn),
    final,
    winner: final[0],
  };
}
