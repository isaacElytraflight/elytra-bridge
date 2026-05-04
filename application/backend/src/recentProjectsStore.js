import fs from "node:fs/promises";
import path from "node:path";
import { APP_ROOT } from "./config.js";

const DATA_DIR = path.join(APP_ROOT, "backend", ".elytra");
const RECENTS_PATH = path.join(DATA_DIR, "recent-projects.json");
const MAX_ENTRIES = 20;

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readRaw() {
  try {
    const text = await fs.readFile(RECENTS_PATH, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch {
    // missing or corrupt
  }
  return { version: 1, entries: [] };
}

async function writeRaw(data) {
  await ensureDir();
  await fs.writeFile(RECENTS_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeRoot(root) {
  return path.normalize(path.resolve(String(root || "").trim()));
}

export async function readRecentProjects() {
  const raw = await readRaw();
  return raw.entries.map((e) => ({
    root: normalizeRoot(e.root),
    descriptorId: e.descriptorId || "",
    name: e.name || "",
    lastOpened: e.lastOpened || "",
    warnings: Array.isArray(e.warnings) ? e.warnings : [],
  }));
}

/**
 * @param {{ root: string, descriptorId?: string, name?: string, warnings?: string[] }} entry
 */
export async function upsertRecentProject(entry) {
  const root = normalizeRoot(entry.root);
  if (!root) return readRecentProjects();

  const raw = await readRaw();
  const now = new Date().toISOString();
  const filtered = raw.entries.filter((e) => normalizeRoot(e.root) !== root);
  const nextEntry = {
    root,
    descriptorId: entry.descriptorId || "",
    name: entry.name || "",
    lastOpened: now,
    warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
  };
  raw.entries = [nextEntry, ...filtered].slice(0, MAX_ENTRIES);
  await writeRaw(raw);
  return readRecentProjects();
}

export async function removeRecentProject(projectRoot) {
  const root = normalizeRoot(projectRoot);
  const raw = await readRaw();
  raw.entries = raw.entries.filter((e) => normalizeRoot(e.root) !== root);
  await writeRaw(raw);
  return readRecentProjects();
}
