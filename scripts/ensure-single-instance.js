#!/usr/bin/env node
/**
 * Ensures at most one Elytra Bridge dev stack (backend + Vite) is running.
 * Invoked automatically via npm "predev" before `npm run dev`.
 *
 * 1. Stops the previous dev tree recorded in backend/.elytra/dev-instance.json
 * 2. Frees the configured backend/frontend ports (and common stale alternates)
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const APP_ROOT = path.join(REPO_ROOT, "application");
const BACKEND_ENV = path.join(APP_ROOT, "backend", ".env");
const FRONTEND_ENV = path.join(APP_ROOT, "frontend", ".env");
const LOCK_PATH = path.join(APP_ROOT, "backend", ".elytra", "dev-instance.json");

/** Ports used by older dev clones or manual overrides — always cleared. */
const STALE_PORTS = [8787, 8788, 5173, 5174];

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function portsToClear() {
  const backendEnv = parseEnvFile(BACKEND_ENV);
  const frontendEnv = parseEnvFile(FRONTEND_ENV);
  const backendPort = Number(backendEnv.PORT || 8787);
  const frontendPort = Number(frontendEnv.VITE_DEV_PORT || 5173);
  return [...new Set([...STALE_PORTS, backendPort, frontendPort].filter(Number.isFinite))];
}

function pidsListeningOnPort(port) {
  if (process.platform === "win32") {
    try {
      const out = execSync("netstat -ano", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const pids = new Set();
      const portRe = new RegExp(`[:\\[]${port}\\s`);
      for (const line of out.split(/\r?\n/)) {
        if (!portRe.test(line) || !/\sLISTENING\s/i.test(line)) continue;
        const pid = Number(line.trim().split(/\s+/).at(-1));
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    } catch {
      return [];
    }
  }

  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .trim()
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function killPid(pid, { tree = false } = {}) {
  if (!pid || pid === process.pid) return false;
  try {
    if (process.platform === "win32") {
      const flag = tree ? "/T" : "";
      execSync(`taskkill /F ${flag} /PID ${pid}`, { stdio: "ignore" });
    } else {
      process.kill(pid, tree ? "SIGKILL" : "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

function killPort(port) {
  const killed = [];
  for (const pid of pidsListeningOnPort(port)) {
    if (killPid(pid, { tree: true })) killed.push({ port, pid });
  }
  return killed;
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

function stopPreviousDevTree() {
  const lock = readLock();
  if (!lock?.rootPid) return [];
  if (lock.rootPid === process.pid) return [];
  const ok = killPid(lock.rootPid, { tree: true });
  return ok ? [{ rootPid: lock.rootPid }] : [];
}

function writeLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.writeFileSync(
    LOCK_PATH,
    JSON.stringify(
      {
        rootPid: process.ppid,
        npmPid: process.pid,
        startedAt: new Date().toISOString(),
        ports: portsToClear(),
      },
      null,
      2,
    ),
  );
}

function main() {
  const stopped = stopPreviousDevTree();
  const killed = [];
  for (const port of portsToClear()) {
    killed.push(...killPort(port));
  }

  if (stopped.length || killed.length) {
    console.log("[elytra] Stopped previous dev instance(s):");
    for (const entry of stopped) {
      console.log(`  - prior dev tree (root PID ${entry.rootPid})`);
    }
    for (const entry of killed) {
      console.log(`  - PID ${entry.pid} on port ${entry.port}`);
    }
    // Brief pause so the OS releases sockets before we bind again.
    if (process.platform === "win32") {
      try {
        execSync("ping -n 2 127.0.0.1 > nul", { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    } else {
      execSync("sleep 0.5");
    }
  }

  writeLock();
}

main();
