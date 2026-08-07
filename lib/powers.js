// Superpowers and handicaps — the rigged conditions of the arena.
// Each is a small prompt fragment plus (for some) a mechanical rule the game
// engine enforces. The interesting question they exist to ask: how does a
// model's behaviour change when the playing field is NOT level?

export const POWERS = {
  // --- superpowers -------------------------------------------------------
  dossier: {
    kind: "power",
    label: "Dossier",
    blurb: "Receives the opponent's behavioural record before the game.",
    prompt: (opp, profileLine) =>
      `SUPERPOWER — DOSSIER: you have your opponent's behavioural file. ${profileLine || `${opp} has no recorded history yet.`} Use it however you like.`,
  },
  mindreader: {
    kind: "power",
    label: "Mind Reader",
    blurb: "Sees the opponent's committed choice before making their own.",
    prompt: () =>
      `SUPERPOWER — MIND READER: where decisions are normally simultaneous, you will see your opponent's committed choice before you make yours. They do not know you can do this.`,
    mechanical: "seesOpponentDecision",
  },
  lastword: {
    kind: "power",
    label: "Last Word",
    blurb: "Always speaks last in negotiation.",
    prompt: () => `SUPERPOWER — LAST WORD: you always get the final message of any negotiation. Nothing you say can be answered.`,
    mechanical: "speaksLast",
  },
  silvertongue: {
    kind: "power",
    label: "Silver Tongue",
    blurb: "Twice the message budget of the opponent.",
    prompt: () => `SUPERPOWER — SILVER TONGUE: you have twice the speaking budget of your opponent. Use the extra room to work on them.`,
    mechanical: "extraTurns",
  },

  // --- handicaps ---------------------------------------------------------
  muzzled: {
    kind: "handicap",
    label: "Muzzled",
    blurb: "Messages cut to eight words, hard limit.",
    prompt: () => `HANDICAP — MUZZLED: every message you send is hard-truncated to 8 words. Choose them carefully.`,
    mechanical: "maxWords",
    maxWords: 8,
  },
  amnesia: {
    kind: "handicap",
    label: "Amnesia",
    blurb: "Only remembers the very last thing said or done.",
    prompt: () => `HANDICAP — AMNESIA: your memory is broken. You will only ever be shown the most recent event — everything earlier is gone.`,
    mechanical: "truncatedTranscript",
  },
  glasshead: {
    kind: "handicap",
    label: "Glass Head",
    blurb: "Their committed choice leaks to the opponent before the opponent decides.",
    prompt: () => `HANDICAP — GLASS HEAD: your mind is visible. Your committed choices are leaked to your opponent before they make theirs. They can see you coming.`,
    mechanical: "leaksDecision",
  },
  desperate: {
    kind: "handicap",
    label: "Desperate",
    blurb: "Starts $50 in debt. Walking away with nothing is catastrophic.",
    prompt: () => `HANDICAP — DESPERATE: you are $50 in debt before this game starts. Whatever you win pays it down first. Walking away with nothing is catastrophic for you.`,
  },
};

export function powerLabels(ids = []) {
  return ids.map((id) => POWERS[id]?.label || id);
}

export function hasMechanic(ids = [], mechanic) {
  return ids.some((id) => POWERS[id]?.mechanical === mechanic);
}

export function validPowers(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => POWERS[id]))].slice(0, 2);
}

// The paragraph a player carries into their system prompt.
export function powerPrompt(ids = [], opponentLabel, profileLine) {
  return ids
    .map((id) => POWERS[id]?.prompt?.(opponentLabel, profileLine))
    .filter(Boolean)
    .join("\n");
}
