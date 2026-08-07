// Persistence for finished match records. Three backends, best available first:
// Replit DB over HTTP -> local JSON file -> memory only. Replit deployment
// filesystems don't persist and REPLIT_DB_URL isn't guaranteed inside
// Autoscale, so every backend fails soft; storage must never break a request.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "golden-arena:records:v1";
const MAX_RECORDS = 400;

// DATA_DIR is overridable so a test run never writes into the live board.
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE_PATH = path.join(DATA_DIR, "records.json");

let cache = [];
let mode = "memory"; // "repldb" | "file" | "memory"
let failures = 0;
let warnedMemory = false;
let writeQueue = Promise.resolve();

function parseRecords(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // a corrupt blob should not kill boot
  }
}

function degrade(err) {
  mode = "memory";
  if (!warnedMemory) {
    warnedMemory = true;
    console.warn(`Storage degraded to memory-only (records won't survive a restart): ${err.message}`);
  }
}

async function dbGet() {
  const res = await fetch(`${process.env.REPLIT_DB_URL}/${encodeURIComponent(KEY)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Replit DB GET ${res.status}`);
  return res.text();
}

async function dbSet(value) {
  const res = await fetch(process.env.REPLIT_DB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `${encodeURIComponent(KEY)}=${encodeURIComponent(value)}`,
  });
  if (!res.ok) throw new Error(`Replit DB POST ${res.status}`);
}

export async function initStore() {
  if (process.env.REPLIT_DB_URL) {
    try {
      cache = parseRecords(await dbGet());
      mode = "repldb";
      failures = 0;
      return cache;
    } catch (err) {
      console.warn(`Replit DB unavailable (${err.message}); falling back to file storage.`);
    }
  }
  try {
    await mkdir(DATA_DIR, { recursive: true });
    let raw = null;
    try {
      raw = await readFile(FILE_PATH, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    cache = parseRecords(raw);
    mode = "file";
    failures = 0;
  } catch (err) {
    cache = [];
    degrade(err);
  }
  return cache;
}

export function records() {
  return cache;
}

export function storageMode() {
  return mode;
}

async function persist() {
  if (mode === "memory") return;
  const payload = JSON.stringify(cache);
  try {
    if (mode === "repldb") await dbSet(payload);
    else await writeFile(FILE_PATH, payload);
    failures = 0;
  } catch (err) {
    failures += 1;
    if (failures >= 3) degrade(err);
  }
}

export async function addRecord(record) {
  cache.push(record);
  if (cache.length > MAX_RECORDS) cache.splice(0, cache.length - MAX_RECORDS);
  // Serialised write-through: later snapshots always land after earlier ones.
  writeQueue = writeQueue.then(persist);
  return writeQueue;
}
