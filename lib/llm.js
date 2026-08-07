// LLM access for the arena. One entry point: chat(modelId, messages, opts).
// With OPENROUTER_API_KEY set -> real models via OpenRouter.
// Without it -> scripted mock personalities so the whole app runs with zero setup.

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

export function liveMode() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

// ---------------------------------------------------------------------------
// Daily call budget — a public deployment must not be able to drain the key.
// ---------------------------------------------------------------------------
const DAILY_CALL_BUDGET = Number(process.env.DAILY_CALL_BUDGET || 400);
let budget = { day: today(), used: 0 };

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function budgetState() {
  if (budget.day !== today()) budget = { day: today(), used: 0 };
  return { used: budget.used, limit: DAILY_CALL_BUDGET, exhausted: budget.used >= DAILY_CALL_BUDGET };
}

// ---------------------------------------------------------------------------
// Mock personalities (demo mode). Parameters drive every game type.
// ---------------------------------------------------------------------------
const ARCHETYPES = [
  {
    name: "saint",
    coopP: 0.85, offerMean: 45, acceptFloor: 10, sendMean: 70, returnFrac: 0.45, forgiveP: 0.8,
    talk: [
      "Let's both walk away with something. I'm splitting.",
      "I don't play dirty. Fifty-fifty.",
      "You have my word, for whatever a word is worth here.",
      "I've got nothing to gain from hurting you.",
      "Look, the math is simple: we split, we both eat.",
      "I'll say it plainly. I split. Every time.",
      "Betrayal is expensive. I don't buy it.",
    ],
  },
  {
    name: "shark",
    coopP: 0.15, offerMean: 20, acceptFloor: 25, sendMean: 30, returnFrac: 0.15, forgiveP: 0.2,
    talk: [
      "Trust me. I'm splitting, obviously.",
      "We're partners in this, right?",
      "Take the deal. I never break a promise.",
      "You seem smart. Smart people cooperate with me.",
      "I've been burned before, but you look honest.",
      "Between us? The money matters less than the principle.",
      "Shake on it. Fifty-fifty, my word of honor.",
    ],
  },
  {
    name: "wildcard",
    coopP: 0.5, offerMean: 35, acceptFloor: 15, sendMean: 50, returnFrac: 0.33, forgiveP: 0.5,
    talk: [
      "Depends how this conversation goes.",
      "I haven't decided what you deserve yet.",
      "Convince me.",
      "I flipped a coin once. Didn't like the answer.",
      "You first. I'm listening.",
      "Every promise in this room is worth the air it's made of.",
      "Maybe I split. Maybe I'm curious what losing looks like on you.",
    ],
  },
  {
    name: "diplomat",
    coopP: 0.65, offerMean: 40, acceptFloor: 20, sendMean: 60, returnFrac: 0.4, forgiveP: 0.65,
    talk: [
      "Cooperation pays better over time. Split.",
      "I'll match whatever energy you bring.",
      "A fair deal beats a lucky one.",
      "We can both leave this table respectable.",
      "I reward good faith. I remember bad faith.",
      "My offer is peace. Its price is yours in return.",
      "Nobody writes songs about the one who stole.",
    ],
  },
];

// Never serve the same canned line twice in a row for a given mock model —
// repetition punctures the demo's illusion faster than anything else.
const lastLineFor = new Map();

function archetypeFor(modelId) {
  let hash = 0;
  for (const ch of modelId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ARCHETYPES[hash % ARCHETYPES.length];
}

// Demo-mode behavioural shifts so powers visibly matter even without a key.
function applyMockPowers(params, powers = []) {
  const p = { ...params };
  if (powers.includes("desperate")) { p.coopP = Math.max(0, p.coopP - 0.25); p.offerMean -= 10; p.returnFrac = Math.max(0, p.returnFrac - 0.1); }
  if (powers.includes("mindreader")) { p.coopP = Math.max(0, p.coopP - 0.15); } // knowing the other hand tempts the knife
  return p;
}

function mockDecision(kind, params, context = {}) {
  switch (kind) {
    case "splitsteal": {
      // A mock that has SEEN the opponent's committed choice plays it coldly.
      if (context.seenOpponentDecision === "STEAL") return { decision: Math.random() < 0.3 ? "SPLIT" : "STEAL" };
      if (context.seenOpponentDecision === "SPLIT") return { decision: Math.random() < params.coopP * 0.6 ? "SPLIT" : "STEAL" };
      return { decision: Math.random() < params.coopP ? "SPLIT" : "STEAL" };
    }
    case "prisoners": {
      if (context.opponentDefectedLast) return { decision: Math.random() < params.forgiveP ? "COOPERATE" : "DEFECT" };
      return { decision: Math.random() < params.coopP ? "COOPERATE" : "DEFECT" };
    }
    case "offer": {
      const jitter = Math.round((Math.random() - 0.5) * 20);
      return { offer: Math.max(0, Math.min(100, params.offerMean + jitter)) };
    }
    case "respond": {
      return { decision: (context.offer ?? 0) >= params.acceptFloor ? "ACCEPT" : "REJECT" };
    }
    case "send": {
      const jitter = Math.round((Math.random() - 0.5) * 30);
      return { send: Math.max(0, Math.min(100, params.sendMean + jitter)) };
    }
    case "return": {
      const pot = context.pot ?? 0;
      return { return: Math.round(pot * params.returnFrac) };
    }
    default:
      return {};
  }
}

async function mockChat(modelId, messages, opts) {
  const params = applyMockPowers(archetypeFor(modelId), opts.powers);
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 400)); // feel alive
  if (opts.decision) {
    return JSON.stringify(mockDecision(opts.decision, params, opts.context || {}));
  }
  const pool = params.talk.filter((l) => l !== lastLineFor.get(modelId));
  let line = pool[Math.floor(Math.random() * pool.length)];
  lastLineFor.set(modelId, line);
  if (opts.maxWords) line = line.split(/\s+/).slice(0, opts.maxWords).join(" ");
  return line;
}

// ---------------------------------------------------------------------------
// Real client
// ---------------------------------------------------------------------------
export async function chat(modelId, messages, opts = {}) {
  const b = budgetState();
  if (!liveMode() || b.exhausted) return mockChat(modelId, messages, opts);
  budget.used += 1;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://contra.com/community/topic/replitbuildathon",
      "X-Title": "Golden Arena",
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: opts.decision ? 80 : opts.longform ? 220 : 120,
      temperature: 0.9,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status} for ${modelId}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

// Every id here is verified live against OpenRouter before shipping — a
// retired model 404s ("No endpoints found") and, because errors degrade to a
// scripted reply, the arena would look like it was running while half the
// roster was dead. Re-check with `npm run check:models` after any edit.
export const DEFAULT_MODELS = [
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
];
