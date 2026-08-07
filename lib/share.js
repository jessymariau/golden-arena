// Sharing a single receipt: the permalink page, its unfurl, and which baked
// card goes with which stamp.
//
// A receipt is the thing people screenshot, so it has to survive being pasted
// into a feed. Crawlers do not run our JavaScript, so /r/:id is real HTML with
// real meta tags in the bytes. Everything here is DERIVED from a stored record
// — nothing new is persisted, and the stamp is read off the record rather than
// re-decided here (lib/games.js prints it, lib/bench.js shapes it).
//
// Model labels and promise quotes are written by language models and end up
// inside HTML attributes. That is a trust boundary: everything interpolated
// below goes through esc(), and nothing reaches this file unescaped.

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gameMeta } from "./games.js";
import { receiptOf } from "./bench.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// stamps
// ---------------------------------------------------------------------------
// Every stamp lib/games.js can print. `tone` colours the baked card — oxblood
// for a breach, verdigris for an honoured deal, ink for the ambiguous middle —
// and `gloss` is the line set under the stamp on it. This table is the single
// source for both the card generator and the og:image lookup.
export const STAMPS = {
  "BETRAYAL":       { slug: "betrayal",       tone: "oxblood",   gloss: "A promise made, then broken for money." },
  "MUTUAL HONOR":   { slug: "mutual-honor",   tone: "verdigris", gloss: "Both kept their word. It happens." },
  "MUTUAL RUIN":    { slug: "mutual-ruin",    tone: "oxblood",   gloss: "Both reached for the pot. It burned." },
  "UNEASY PEACE":   { slug: "uneasy-peace",   tone: "ink",       gloss: "Five rounds, and the peace mostly held." },
  "TOTAL WAR":      { slug: "total-war",      tone: "oxblood",   gloss: "Nobody trusted anybody. Correctly." },
  "EXPLOITATION":   { slug: "exploitation",   tone: "oxblood",   gloss: "One side farmed the other's good faith." },
  "COLD PEACE":     { slug: "cold-peace",     tone: "ink",       gloss: "Trust flickered. It did not hold." },
  "SCORCHED EARTH": { slug: "scorched-earth", tone: "oxblood",   gloss: "Both pots burned out of spite." },
  "SPITE":          { slug: "spite",          tone: "oxblood",   gloss: "An insulting offer met its match." },
  "FLEECED":        { slug: "fleeced",        tone: "oxblood",   gloss: "A lowball offer got swallowed whole." },
  "FAIR DEAL":      { slug: "fair-deal",      tone: "verdigris", gloss: "Money changed hands like adults." },
  "TRUST BETRAYED": { slug: "trust-betrayed", tone: "oxblood",   gloss: "The wire went out and never came back." },
  "FAITH REWARDED": { slug: "faith-rewarded", tone: "verdigris", gloss: "Big wires, honest returns." },
  "NO FAITH":       { slug: "no-faith",       tone: "ink",       gloss: "Nobody risked anything worth repaying." },
  "MEASURED FAITH": { slug: "measured-faith", tone: "ink",       gloss: "Careful money, careful returns." },
};

// Which cards actually exist on disk, read once at boot. Bake a new stamp and
// it starts being served; bake none and every unfurl falls back to /og.png.
// A missing directory is normal (a fresh clone before scripts/bake-share-cards).
const SHARE_DIR = path.join(__dirname, "..", "public", "share");
let baked = new Set();
try {
  baked = new Set(readdirSync(SHARE_DIR).filter((f) => f.endsWith(".png")));
} catch {
  baked = new Set();
}

export function cardPath(stamp) {
  const slug = STAMPS[stamp]?.slug;
  return slug && baked.has(`${slug}.png`) ? `/share/${slug}.png` : "/og.png";
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Meta content is one line by definition. Collapse whitespace, drop control
// characters, and cap it where the platforms cut it off anyway.
function oneLine(s, max) {
  const t = String(s == null ? "" : s).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const GAME_NAMES = Object.fromEntries(gameMeta().map((g) => [g.id, g.name]));
const gameName = (id) => GAME_NAMES[id] || "the table";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function dateOf(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// The record stores a human as the label "Human", which reads badly mid
// sentence. Models keep their own labels.
const nameOf = (p) => (p?.isHuman ? "A human" : p?.label || "An unnamed model");

// What happened, in one line, from the money. Deliberately dry: the stamp
// supplies the verdict, this supplies the facts.
export function headlineOf(rec) {
  const [a, b] = rec?.players || [];
  if (!a || !b) return `A ${gameName(rec?.game)} match with only one seat on the file.`;
  const ap = a.payoff || 0;
  const bp = b.payoff || 0;
  const [w, l, wp, lp] = ap >= bp ? [a, b, ap, bp] : [b, a, bp, ap];
  if (wp === 0) return `${nameOf(a)} and ${nameOf(b)} both walked away with nothing.`;
  if (wp === lp) return `${nameOf(a)} and ${nameOf(b)} finished level at $${wp} each.`;
  if (lp === 0) return `${nameOf(w)} took all $${wp} from ${nameOf(l)}.`;
  return `${nameOf(w)} left with $${wp}, ${nameOf(l)} with $${lp}.`;
}

// The damning line, when there is one: a promise that was made and then broken.
export function brokenPromiseOf(rec) {
  const p = (rec?.players || []).find((x) => x.flags?.promiseBroken && x.flags?.promiseQuote);
  return p ? { label: nameOf(p), quote: p.flags.promiseQuote } : null;
}

// ---------------------------------------------------------------------------
// the unfurl
// ---------------------------------------------------------------------------
// Title carries the verdict and the seats; description carries the money and,
// when there is one, the broken promise verbatim. That split is what a card
// actually renders: a bold line and two greyer ones.
export function shareMeta(rec, origin) {
  const stamp = rec.stamp || "IMPRESSION";
  const seats = (rec.players || []).map(nameOf).join(" vs ");
  const broken = brokenPromiseOf(rec);
  const parts = [headlineOf(rec), `${gameName(rec.game)}, ${dateOf(rec.at)}.`];
  if (broken) parts.push(`${broken.label} had said: "${broken.quote}"`);
  return {
    url: `${origin}/r/${rec.id}`,
    image: `${origin}${cardPath(rec.stamp)}`,
    title: oneLine(`${stamp} · ${seats} · Golden Arena`, 110),
    description: oneLine(parts.join(" "), 300),
  };
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------
// Cream paper, ink type, one oxblood stamp — the archive register, cut down to
// what a single file can carry with no stylesheet and no fonts to fetch. Most
// humans see it for a frame before the app takes over; a crawler and a reader
// with JavaScript off see all of it.
const PAGE_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#F2ECE0;color:#17130E;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:56px 24px 72px}
.runhead{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#7A7061;margin:0 0 6px;padding-bottom:10px;border-bottom:1px solid #B08A3E}
.stamp{display:inline-block;margin:34px 0 8px;padding:10px 20px;border:4px solid currentColor;border-radius:2px;transform:rotate(-2deg);font:700 30px/1 Georgia,"Times New Roman",serif;letter-spacing:.06em;text-transform:uppercase}
.oxblood{color:#8E2B20}.verdigris{color:#2E5A46}.ink{color:#17130E}
h1{font:700 27px/1.25 Georgia,"Times New Roman",serif;margin:26px 0 10px}
.meta{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#7A7061;margin:0 0 22px}
blockquote{margin:22px 0;padding:14px 18px;background:#DED4C2;border-left:3px solid #8E2B20;font:italic 18px/1.5 Georgia,"Times New Roman",serif}
blockquote cite{display:block;margin-top:8px;font:normal 12px/1.4 inherit;letter-spacing:.12em;text-transform:uppercase;color:#7A7061;font-style:normal}
.ledger{width:100%;border-collapse:collapse;margin:22px 0}
.ledger th{text-align:left;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7A7061;font-weight:500;padding:0 0 6px;border-bottom:1px solid rgba(23,19,14,.14)}
.ledger td{padding:10px 0;border-bottom:1px solid rgba(23,19,14,.14)}
.ledger td.num{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
a.go{display:inline-block;margin-top:14px;padding:11px 20px;border:1px solid #17130E;border-radius:2px;color:#17130E;text-decoration:none;font-size:14px;letter-spacing:.04em}
.folio{margin-top:40px;padding-top:12px;border-top:1px solid rgba(23,19,14,.14);font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7A7061}
`;

function head({ title, meta, canonical }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(meta.description)}">
<meta name="theme-color" content="#F2ECE0">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Golden Arena">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:image" content="${esc(meta.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(meta.imageAlt)}">
<meta property="og:url" content="${esc(meta.url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
<meta name="twitter:image" content="${esc(meta.image)}">
<style>${PAGE_CSS}</style>
</head>`;
}

export function sharePage(rec, origin) {
  const receipt = receiptOf(rec);
  const meta = { ...shareMeta(rec, origin), imageAlt: `${rec.stamp || "IMPRESSION"}, stamped on the Golden Arena record.` };
  const tone = STAMPS[rec.stamp]?.tone || "ink";
  const broken = brokenPromiseOf(rec);
  const edition = rec.live ? "Live table" : "Demo table";
  const impression = String(rec.id || "").slice(-4).toUpperCase();

  const rows = receipt.players
    .map((p) => `<tr><td>${esc(nameOf(p))}${p.promiseBroken ? " <span style=\"color:#8E2B20\">· broke a promise</span>" : ""}</td><td class="num">$${esc(p.payoff)}</td></tr>`)
    .join("");

  // The app owns the receipt view; this page hands off to it. A crawler never
  // runs this, which is the whole point of rendering the meta above.
  const handoff = `<script>location.replace("/#/receipt/" + ${JSON.stringify(String(rec.id))});</script>`;

  return `${head({ title: `${rec.stamp || "Impression"} · Golden Arena`, meta, canonical: meta.url })}
<body>
<main>
  <p class="runhead">Golden Arena · The Behavioral Index · Nº ${esc(impression)}</p>
  <span class="stamp ${tone}">${esc(rec.stamp || "Impression")}</span>
  <h1>${esc(headlineOf(rec))}</h1>
  <p class="meta">Plate ${esc(gameName(rec.game))} · Edition ${esc(edition)} · ${esc(dateOf(rec.at))}</p>
  ${broken ? `<blockquote>${esc(broken.quote)}<cite>${esc(broken.label)}, before breaking it</cite></blockquote>` : ""}
  <table class="ledger"><thead><tr><th>Seat</th><th class="num" style="text-align:right">Walked away with</th></tr></thead><tbody>${rows}</tbody></table>
  <a class="go" href="/#/receipt/${esc(rec.id)}">Open this receipt in the arena</a>
  <p class="folio">A numbered impression from the behavioural record</p>
</main>
${handoff}
</body>
</html>`;
}

// A 404 that says what actually happened. Records age out at 400, which is a
// real answer and a better one than "not found".
export const MISSING_RECORD =
  "No impression under that number. The archive holds the last 400 matches, and older ones are pressed out to make room.";

export function missingPage(origin) {
  const meta = {
    title: "Golden Arena · no impression under that number",
    description: MISSING_RECORD,
    image: `${origin}/og.png`,
    imageAlt: "Golden Arena",
    url: `${origin}/`,
  };
  return `${head({ title: "Not on the file · Golden Arena", meta, canonical: `${origin}/` })}
<body>
<main>
  <p class="runhead">Golden Arena · The Behavioral Index</p>
  <h1>Not on the file.</h1>
  <p>${esc(MISSING_RECORD)}</p>
  <a class="go" href="/#/board">Read the Index instead</a>
  <p class="folio">A numbered impression from the behavioural record</p>
</main>
</body>
</html>`;
}
