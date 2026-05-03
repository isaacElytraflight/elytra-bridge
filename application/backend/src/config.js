import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, "..", "..");
export const REPO_ROOT = path.resolve(APP_ROOT, "..");
export const ENV_FILE_PATH = path.join(APP_ROOT, "backend", ".env");

dotenv.config({ path: ENV_FILE_PATH });

export function reloadEnv() {
  dotenv.config({ path: ENV_FILE_PATH, override: true });
}

export function appConfig() {
  const configuredProjectsDir = process.env.PROJECTS_DIR || "";
  return {
    port: Number(process.env.PORT || 8787),
    defaultProjectId: process.env.DEFAULT_PROJECT_ID || "drone-2026",
    projectsDir: configuredProjectsDir
      ? resolvePath(configuredProjectsDir, path.join(APP_ROOT, "backend"))
      : resolvePath("projects", REPO_ROOT),
    reconnectBackoffMs: Number(process.env.RECONNECT_BACKOFF_MS || 3000),
  };
}

export function resolvePath(input, base = REPO_ROOT) {
  if (!input) return "";
  const raw = String(input).trim();
  if (!raw) return "";
  if (raw.startsWith("~/")) {
    return path.join(process.env.HOME || process.env.USERPROFILE || "", raw.slice(2));
  }
  return path.isAbsolute(raw) ? raw : path.resolve(base, raw);
}

export function envValue(key, fallback = "") {
  const value = process.env[key];
  return value == null || value === "" ? fallback : value;
}

export function envNumber(key, fallback) {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ensureEnvFile() {
  if (!fs.existsSync(ENV_FILE_PATH)) {
    fs.copyFileSync(path.join(APP_ROOT, "backend", ".env.example"), ENV_FILE_PATH);
  }
}
