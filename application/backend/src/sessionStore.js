import fs from "node:fs/promises";
import path from "node:path";
import { APP_ROOT } from "./config.js";

const DATA_DIR = path.join(APP_ROOT, "backend", ".elytra");
const SESSION_PATH = path.join(DATA_DIR, "session.json");

/**
 * Last successfully-connected session descriptor, used to re-adopt a running
 * simulation after the backend process restarts (dev watch mode, crashes).
 * @returns {Promise<{ projectId: string, projectRoot: string, mode: string } | null>}
 */
export async function readSessionState() {
  try {
    const parsed = JSON.parse(await fs.readFile(SESSION_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.projectId && parsed.mode) {
      return {
        projectId: String(parsed.projectId),
        projectRoot: String(parsed.projectRoot || ""),
        mode: parsed.mode === "sim" ? "sim" : "physical",
      };
    }
  } catch {
    // missing or corrupt
  }
  return null;
}

export async function writeSessionState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SESSION_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearSessionState() {
  await fs.rm(SESSION_PATH, { force: true });
}
