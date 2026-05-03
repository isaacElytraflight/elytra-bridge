import express from "express";
import cors from "cors";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { appConfig, ensureEnvFile, ENV_FILE_PATH, reloadEnv } from "./config.js";
import { listProjects, loadProject, projectForClient } from "./projectStore.js";
import { SimTarget } from "./simTarget.js";
import { SshTarget } from "./sshTarget.js";

ensureEnvFile();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const idleProgress = () => ({ percent: 0, step: "Idle", detail: "Waiting to start.", complete: false });

const session = {
  projectId: appConfig().defaultProjectId,
  project: null,
  mode: "physical",
  target: null,
  connectionState: "disconnected",
  sshConnected: false,
  inFlight: false,
  runMode: null,
  savedMissionPath: "",
  lastError: "",
  connectTrace: [],
  composePs: "",
  composeLogsTail: "",
  simSetupProgress: idleProgress(),
  missionStartupProgress: idleProgress(),
};

const progress = {
  update(key, percent, step, detail, complete = false) {
    session[key] = { percent, step, detail, complete };
  },
};

function normalizeMode(mode) {
  return mode === "sim" ? "sim" : "physical";
}

function statusPayload() {
  return {
    projectId: session.projectId,
    projectName: session.project?.name || session.projectId,
    connectionState: session.connectionState,
    sshConnected: session.sshConnected,
    inFlight: session.inFlight,
    runMode: session.runMode,
    mode: session.mode,
    savedMissionPath: session.savedMissionPath,
    lastError: session.lastError,
    connectTrace: session.connectTrace,
    composePs: session.composePs,
    composeLogsTail: session.composeLogsTail,
    simViewerUrl: session.mode === "sim" ? session.project?.modes?.sim?.novncOrigin || "" : "",
    droneTmuxSession: session.project?.modes?.[session.mode]?.tmuxSession || "elytra_bridge",
    simSetupProgress: session.simSetupProgress,
    missionStartupProgress: session.missionStartupProgress,
  };
}

async function setTarget(projectId, mode, password = "") {
  const project = await loadProject(projectId || session.projectId);
  const selectedMode = normalizeMode(mode);
  const modeConfig = project.modes[selectedMode];
  await session.target?.disconnect?.();

  session.projectId = project.id;
  session.project = project;
  session.mode = selectedMode;
  session.target = selectedMode === "sim" ? new SimTarget(modeConfig, progress) : new SshTarget(modeConfig);
  session.connectionState = "connecting";
  session.sshConnected = false;
  session.lastError = "";
  session.connectTrace = [`Selected ${project.name || project.id} (${selectedMode}).`];
  session.simSetupProgress = selectedMode === "sim"
    ? { percent: 5, step: "Queued", detail: "Preparing simulation.", complete: false }
    : idleProgress();

  try {
    await session.target.connect(password);
    session.sshConnected = true;
    session.connectionState = "connected_idle";
    session.connectTrace.push(selectedMode === "sim" ? "Docker simulation connected." : "SSH connection established.");
  } catch (error) {
    session.connectionState = "disconnected";
    session.sshConnected = false;
    session.lastError = error.message;
    session.connectTrace.push(error.message);
    if (selectedMode === "sim" && session.target?.diagnostics) {
      Object.assign(session, await session.target.diagnostics());
    }
    throw error;
  }
}

function requireConnected() {
  if (!session.target || !session.sshConnected) {
    throw new Error("Connect to a project target before running this action.");
  }
}

function safeFilename(filename) {
  const value = String(filename || "mission_ui.yaml").trim();
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_") || "mission_ui.yaml";
}

function actionScriptPath(action, modeConfig) {
  if (action.scriptPath) return action.scriptPath;
  if (action.scriptKey === "start") return modeConfig.startScriptPath;
  if (action.scriptKey === "recording") return modeConfig.recordingScriptPath;
  if (modeConfig.actions && action.id in modeConfig.actions) return modeConfig.actions[action.id];
  return "";
}

async function runProjectAction(actionId, body = {}) {
  requireConnected();
  const action = session.project.buttons.find((item) => item.id === actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);

  if (action.stopAction) {
    await session.target.stop();
    session.inFlight = false;
    session.runMode = null;
    session.connectionState = "connected_idle";
    return { state: statusPayload() };
  }

  const modeConfig = session.project.modes[session.mode];
  const scriptPath = actionScriptPath(action, modeConfig);
  if (!scriptPath) throw new Error(`Action ${actionId} has no script path for ${session.mode} mode.`);
  const remoteMissionPath = action.requiresMission ? body.remoteMissionPath || session.savedMissionPath : body.remoteMissionPath || "";
  if (action.requiresMission && !remoteMissionPath) {
    throw new Error("Save a mission before running this action.");
  }

  session.missionStartupProgress = { percent: 10, step: "Starting", detail: `Launching ${action.label}.`, complete: false };
  await session.target.runScript(scriptPath, { remoteMissionPath, extraArgs: action.extraArgs || "" });
  session.inFlight = true;
  session.runMode = action.runMode || action.id;
  session.connectionState = "reconnected_in_flight";
  session.missionStartupProgress = { percent: 100, step: "Started", detail: `${action.label} started in tmux.`, complete: true };
  return { state: statusPayload() };
}

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((error) => {
      res.status(500).json({ error: error.message, state: statusPayload() });
    });
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "elytra-bridge", version: "0.1.0" });
});

app.get("/projects", asyncRoute(async (_req, res) => {
  res.json({ projects: await listProjects(), defaultProjectId: appConfig().defaultProjectId });
}));

app.get("/projects/:projectId", asyncRoute(async (req, res) => {
  const project = await loadProject(req.params.projectId);
  res.json({ project: projectForClient(project) });
}));

app.get("/mission/default", asyncRoute(async (req, res) => {
  const project = await loadProject(req.query.projectId || session.projectId);
  res.json({
    filename: project.defaultMission?.filename || "mission_ui.yaml",
    yamlText: project.defaultMission?.yamlText || "mission:\n  steps: []\n",
  });
}));

app.get("/drone/prefill", asyncRoute(async (_req, res) => {
  const project = await loadProject(session.projectId);
  res.json({
    physicalSshPassword: project.modes.physical.sshPassword || "",
    simSshPassword: "",
  });
}));

app.get("/drone/status", (_req, res) => {
  res.json(statusPayload());
});

app.post("/drone/connect", asyncRoute(async (req, res) => {
  await setTarget(req.body.projectId, req.body.mode, req.body.password);
  res.json(statusPayload());
}));

app.post("/session/connect", asyncRoute(async (req, res) => {
  await setTarget(req.body.projectId, req.body.mode, req.body.password);
  res.json(statusPayload());
}));

app.post("/session/disconnect", asyncRoute(async (_req, res) => {
  if (session.mode === "sim" && session.project?.modes?.sim?.autoStopOnDisconnect) {
    await session.target?.shutdown?.();
  }
  await session.target?.disconnect?.();
  session.target = null;
  session.sshConnected = false;
  session.inFlight = false;
  session.runMode = null;
  session.connectionState = "disconnected";
  res.json(statusPayload());
}));

app.post("/mission/save", asyncRoute(async (req, res) => {
  requireConnected();
  const filename = safeFilename(req.body.filename);
  const yamlText = String(req.body.yamlText || "");
  const remotePath = await session.target.saveMission(filename, yamlText);
  session.savedMissionPath = remotePath;
  res.json({ remotePath, state: statusPayload() });
}));

app.post("/actions/:actionId/run", asyncRoute(async (req, res) => {
  res.json(await runProjectAction(req.params.actionId, req.body || {}));
}));

app.post("/flight/start", asyncRoute(async (req, res) => {
  res.json(await runProjectAction("takeoff", { remoteMissionPath: req.body.remoteMissionPath }));
}));

app.post("/flight/start-passive", asyncRoute(async (_req, res) => {
  res.json(await runProjectAction("passive-record", {}));
}));

app.post("/flight/stop", asyncRoute(async (_req, res) => {
  res.json(await runProjectAction("end-mission", {}));
}));

app.post("/simulation/reset", asyncRoute(async (_req, res) => {
  requireConnected();
  if (session.mode !== "sim") throw new Error("Simulation reset is only available in sim mode.");
  await session.target.reset();
  session.inFlight = false;
  session.runMode = null;
  session.connectionState = "connected_idle";
  res.json({ state: statusPayload() });
}));

app.post("/simulation/shutdown", asyncRoute(async (_req, res) => {
  if (session.mode !== "sim" || !session.target) throw new Error("No simulation target is active.");
  await session.target.shutdown();
  session.sshConnected = false;
  session.inFlight = false;
  session.runMode = null;
  session.connectionState = "disconnected";
  res.json({ state: statusPayload() });
}));

app.get("/drone/tmux-log", asyncRoute(async (_req, res) => {
  requireConnected();
  res.json(await session.target.captureLog());
}));

const envFields = [
  ["DRONE_HOST", "Physical host", false],
  ["DRONE_USER", "Physical user", false],
  ["DRONE_PRIVATE_KEY_PATH", "Physical private key path", false],
  ["DRONE_SSH_PASSWORD", "Physical SSH password", true],
  ["SIM_COMPOSE_FILE", "Simulation compose file", false],
  ["SIM_CONTAINER_NAME", "Simulation container name", false],
  ["SIM_NOVNC_ORIGIN", "Simulation noVNC URL", false],
];

app.get("/settings/env", (_req, res) => {
  const fields = envFields.map(([key, label, sensitive]) => ({
    key,
    label,
    sensitive,
    value: process.env[key] || "",
  }));
  res.json({ fields, notice: `Settings are stored in ${ENV_FILE_PATH}.` });
});

app.put("/settings/env", asyncRoute(async (req, res) => {
  ensureEnvFile();
  const allowed = new Set(envFields.map(([key]) => key));
  const updates = req.body || {};
  const current = fs.existsSync(ENV_FILE_PATH) ? await fsp.readFile(ENV_FILE_PATH, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !allowed.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]] ?? ""}`;
  });
  for (const key of allowed) {
    if (!seen.has(key) && key in updates) next.push(`${key}=${updates[key] ?? ""}`);
  }
  await fsp.writeFile(ENV_FILE_PATH, next.join("\n"), "utf8");
  reloadEnv();
  res.json({ message: "Saved backend .env." });
}));

app.listen(appConfig().port, () => {
  console.log(`Elytra Bridge backend listening on http://localhost:${appConfig().port}`);
});
