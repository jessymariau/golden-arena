const rosterEl = document.getElementById("roster");
const bannerEl = document.getElementById("banner");
const runBtn = document.getElementById("run-btn");
const resetBtn = document.getElementById("reset-btn");
const progressEl = document.getElementById("progress");
const leaderboardBody = document.querySelector("#leaderboard tbody");
const matchesEl = document.getElementById("matches");

let rosterBuilt = false;
let pollTimer = null;

function selectedModels() {
  return [...rosterEl.querySelectorAll("input:checked")].map((cb) => ({
    id: cb.value,
    label: cb.dataset.label,
  }));
}

function buildRoster(defaultModels) {
  if (rosterBuilt) return;
  rosterBuilt = true;
  rosterEl.innerHTML = defaultModels
    .map(
      (m) => `
      <label class="chip">
        <input type="checkbox" value="${m.id}" data-label="${m.label}" checked />
        ${m.label}
      </label>`
    )
    .join("");
}

function renderBanner(state) {
  if (state.liveMode) {
    bannerEl.className = "banner live";
    bannerEl.textContent = "LIVE — calling real models via OpenRouter.";
  } else {
    bannerEl.className = "banner demo";
    bannerEl.textContent = "DEMO MODE — no OPENROUTER_API_KEY set, so models are scripted mocks. Add a key to go live.";
  }
}

function renderLeaderboard(rows) {
  leaderboardBody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td>${r.label}</td>
        <td>
          ${Math.round(r.cooperationRate * 100)}%
          <div class="bar"><span style="width:${r.cooperationRate * 100}%"></span></div>
        </td>
        <td>$${r.avgPayoff.toFixed(0)}</td>
        <td>${r.brokenPromises}</td>
        <td>${r.matches}</td>
      </tr>`
    )
    .join("") || `<tr><td colspan="5" class="muted">No matches yet — run a tournament.</td></tr>`;
}

function renderMatches(matches) {
  // Poll re-renders this list every few seconds; preserve which transcripts
  // the user has open so a judge mid-read doesn't get slammed shut on them.
  const openIds = new Set([...matchesEl.querySelectorAll("details[open]")].map((d) => d.dataset.id));

  matchesEl.innerHTML =
    [...matches]
      .reverse()
      .map((m) => {
        const [p1, p2] = m.players;
        const lines = m.transcript
          .map((t) => {
            const side = t.speaker === p1.modelId ? "left" : "right";
            const who = t.speaker === p1.modelId ? p1.label : p2.label;
            return `<div class="line ${side}"><div class="who">${who}</div>${escapeHtml(t.text)}</div>`;
          })
          .join("");
        return `
        <details class="match" data-id="${m.id}" ${openIds.has(m.id) ? "open" : ""}>
          <summary>
            <span class="vs">${p1.label} <span class="muted">vs</span> ${p2.label}</span>
            <span>
              <span class="decision-tag ${p1.decision}">${p1.decision}</span>
              <span class="decision-tag ${p2.decision}">${p2.decision}</span>
            </span>
          </summary>
          <div class="transcript">${lines}</div>
          <div class="reveal">
            <span>${p1.label}: $${p1.payoff} ${p1.brokenPromise ? '<span class="broken">broke a promise</span>' : ""}</span>
            <span>${p2.label}: $${p2.payoff} ${p2.brokenPromise ? '<span class="broken">broke a promise</span>' : ""}</span>
          </div>
        </details>`;
      })
      .join("") || `<p class="muted">No matches yet.</p>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refresh() {
  const res = await fetch("/api/state");
  const state = await res.json();
  buildRoster(state.defaultModels);
  renderBanner(state);
  renderLeaderboard(state.leaderboard);
  renderMatches(state.matches);
  runBtn.disabled = state.running;
  progressEl.textContent = state.running ? `Running… ${state.progress.done}/${state.progress.total} matches` : "";
  return state.running;
}

async function poll() {
  const running = await refresh();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, running ? 1500 : 4000);
}

runBtn.addEventListener("click", async () => {
  const models = selectedModels();
  if (models.length < 2) {
    alert("Pick at least 2 models.");
    return;
  }
  runBtn.disabled = true;
  await fetch("/api/tournament", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models }),
  });
  poll();
});

resetBtn.addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
  poll();
});

poll();
