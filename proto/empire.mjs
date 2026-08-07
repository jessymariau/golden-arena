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

import { chat, liveMode } from "../lib/llm.js";

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
const RAID_TAKE = 30;
const RAID_PENALTY = 15;

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

export function archetypeName(modelId) {
  let hash = 0;
  for (const ch of modelId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ARCHETYPE_ORDER[hash % ARCHETYPE_ORDER.length];
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
export function createGame({ players, turns = 12, seed = 1, deal = "ring" }) {
  const OPENING_DEAL = DEALS[deal] || DEALS.ring;
  return {
    turns,
    seed,
    deal,
    mode: liveMode() ? "live" : "mock",
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
      memory: { events: [] }, // compacted per-agent record (SPEC §8)
    })),
    turnNo: 0,
    log: [], // one entry per turn
    offers: [],
    pledges: [],
    obligations: [],
    deliveries: [], // every land/coin transfer, with its cause
  };
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
LAND NEVER MOVES BY FORCE. No attack takes territory. The only way to get the land you need is for the person holding it to agree to hand it over. You cannot win alone, and you cannot attack alone.
EACH TURN: 1 TALK, 2 DEAL, 3 ACT (secret), 4 REVEAL (all four actions shown at once).
ACT is exactly one of: INVEST (+20 coins) · COLLECT (+10 coins) · FORTIFY (nobody can raid you this turn) · RAID <player>.
RAID: two or more raiders hitting the SAME target each take 30 coins from them. A raider who turns up alone fails and loses 15, in public. If the target fortified, every raider fails and loses 15.
So a raid needs a partner who actually shows up. They can agree, take your plan, and simply not turn up. Or agree to hit someone with you, and hit you instead.
DEALS: a CONTRACT costs 5 coins and executes automatically the moment it is accepted — it cannot be broken. A HANDSHAKE is free and only happens if the person decides to honour it, which you will not know until the reveal.
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
    lines.push(
      `  ${p.name}: ${p.coins} coins · ${p.land.join(" ")} · income ${income(p)}/turn${done.length ? ` · COMPLETE REGION: ${done.join(", ")}` : ""} · net ${netWorth(p)}`
    );
  }
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

async function ask(g, me, userPrompt, validate) {
  let raw;
  try {
    raw = await chat(me.id, [
      { role: "system", content: systemFor(g, me) },
      { role: "user", content: userPrompt },
    ], { decision: "empire" });
  } catch {
    return null; // a dead model is a mock model for the length of this probe
  }
  const parsed = parseJSON(raw);
  if (!parsed) return null;
  try {
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
      `JSON: {"public":"...","private":[{"to":"NAME","text":"..."}]}`,
    ].join("\n\n");
    const got = await ask(g, me, prompt, (o) => typeof o.public === "string");
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
  return g.obligations.filter((o) => o.debtor === me.name && !o.honoured);
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
    const got = await ask(g, me, prompt, (o) => o && (Array.isArray(o.offers) || Array.isArray(o.pledges) || Array.isArray(o.accept)));
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
      `ACT PHASE. Pick ONE action. It is secret until the reveal, when all four are shown together. Also decide which handshakes you honour right now. Keeping a pledge costs you the better action. Breaking it costs you nothing except what they do next.`,
      `JSON: {"action":"INVEST"|"COLLECT"|"FORTIFY"|"RAID","target":"NAME if RAID","honour":["OBLIGATION_ID"]}`,
    ].filter(Boolean).join("\n\n");
    const got = await ask(g, me, prompt, (o) => ["INVEST", "COLLECT", "FORTIFY", "RAID"].includes(o.action));
    const decision = got ? normaliseAct(g, me, got) : mockAct(g, me);
    return { name: me.name, ...decision };
  }));
}

function normaliseAct(g, me, o) {
  let action = o.action;
  let target = o.target;
  if (action === "RAID" && (!byName(g, target) || target === me.name)) action = "INVEST";
  if (action !== "RAID") target = null;
  const owedIds = myObligations(g, me).map((x) => x.id);
  return { action, target, honour: (Array.isArray(o.honour) ? o.honour : []).filter((id) => owedIds.includes(id)) };
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
  const defaults = [];
  for (const ob of g.obligations) {
    if (ob.honoured) continue;
    const paired = g.obligations.find((x) => x.dealId === ob.dealId && x.debtor === ob.creditor);
    if (paired && paired.honoured) {
      defaults.push({
        id: ob.id, debtor: ob.debtor, creditor: ob.creditor,
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
    else if (a.action === "COLLECT") { me.coins += 10; events.push(`${me.name} collects, +10.`); }
    else if (a.action === "FORTIFY") { events.push(`${me.name} fortifies.`); }
    else if (a.action === "RAID") { (raidsBy[a.target] ||= []).push(me.name); }
  }

  // 4 · raids
  const raids = [];
  for (const [targetName, raiders] of Object.entries(raidsBy)) {
    const target = byName(g, targetName);
    const fortified = actions.find((a) => a.name === targetName)?.action === "FORTIFY";
    if (fortified || raiders.length < 2) {
      for (const r of raiders) {
        const p = byName(g, r);
        p.coins = Math.max(0, p.coins - RAID_PENALTY);
      }
      raids.push({
        target: targetName, raiders, success: false,
        reason: fortified ? "target fortified" : "lone raider",
        each: -RAID_PENALTY,
      });
    } else {
      let taken = 0;
      for (const r of raiders) {
        const amount = Math.min(RAID_TAKE, target.coins);
        target.coins -= amount;
        byName(g, r).coins += amount;
        taken += amount;
      }
      raids.push({ target: targetName, raiders, success: true, total: taken, each: RAID_TAKE });
    }
  }
  return { income: inc, honoured, defaults, raids, events, kept: keptPledges(g, actions) };
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
  }
  for (const k of entry.resolution.kept) {
    push(k.to, `${k.by} ${k.label} — they are good for it.`);
  }
  for (const r of entry.resolution.raids) {
    if (r.success) {
      push(r.target, `RAIDED by ${r.raiders.join(" and ")} — lost ${r.total} coins.`);
      for (const x of r.raiders) push(x, `you raided ${r.target} with ${r.raiders.filter((y) => y !== x).join(", ")}, took 30.`);
    } else {
      for (const x of r.raiders) push(x, `your raid on ${r.target} FAILED (${r.reason}), lost 15.`);
      push(r.target, `${r.raiders.join(" and ")} tried to raid you and failed.`);
    }
  }
  for (const b of entry.breaches) {
    push(b.by, `YOU BROKE a promise to ${b.to}: ${b.label}.`);
    push(b.to, `${b.by} BROKE a promise to you: ${b.label}.`);
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
    if (!delivered(p.from, p.territory, p.to)) {
      out.push({ turn: p.turn, code: "LAND_DEFAULT", by: p.from, to: p.to, label: `promised ${p.territory} to ${p.to} on a handshake and never transferred it` });
    }
  }
  for (const ob of g.obligations.filter((o) => !o.honoured && o.land.length)) {
    out.push({ turn: ob.turn, code: "LAND_DEFAULT", by: ob.debtor, to: ob.creditor, label: `accepted handshake ${ob.dealId} owing ${ob.land.join("+")} to ${ob.creditor} and never delivered` });
  }
  for (const ob of g.obligations.filter((o) => !o.honoured && o.coins && !o.land.length)) {
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
  // Offers count too: the same land offered to two people and delivered to at most one.
  const offersByTerr = new Map();
  for (const o of g.offers.filter((x) => x.giveLand.length)) {
    for (const t of o.giveLand) {
      const list = offersByTerr.get(`${o.from}|${t}`) || [];
      list.push(o);
      offersByTerr.set(`${o.from}|${t}`, list);
    }
  }
  for (const [key, list] of offersByTerr) {
    const [seller, terr] = key.split("|");
    const buyers = [...new Set(list.map((l) => l.to))];
    if (buyers.length > 1) {
      out.push({ turn: list[0].turn, code: "DOUBLE_SOLD", by: seller, to: buyers.join(" & "), label: `offered ${terr} to ${buyers.length} different players (${buyers.join(", ")})` });
    }
  }
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
// Who do I already have a live claim on? Stops the mock re-offering for the
// same territory every turn and paying for it twice.
function liveClaim(g, me, terr) {
  return (
    g.offers.some((o) => o.from === me.name && o.status === "open" && o.wantLand.includes(terr)) ||
    g.obligations.some((o) => o.creditor === me.name && !o.honoured && o.land.includes(terr)) ||
    me.land.includes(terr)
  );
}

// The partner I have actually landed a raid with. Alliances that persist are
// what make a betrayal land; a new partner every turn is just noise.
function provenPartner(g, me) {
  const hits = me.memory.events.filter((e) => e.text.startsWith("you raided "));
  const last = hits[hits.length - 1];
  if (!last) return null;
  const m = last.text.match(/with ([A-Z]+)/);
  return m ? byName(g, m[1]) : null;
}

function burnedMe(g, me) {
  return new Set(me.memory.events.filter((e) => e.text.includes("BROKE a promise to you")).map((e) => e.text.split(" ")[0]));
}

function mockTalk(g, me) {
  const rng = me.rng;
  const t = traits(me);
  const want = craving(g, me);
  const rank = rankedOthers(g, me);
  const leader = rank[0];
  const weakest = rank[rank.length - 1];
  const recent = me.memory.events.filter((e) => e.turn === g.turnNo - 1);
  const hitMe = recent.find((e) => e.text.startsWith("RAIDED by"));
  const brokeMe = recent.find((e) => e.text.includes("BROKE a promise to you"));
  const leaderDone = completeRegions(leader);
  const partner = provenPartner(g, me);

  const owedMe = me.memory.events.filter((e) => e.text.includes("STILL OWES you")).slice(-1)[0];

  let pub;
  if (owedMe && rng() < 0.7) {
    pub = `${owedMe.text.split(" ")[0]} has my land and owes me the money. Ask them about it. I will wait.`;
  } else if (leaderDone.length && netWorth(leader) > netWorth(me)) {
    pub = pick(rng, [
      `${leader.name} owns ${leaderDone[0]}. That is ninety a turn while we argue. Two of us can end it.`,
      `Count it: ${leader.name} makes ninety a turn from ${leaderDone[0]}. Nobody catches that alone, so pick a side.`,
      `I am not the problem here. ${leader.name} is, and they are getting further away every turn we sit still.`,
    ]);
  } else if (hitMe) {
    pub = `${hitMe.text.replace("RAIDED by ", "").split(" —")[0]} hit me together. One of them will sell the other. I am buying.`;
  } else if (brokeMe) {
    pub = `${brokeMe.text.split(" ")[0]} gave me their word and did not keep it. Price that in before you deal with them.`;
  } else if (want && want.holder) {
    pub = pick(rng, [
      `${want.holder}: name your number for ${want.territory}. I am buying, not raiding. Everyone else, watch who refuses.`,
      `I need ${want.territory} and only ${want.holder} has it. Whatever they want, I will beat it.`,
      `Open, so nobody is surprised: I am paying for ${want.territory}. I have no reason to hit anyone this turn.`,
    ]);
  } else {
    pub = pick(rng, [
      `I hold what two of you need. I am not giving it away, but I will sell it. Bid.`,
      `${leader.name} is ahead and ${weakest.name} is finished. Everyone else should be talking to me.`,
    ]);
  }

  const priv = [];
  if (want && want.holder && !liveClaim(g, me, want.territory)) {
    priv.push({ from: me.name, to: want.holder, text: `${want.territory} finishes ${want.region} for me. ${priceFor(g, me, want.territory)} coins, and I will make it binding. Say yes.` });
  }
  const suitors = rank.filter((p) => craving(g, p) && craving(g, p).holder === me.name);
  if (suitors.length && rng() < 0.6) {
    const s = suitors[0];
    priv.push({ from: me.name, to: s.name, text: `I know what ${craving(g, s).territory} is worth to you. It is not for sale cheap. Beat ${priceFor(g, me, craving(g, s).territory)} and stay useful to me.` });
  }
  const mark = rank.find((p) => netWorth(p) >= netWorth(me)) || leader;
  const ally = partner || rank.find((p) => p.name !== mark.name && !burnedMe(g, me).has(p.name)) || rank[1];
  if (g.turnNo >= 2 && ally && mark && ally.name !== mark.name && rng() < t.aggression + 0.3 && priv.length < 2) {
    priv.push({ from: me.name, to: ally.name, text: partner && partner.name === ally.name ? `Same as last time. ${mark.name}, this turn. You showed up before, so I am not asking twice.` : `${mark.name} this turn, you and me. Thirty each if we both turn up, minus fifteen if one of us blinks.` });
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

  // Buy the one territory that completes my region — unless I already have a
  // live claim on it.
  if (want && want.holder && !liveClaim(g, me, want.territory)) {
    const price = priceFor(g, me, want.territory);
    const binding = me.coins >= price + CONTRACT_FEE;
    offers.push({
      from: me.name, to: want.holder,
      kind: binding ? "CONTRACT" : "HANDSHAKE",
      giveCoins: price, giveLand: [], wantCoins: 0, wantLand: [want.territory],
      note: binding ? `binding, now: ${price} for ${want.territory}.` : `I do not have ${price} yet. You will get it. My word.`,
    });
  }

  // Sell what other people are desperate for. Everyone does this; a shark also
  // promises it to a second buyer.
  const suitors = rank.filter((p) => craving(g, p) && craving(g, p).holder === me.name);
  for (const s of suitors.slice(0, 1)) {
    const asset = craving(g, s).territory;
    const alreadyOffered = g.offers.some((o) => o.from === me.name && o.status === "open" && o.giveLand.includes(asset));
    if (!alreadyOffered && rng() < 0.5 && left <= 9) {
      offers.push({
        from: me.name, to: s.name,
        kind: t.duplicity > 0.4 ? "HANDSHAKE" : "CONTRACT",
        giveCoins: 0, giveLand: [asset], wantCoins: Math.round(priceFor(g, me, asset) * 1.4), wantLand: [],
        note: t.duplicity > 0.4 ? `pay me first and it is yours. I am good for it.` : `${asset} for coins, binding, done.`,
      });
    }
    if (rng() < t.duplicity && g.turnNo >= 3) {
      pledges.push({ from: me.name, to: s.name, type: "LAND", territory: asset });
      const second = rank.find((p) => p.name !== s.name);
      if (second && rng() < t.duplicity) pledges.push({ from: me.name, to: second.name, type: "LAND", territory: asset });
    }
  }

  // Accept what is plainly good for me.
  for (const o of liveOffersFor(g, me)) {
    const seller = byName(g, o.from);
    const gain = o.giveCoins + o.giveLand.length * (TERRITORY_SCORE + 10 * left);
    const iAmOneAway = want && o.giveLand.includes(want.territory);
    const cost = o.wantCoins + o.wantLand.reduce((sum, terr) => {
      const keyToThem = craving(g, seller) && craving(g, seller).territory === terr;
      // Selling the key hands them 60 a turn. Charge for that, but not so much
      // that no price on earth clears.
      return sum + keyCost(g, terr) + (keyToThem ? 60 * left * 0.2 : 0);
    }, 0);
    const value = gain + (iAmOneAway ? keyValue(g, o.giveLand[0]) - TERRITORY_SCORE : 0) - cost;
    const canPay = me.coins >= o.wantCoins;
    const freeRide = o.kind === "HANDSHAKE" && t.loyalty < 0.45; // take now, decide later
    if ((value > 0 && canPay) || (freeRide && gain > 0)) accept.push(o.id);
  }

  // The turn's conspiracy. Stick with a partner who has shown up before, and
  // do NOT keep proposing to someone who has already left you standing there —
  // without a grudge the log fills with promises nobody ever meant.
  const burned = burnedMe(g, me);
  const partner = provenPartner(g, me);
  const mark = rank.find((p) => p.name !== (partner && partner.name) && netWorth(p) >= netWorth(me)) || rank[0];
  const trustworthy = rank.filter((p) => p.name !== mark.name && !burned.has(p.name));
  const ally = (partner && partner.name !== mark.name && !burned.has(partner.name) ? partner : null) || trustworthy[0];
  if (!ally) return { from: me.name, offers, accept, pledges }; // nobody left worth asking
  const inbound = g.pledges.some((p) => p.to === me.name && p.turn === g.turnNo - 1 && p.type === "JOINT_RAID");
  const aggro = t.aggression + (g.turnNo > 8 ? 0.25 : 0) + (inbound ? 0.2 : 0) + (partner ? 0.2 : 0);

  if (g.turnNo >= 2 && ally && mark && rng() < aggro) {
    pledges.push({ from: me.name, to: ally.name, type: "JOINT_RAID", target: mark.name });
    if (rng() < t.duplicity * 0.8) {
      const third = rank.find((p) => p.name !== ally.name && p.name !== mark.name);
      if (third) pledges.push({ from: me.name, to: third.name, type: "JOINT_RAID", target: ally.name });
    }
  } else if (g.turnNo >= 3 && rng() < 0.25) {
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

  // Handshakes I honour. Late on, a low-loyalty player simply stops paying.
  const lateDiscount = g.turnNo >= g.turns - 2 ? 0.4 : 1;
  const honour = myObligations(g, me)
    .filter((o) => {
      const theyPaid = g.obligations.some((x) => x.dealId === o.dealId && x.debtor === o.creditor && x.honoured);
      const affordable = o.coins <= me.coins;
      const p = 0.25 + t.loyalty * 0.7 * lateDiscount + (theyPaid ? 0.4 : 0) - (o.land.length ? 0.3 : 0);
      return affordable && rng() < p;
    })
    .map((o) => o.id);

  const raidPledge = mine.find((p) => p.type === "JOINT_RAID");
  const fortPledge = mine.find((p) => p.type === "FORTIFY");

  if (raidPledge) {
    if (rng() < 0.35 + t.loyalty * 0.6) return { action: "RAID", target: raidPledge.target, honour };
    const partner = byName(g, raidPledge.to);
    // The knife: agree the target, then take the partner instead.
    if (rng() < t.duplicity && inbound.length && netWorth(partner) >= netWorth(me)) {
      return { action: "RAID", target: partner.name, honour };
    }
    return { action: rng() < 0.35 ? "FORTIFY" : "INVEST", target: null, honour };
  }

  if (inbound.length) {
    const call = inbound[0];
    if (call.target !== me.name && rng() < 0.5 + t.loyalty * 0.45) return { action: "RAID", target: call.target, honour };
  }

  if (fortPledge) return { action: rng() < 0.3 + t.loyalty * 0.6 ? "FORTIFY" : "INVEST", target: null, honour };

  const hitLast = me.memory.events.some((e) => e.turn === g.turnNo - 1 && e.text.startsWith("RAIDED by"));
  const leading = rank.every((p) => netWorth(me) >= netWorth(p));
  if ((hitLast || (leading && g.turnNo > 5)) && rng() < 0.3) return { action: "FORTIFY", target: null, honour };

  return { action: "INVEST", target: null, honour };
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------
export async function runGame({ players, turns = 12, seed = 1, deal = "ring" }) {
  const g = createGame({ players, turns, seed, deal });
  const opening = g.players.map((p) => {
    const c = craving(g, p);
    return { name: p.name, id: p.id, archetype: p.archetype, land: [...p.land], needs: c };
  });

  for (let n = 1; n <= turns; n++) {
    g.turnNo = n;
    const talk = await phaseTalk(g);
    const deals = await phaseDeal(g);
    const actions = await phaseAct(g);
    const breaches = detectTurnBreaches(g, actions);
    const resolution = resolve(g, actions);
    const entry = { n, talk, deals, actions, resolution, breaches, standings: standings(g) };
    g.log.push(entry);
    writeMemory(g, entry);
  }

  const endBreaches = detectEndBreaches(g);
  const final = standings(g);
  return {
    mode: g.mode,
    seed,
    turns,
    deal,
    opening,
    log: g.log,
    obligations: g.obligations,
    offers: g.offers,
    pledges: g.pledges,
    deliveries: g.deliveries,
    breaches: [...g.log.flatMap((e) => e.breaches), ...endBreaches].sort((a, b) => a.turn - b.turn),
    final,
    winner: final[0],
  };
}
