// LLM access for the arena. One entry point: chat(modelId, messages, opts).
// Two ways to reach real models:
//   1. the SERVER holds OPENROUTER_API_KEY  -> every visitor plays live, on us
//   2. a VISITOR brings their own key       -> opts.apiKey, billed to them
// Neither -> scripted mock personalities, so the app runs with zero setup.
//
// A visitor's key is a borrowed credential. It lives in a function argument for
// the length of one call and nowhere else: never logged, never persisted, never
// returned. scrub() is the last line of that defence — anything that could
// carry a key back to a client or a log goes through it first.

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const AUTH_URL = "https://openrouter.ai/api/v1/auth/key";

export function hasServerKey() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

// Unchanged meaning for every existing caller: "the SERVER can pay for models".
export function liveMode() {
  return hasServerKey();
}

// OpenRouter error bodies and key labels can echo the key itself.
const KEY_RE = /sk-or-[A-Za-z0-9._-]+/g;
export function scrub(text) {
  return String(text == null ? "" : text).replace(KEY_RE, "sk-or-…");
}

// ---------------------------------------------------------------------------
// Daily call budget — a public deployment must not be able to drain OUR key.
// It guards the server key only: a visitor spending their own money neither
// consumes the shared allowance nor is stopped by it.
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
  const byok = typeof opts.apiKey === "string" && opts.apiKey.length > 0;
  const key = byok ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  if (!key) return mockChat(modelId, messages, opts);
  if (!byok) {
    if (budgetState().exhausted) return mockChat(modelId, messages, opts);
    budget.used += 1;
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
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
    // A visitor's own key being refused is a fixable, user-facing problem —
    // flag it so the UI can offer the key panel instead of shrugging. The
    // upstream body is dropped entirely on an auth failure: that is the one
    // response most likely to quote the credential back at us.
    if (byok && [401, 402, 403].includes(res.status)) {
      const err = new Error(`OpenRouter refused this key (${res.status}) for ${modelId}.`);
      err.keyRejected = true;
      throw err;
    }
    const text = await res.text().catch(() => "");
    // This message reaches the client (games.js prints it in the transcript),
    // so it is scrubbed here, at the single place a key can appear in one.
    throw new Error(scrub(`OpenRouter ${res.status} for ${modelId}: ${text.slice(0, 200)}`));
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

// Check a visitor's key against OpenRouter without spending anything.
// Returns only what is safe to show: the key's own label and its usage.
export async function verifyKey(apiKey) {
  let res;
  try {
    res = await fetch(AUTH_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch {
    return { ok: false, error: "Couldn't reach OpenRouter. Try again in a moment." };
  }
  if (res.status === 401) return { ok: false, error: "OpenRouter refused that key. Check you copied the whole thing." };
  if (!res.ok) return { ok: false, error: `OpenRouter turned it down (${res.status}).` };

  let json = null;
  try { json = await res.json(); } catch { /* shape changed upstream */ }
  const d = (json && json.data) || {};
  return {
    ok: true,
    label: scrub(d.label || "unnamed key"),
    usage: Number.isFinite(d.usage) ? d.usage : null,
    limit: Number.isFinite(d.limit) ? d.limit : null,
    freeTier: Boolean(d.is_free_tier),
  };
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
