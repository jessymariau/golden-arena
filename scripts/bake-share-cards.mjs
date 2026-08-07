// Bakes one 1200x630 unfurl card per stamp into public/share/.
//
// AUTHOR-TIME ONLY. This never runs on the server. X and LinkedIn will not
// unfurl an SVG, and the deploy target is an Autoscale container with no Chrome
// and no image libraries, so rasterising at request time is off the table:
// these PNGs are generated here, committed, and served as static files.
//
//   node scripts/bake-share-cards.mjs            # all stamps
//   node scripts/bake-share-cards.mjs betrayal   # one, by slug
//
// The card carries the stamp, not the match. Per-match text rides in og:title
// and og:description, which is where an unfurl actually shows it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { STAMPS } from "../lib/share.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public", "share");
const FONT_DIR = path.join(ROOT, "public", "fonts");
const TMP_DIR = path.join(os.tmpdir(), "golden-arena-cards");

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("No Chrome found. Set CHROME to the executable and run again.");
  process.exit(1);
}

// Fonts are inlined as data URIs. A file:// page cannot fetch a sibling font
// file in Chrome without loosening file access, and embedding is one less flag
// to get wrong.
const font = (file) => `data:font/woff2;base64,${readFileSync(path.join(FONT_DIR, file)).toString("base64")}`;
const FACES = `
@font-face{font-family:"Archivo Black";src:url(${font("archivo-black-latin-400.woff2")}) format("woff2");font-weight:400;font-display:block}
@font-face{font-family:"Archivo";src:url(${font("archivo-latin-400-500.woff2")}) format("woff2");font-weight:400 500;font-display:block}
@font-face{font-family:"Playfair Display";src:url(${font("playfair-display-latin-700italic.woff2")}) format("woff2");font-weight:700;font-style:italic;font-display:block}
`;

const TONES = { oxblood: "#8E2B20", verdigris: "#2E5A46", ink: "#17130E" };

// The stamp has to fit the plate: three sizes rather than a measuring pass.
const stampSize = (s) => (s.length <= 8 ? 108 : s.length <= 12 ? 88 : 72);

function template(stamp, { tone, gloss }) {
  const colour = TONES[tone] || TONES.ink;
  return `<!doctype html><meta charset="utf-8"><style>
${FACES}
html,body{margin:0;padding:0}
body{width:1200px;height:630px;background:#F2ECE0;color:#17130E;overflow:hidden;
  display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
  font-family:"Archivo",sans-serif;-webkit-font-smoothing:antialiased}
.frame{position:absolute;inset:26px;border:1px solid #B08A3E;pointer-events:none}
.runhead{position:absolute;top:64px;left:0;right:0;font-size:19px;font-weight:500;
  letter-spacing:.34em;text-transform:uppercase;color:#7A7061}
.stamp{font-family:"Archivo Black",sans-serif;font-size:${stampSize(stamp)}px;line-height:1;
  letter-spacing:.03em;color:${colour};border:7px solid ${colour};border-radius:2px;
  padding:26px 46px 30px;transform:rotate(-2.1deg);opacity:.94}
.gloss{font-family:"Playfair Display",Georgia,serif;font-style:italic;font-weight:700;
  font-size:40px;line-height:1.3;margin:56px 90px 0;max-width:900px}
.folio{position:absolute;bottom:62px;left:0;right:0;font-size:17px;font-weight:500;
  letter-spacing:.24em;text-transform:uppercase;color:#7A7061}
</style>
<div class="frame"></div>
<p class="runhead">Golden Arena &middot; The Behavioral Index</p>
<div class="stamp">${stamp}</div>
<p class="gloss">${gloss}</p>
<p class="folio">A psychological benchmark for AI models</p>`;
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

const only = process.argv[2];
const jobs = Object.entries(STAMPS).filter(([, m]) => !only || m.slug === only);
if (!jobs.length) {
  console.error(`No stamp with slug "${only}".`);
  process.exit(1);
}

for (const [stamp, meta] of jobs) {
  const html = path.join(TMP_DIR, `${meta.slug}.html`);
  const png = path.join(OUT_DIR, `${meta.slug}.png`);
  writeFileSync(html, template(stamp, meta));
  // An ABSOLUTE --screenshot path is required; a relative one fails silently.
  execFileSync(chrome, [
    "--headless",
    "--hide-scrollbars",
    "--window-size=1200,630",
    "--virtual-time-budget=9000",
    `--screenshot=${path.resolve(png)}`,
    pathToFileURL(html).href,
  ], { stdio: "ignore" });

  // A non-zero filesize is not evidence. Read the IHDR back and check it.
  const buf = readFileSync(png);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== 1200 || h !== 630) throw new Error(`${meta.slug}.png came out ${w}x${h}, expected 1200x630`);
  console.log(`${meta.slug}.png  ${w}x${h}  ${(buf.length / 1024).toFixed(0)}KB`);
}

console.log(`\n${jobs.length} card(s) baked into public/share/. Look at them before shipping.`);
