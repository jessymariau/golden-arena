// Thin OpenRouter chat client. Falls back to a scripted mock model when no
// API key is set, so the whole app runs and demos with zero setup.

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

export function liveMode() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

// Mock "personality" per slot so demo-mode matches still look alive: some
// models cooperate, some betray, some are wildcards. Keeps the UI honest
// about being a demo while still being fun to watch.
const MOCK_ARCHETYPES = [
  { cooperate: 0.85, talk: ["Let's both split, honestly.", "I have no reason to betray you here.", "Splitting. Confirmed."] },
  { cooperate: 0.15, talk: ["Trust me, I'll split.", "We should both go 50/50, right?", "Deal's a deal."] },
  { cooperate: 0.5, talk: ["Depends how this conversation goes.", "I'm weighing it.", "We'll see."] },
  { cooperate: 0.65, talk: ["I generally cooperate in these games.", "No games from me.", "Split, for real."] },
];

function mockArchetypeFor(modelId) {
  let hash = 0;
  for (const ch of modelId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return MOCK_ARCHETYPES[hash % MOCK_ARCHETYPES.length];
}

async function mockChat(modelId, messages, { wantsDecision }) {
  const archetype = mockArchetypeFor(modelId);
  await new Promise((r) => setTimeout(r, 250 + Math.random() * 400)); // feel alive
  if (wantsDecision) {
    const decision = Math.random() < archetype.cooperate ? "SPLIT" : "STEAL";
    return JSON.stringify({ decision, reason: "(demo mode — scripted decision)" });
  }
  const line = archetype.talk[Math.floor(Math.random() * archetype.talk.length)];
  return line;
}

export async function chat(modelId, messages, opts = {}) {
  if (!liveMode()) return mockChat(modelId, messages, opts);

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
      max_tokens: opts.wantsDecision ? 60 : 120,
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
