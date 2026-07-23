import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { appConfig, ensureEnvFile, ENV_FILE_PATH, reloadEnv } from "./config.js";
import { pickProjectFolderNative } from "./folderPicker.js";
import { readRecentProjects, upsertRecentProject, removeRecentProject } from "./recentProjectsStore.js";
import { listProjects, loadProject, projectForClient, validateProjectFolder } from "./projectStore.js";
import { readSessionState, writeSessionState, clearSessionState } from "./sessionStore.js";
import { SimTarget } from "./simTarget.js";
import { SshTarget } from "./sshTarget.js";
import { validateMissionFilename, validateMissionYaml } from "./missionValidation.js";
import { fetchViewFrame } from "./rosViewBridge.js";

ensureEnvFile();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const idleProgress = () => ({ percent: 0, step: "Idle", detail: "Waiting to start.", complete: false });

const session = {
  projectId: appConfig().defaultProjectId,
  openProjectRoot: "",
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
  dockerBuildProgress: idleProgress(),
  simSetupProgress: idleProgress(),
  missionStartupProgress: idleProgress(),
  lastTmuxLog: "",
  movementMode: { realtime: false, navigationMode: "nav2" },
  explorationPolicy: {
    dfsPreferHighest: true,
    parentToNearestNode: true,
  },
};

const progress = {
  update(key, percent, step, detail, complete = false, extra = {}) {
    session[key] = { percent, step, detail, complete, ...extra };
  },
};

function normalizeMode(mode) {
  return mode === "sim" ? "sim" : "physical";
}

function normalizeProjectPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function statusPayload() {
  return {
    projectId: session.projectId,
    openProjectRoot: session.openProjectRoot || "",
    projectName: session.project?.name || session.projectId,
    connectedProject: session.sshConnected && session.project ? projectForClient(session.project) : null,
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
    dockerBuildProgress: session.dockerBuildProgress,
    simSetupProgress: session.simSetupProgress,
    missionStartupProgress: session.missionStartupProgress,
    movementMode: session.movementMode,
    explorationPolicy: session.explorationPolicy,
  };
}

async function setTarget(projectId, mode, password = "", openProjectRoot = "") {
  const selectedMode = normalizeMode(mode);
  const rootOpt = String(openProjectRoot ?? "").trim();
  const project = await loadProject(projectId || session.projectId, {
    mode: selectedMode,
    ...(rootOpt ? { projectRoot: rootOpt } : {}),
  });
  const modeConfig = project.modes[selectedMode];
  await session.target?.disconnect?.();

  session.projectId = project.id;
  session.openProjectRoot = project.openProjectRoot || "";
  session.project = project;
  session.mode = selectedMode;
  session.target = selectedMode === "sim" ? new SimTarget(modeConfig, progress) : new SshTarget(modeConfig);
  session.connectionState = "connecting";
  session.sshConnected = false;
  session.lastError = "";
  session.connectTrace = [`Selected ${project.name || project.id} (${selectedMode}).`];
  if (project.modeEnvLoaded) {
    session.connectTrace.push(`Loaded project env: ${project.modeEnvPath}`);
  }
  session.dockerBuildProgress = selectedMode === "sim"
    ? { percent: 0, step: "Queued", detail: "Waiting for Docker Compose build.", complete: false, count: 0, total: 0 }
    : idleProgress();
  session.simSetupProgress = selectedMode === "sim"
    ? { percent: 5, step: "Queued", detail: "Preparing simulation.", complete: false }
    : idleProgress();

  try {
    await session.target.connect(password);
    session.sshConnected = true;
    session.connectionState = "connected_idle";
    session.connectTrace.push(selectedMode === "sim" ? "Docker simulation connected." : "SSH connection established.");
    if (selectedMode === "sim" && session.target.writeViewsConfig) {
      await session.target.writeViewsConfig(project.views || []);
      session.connectTrace.push("Wrote simulation view config to container.");
    }
    await writeSessionState({ projectId: project.id, projectRoot: session.openProjectRoot, mode: selectedMode }).catch(() => {});
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

async function persistSessionState() {
  if (!session.projectId) return;
  await writeSessionState({
    projectId: session.projectId,
    projectRoot: session.openProjectRoot,
    mode: session.mode,
    inFlight: session.inFlight,
    runMode: session.runMode,
  }).catch(() => {});
}

/** Sync inFlight with the target (tmux script probe). Fixes UI after backend restart. */
async function reconcileInFlightFromTarget() {
  if (!session.target || !session.sshConnected) return;
  if (typeof session.target.isScriptRunning !== "function") return;
  const running = await session.target.isScriptRunning();
  if (running && !session.inFlight) {
    session.inFlight = true;
    session.runMode = session.runMode || "reconciled";
    session.connectionState = "reconnected_in_flight";
    await persistSessionState();
  } else if (!running && session.inFlight) {
    session.inFlight = false;
    session.runMode = null;
    session.connectionState = "connected_idle";
    await persistSessionState();
  }
}

function requireConnected() {
  if (!session.target || !session.sshConnected) {
    throw new Error("Connect to a project target before running this action.");
  }
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
    await persistSessionState();
    return { state: statusPayload() };
  }

  // Fast path: unix-socket teleop inside the sim (no ROS CLI / oneshot script).
  const teleopDirection = String(action.teleopDirection || "").trim();
  if (action.kind === "teleop" || teleopDirection) {
    if (typeof session.target.teleopStep !== "function") {
      throw new Error("Teleop is only available in sim mode.");
    }
    const direction = teleopDirection || String(action.extraArgs || "").trim();
    const { stdout, stderr } = await session.target.teleopStep(direction);
    return { state: statusPayload(), output: stdout, stderr };
  }

  const modeConfig = session.project.modes[session.mode];
  const scriptPath = actionScriptPath(action, modeConfig);
  if (!scriptPath) throw new Error(`Action ${actionId} has no script path for ${session.mode} mode.`);
  const remoteMissionPath = action.requiresMission ? body.remoteMissionPath || session.savedMissionPath : body.remoteMissionPath || "";
  if (action.requiresMission && !remoteMissionPath) {
    throw new Error("Save a mission before running this action.");
  }

  if (action.oneshot) {
    session.missionStartupProgress = { percent: 10, step: "Running", detail: `Executing ${action.label}.`, complete: false };
    const { stdout, stderr } = await session.target.runOneShotScript(scriptPath, { extraArgs: action.extraArgs || "" });
    session.missionStartupProgress = {
      percent: 100,
      step: "Done",
      detail: (stdout || stderr || `${action.label} finished.`).trim().slice(-400),
      complete: true,
    };
    await persistSessionState();
    return { state: statusPayload(), output: stdout, stderr };
  }

  session.missionStartupProgress = { percent: 10, step: "Starting", detail: `Launching ${action.label}.`, complete: false };
  if (session.mode === "sim" && session.target?.writeViewsConfig) {
    await session.target.writeViewsConfig(session.project.views || []);
  }
  await session.target.runScript(scriptPath, { remoteMissionPath, extraArgs: action.extraArgs || "" });
  session.inFlight = true;
  session.runMode = action.runMode || action.id;
  session.connectionState = "reconnected_in_flight";
  session.missionStartupProgress = { percent: 100, step: "Started", detail: `${action.label} started in tmux.`, complete: true };
  await persistSessionState();
  return { state: statusPayload() };
}

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((error) => {
      res.status(500).json({ error: error.message, state: statusPayload() });
    });
  };
}

app.get("/", (_req, res) => {
  const apiPort = appConfig().port;
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Elytra Bridge API</title></head>
<body>
  <p>This URL is the <strong>API only</strong> (port ${apiPort}). There is no SPA here; that is why you would see “Cannot GET /” without this page.</p>
  <p><strong>Operator UI (dev):</strong> open <a href="http://localhost:5173">http://localhost:5173</a> — Vite serves the React app when you run <code>npm run dev</code> from <code>application/</code>.</p>
  <p><a href="/health">GET /health</a> — API check</p>
</body>
</html>`);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "elytra-bridge", version: "0.1.0" });
});

app.get("/projects", asyncRoute(async (_req, res) => {
  const bundled = await listProjects();
  const recentProjects = await readRecentProjects();
  res.json({
    projects: bundled,
    recentProjects,
    defaultProjectId: appConfig().defaultProjectId,
  });
}));

async function openValidatedProjectFolder(rawRoot) {
  const validation = await validateProjectFolder(rawRoot);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }
  const descriptorId = (validation.descriptor && validation.descriptor.id) || path.basename(validation.root);
  const project = await loadProject(descriptorId, { projectRoot: validation.root });
  const recentProjects = await upsertRecentProject({
    root: validation.root,
    descriptorId: project.id,
    name: project.name || project.id,
    warnings: validation.warnings,
  });
  return {
    ok: true,
    project,
    warnings: validation.warnings,
    recentProjects,
  };
}

app.post("/projects/open-dialog", asyncRoute(async (_req, res) => {
  const picked = await pickProjectFolderNative();
  if (!picked) {
    res.status(400).json({ error: "Folder dialog cancelled or unavailable on this OS." });
    return;
  }
  const result = await openValidatedProjectFolder(picked);
  if (!result.ok) {
    res.status(400).json({
      error: result.errors.join(" "),
      errors: result.errors,
      warnings: result.warnings,
    });
    return;
  }
  res.json({
    project: projectForClient(result.project),
    openProjectRoot: result.project.openProjectRoot || "",
    warnings: result.warnings,
    recentProjects: result.recentProjects,
  });
}));

app.post("/projects/open-path", asyncRoute(async (req, res) => {
  const rawRoot = String(req.body?.projectRoot ?? "").trim();
  if (!rawRoot) {
    res.status(400).json({ error: "projectRoot is required in JSON body." });
    return;
  }
  const result = await openValidatedProjectFolder(rawRoot);
  if (!result.ok) {
    res.status(400).json({
      error: result.errors.join(" "),
      errors: result.errors,
      warnings: result.warnings,
    });
    return;
  }
  res.json({
    project: projectForClient(result.project),
    openProjectRoot: result.project.openProjectRoot || "",
    warnings: result.warnings,
    recentProjects: result.recentProjects,
  });
}));

app.delete("/projects/recent", asyncRoute(async (req, res) => {
  const rawRoot = String(req.body?.projectRoot ?? req.query?.projectRoot ?? "").trim();
  if (!rawRoot) {
    res.status(400).json({ error: "projectRoot is required." });
    return;
  }
  const recentProjects = await removeRecentProject(rawRoot);
  res.json({ recentProjects });
}));

app.get("/projects/:projectId", asyncRoute(async (req, res) => {
  const projectRoot = String(req.query.projectRoot ?? "").trim();
  const project = await loadProject(req.params.projectId, projectRoot ? { projectRoot } : {});
  res.json({
    project: projectForClient(project),
    openProjectRoot: project.openProjectRoot || "",
  });
}));

app.get("/mission/default", asyncRoute(async (req, res) => {
  const projectRoot = String(req.query.projectRoot ?? "").trim();
  const project = await loadProject(req.query.projectId || session.projectId, projectRoot ? { projectRoot } : {});
  res.json({
    filename: project.defaultMission?.filename || "mission_ui.yaml",
    yamlText: project.defaultMission?.yamlText || "mission:\n  steps: []\n",
  });
}));

app.get("/drone/prefill", asyncRoute(async (_req, res) => {
  const project = await loadProject(session.projectId, {
    mode: "physical",
    ...(session.openProjectRoot ? { projectRoot: session.openProjectRoot } : {}),
  });
  res.json({
    physicalSshPassword: project.modes.physical.sshPassword || "",
    simSshPassword: "",
  });
}));

app.get("/drone/status", asyncRoute(async (_req, res) => {
  await reconcileInFlightFromTarget();
  res.json(statusPayload());
}));

app.post("/drone/connect", asyncRoute(async (req, res) => {
  await setTarget(req.body.projectId, req.body.mode, req.body.password, req.body.projectRoot || "");
  res.json(statusPayload());
}));

app.post("/session/connect", asyncRoute(async (req, res) => {
  await setTarget(req.body.projectId, req.body.mode, req.body.password, req.body.projectRoot || "");
  res.json(statusPayload());
}));

app.post("/session/disconnect", asyncRoute(async (_req, res) => {
  if (session.mode === "sim" && session.project?.modes?.sim?.autoStopOnDisconnect) {
    await session.target?.shutdown?.();
  }
  await session.target?.disconnect?.();
  await clearSessionState().catch(() => {});
  session.target = null;
  session.sshConnected = false;
  session.inFlight = false;
  session.runMode = null;
  session.connectionState = "disconnected";
  res.json(statusPayload());
}));

app.post("/mission/save", asyncRoute(async (req, res) => {
  const fileValidation = validateMissionFilename(req.body.filename || "");
  if (!fileValidation.ok) throw new Error(fileValidation.message);
  const yamlValidation = validateMissionYaml(req.body.yamlText || "");
  if (!yamlValidation.ok) throw new Error(yamlValidation.message);

  requireConnected();
  const filename = fileValidation.filename;
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

app.post("/sim/reset", asyncRoute(async (_req, res) => {
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
  await clearSessionState().catch(() => {});
  session.sshConnected = false;
  session.inFlight = false;
  session.runMode = null;
  session.connectionState = "disconnected";
  res.json({ state: statusPayload() });
}));

app.post("/sim/shutdown", asyncRoute(async (_req, res) => {
  if (session.mode !== "sim" || !session.target) throw new Error("No simulation target is active.");
  await session.target.shutdown();
  await clearSessionState().catch(() => {});
  session.sshConnected = false;
  session.inFlight = false;
  session.runMode = null;
  session.connectionState = "disconnected";
  res.json({ state: statusPayload() });
}));

app.post("/sim/hotswap", asyncRoute(async (req, res) => {
  requireConnected();
  if (session.mode !== "sim") throw new Error("Simulation hotswap is only available in sim mode.");
  session.connectTrace = [`Simulation hotswap requested (branch=${req.body?.branch || "main"}).`];
  const result = await session.target.hotswapFromBranch(req.body?.branch || "main");
  session.connectTrace.push(`Fetched ${result.branch} and rebuilt the scoped ROS workspace in the sim container.`);
  await session.target.reset();
  session.inFlight = false;
  session.runMode = null;
  session.connectionState = "connected_idle";
  if (session.target?.diagnostics) {
    Object.assign(session, await session.target.diagnostics());
  }
  res.json({ ok: true, state: statusPayload() });
}));

app.post("/simulation/hotswap", asyncRoute(async (req, res) => {
  requireConnected();
  if (session.mode !== "sim") throw new Error("Simulation hotswap is only available in sim mode.");
  session.connectTrace = [`Simulation hotswap requested (branch=${req.body?.branch || "main"}).`];
  const result = await session.target.hotswapFromBranch(req.body?.branch || "main");
  session.connectTrace.push(`Fetched ${result.branch} and rebuilt the scoped ROS workspace in the sim container.`);
  await session.target.reset();
  session.inFlight = false;
  session.runMode = null;
  session.connectionState = "connected_idle";
  if (session.target?.diagnostics) {
    Object.assign(session, await session.target.diagnostics());
  }
  res.json({ ok: true, state: statusPayload() });
}));

app.get("/drone/tmux-log", asyncRoute(async (_req, res) => {
  requireConnected();
  const log = await session.target.captureLog();
  if (log.text?.trim()) {
    session.lastTmuxLog = log.text;
  } else if (session.lastTmuxLog) {
    log.text = session.lastTmuxLog;
    log.stale = true;
  }
  await reconcileInFlightFromTarget();
  res.json(log);
}));

function requireSimConnected() {
  requireConnected();
  if (session.mode !== "sim") {
    throw new Error("Simulation views are only available in sim mode.");
  }
}

app.get("/sim/views", asyncRoute(async (_req, res) => {
  requireSimConnected();
  const views = (session.project?.views || []).map((view) => ({
    id: view.id,
    label: view.label,
    type: view.type,
    primary: Boolean(view.primary),
  }));
  res.json({ views });
}));

app.get("/sim/views/:viewId/frame", asyncRoute(async (req, res) => {
  requireSimConnected();
  const viewId = String(req.params.viewId || "").trim();
  const views = session.project?.views || [];
  if (!views.some((view) => view.id === viewId)) {
    res.status(404).json({ error: `Unknown view: ${viewId}` });
    return;
  }
  if (typeof session.target.viewServerOrigin !== "function") {
    res.status(503).json({ error: "View server is not available for this target." });
    return;
  }
  const result = await fetchViewFrame(session.target.viewServerOrigin(), viewId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.message });
    return;
  }
  res.set("Content-Type", result.contentType);
  res.set("Cache-Control", "no-store");
  res.send(result.buffer);
}));

app.get("/sim/movement-mode", asyncRoute(async (_req, res) => {
  requireSimConnected();
  res.json({ movementMode: session.movementMode, state: statusPayload() });
}));

app.put("/sim/movement-mode", asyncRoute(async (req, res) => {
  requireSimConnected();
  const realtime = Boolean(req.body?.realtime);
  const navigationMode = req.body?.navigationMode === "discrete" ? "discrete" : "nav2";
  if (typeof session.target.setMovementMode === "function") {
    await session.target.setMovementMode({ realtime, navigationMode });
  }
  session.movementMode = { realtime, navigationMode };
  res.json({ ok: true, movementMode: session.movementMode, state: statusPayload() });
}));

app.get("/sim/exploration-policy", asyncRoute(async (_req, res) => {
  requireSimConnected();
  res.json({ explorationPolicy: session.explorationPolicy, state: statusPayload() });
}));

app.put("/sim/exploration-policy", asyncRoute(async (req, res) => {
  requireSimConnected();
  const dfsPreferHighest = req.body?.dfsPreferHighest !== undefined
    ? Boolean(req.body.dfsPreferHighest)
    : session.explorationPolicy.dfsPreferHighest;
  const parentToNearestNode = req.body?.parentToNearestNode !== undefined
    ? Boolean(req.body.parentToNearestNode)
    : session.explorationPolicy.parentToNearestNode;
  if (typeof session.target.setExplorationPolicy === "function") {
    await session.target.setExplorationPolicy({ dfsPreferHighest, parentToNearestNode });
  }
  session.explorationPolicy = { dfsPreferHighest, parentToNearestNode };
  res.json({ ok: true, explorationPolicy: session.explorationPolicy, state: statusPayload() });
}));

const envFields = [
  ["PORT", "Backend port", false],
  ["DRONE_HOST", "Physical host", false],
  ["DRONE_PORT", "Physical SSH port", false],
  ["DRONE_USER", "Physical user", false],
  ["DRONE_PRIVATE_KEY_PATH", "Physical private key path", false],
  ["DRONE_PRIVATE_KEY_PASSPHRASE", "Physical private key passphrase", true],
  ["DRONE_SSH_PASSWORD", "Physical SSH password", true],
  ["DRONE_START_SCRIPT_PATH", "Physical start script", false],
  ["DRONE_RECORDING_SCRIPT_PATH", "Physical recording script", false],
  ["DRONE_MISSION_DIR", "Physical mission directory", false],
  ["DRONE_ROS_INSTALL", "Physical ROS install setup", false],
  ["DRONE_TMUX_SESSION", "Physical tmux session", false],
  ["DRONE_TMUX_CAPTURE_LINES", "Physical tmux capture lines", false],
  ["DRONE_TMUX_STOP_GRACE_SECONDS", "Physical stop grace seconds", false],
  ["DRONE_MISSION_EXTRA_ARGS", "Physical mission extra args", false],
  ["SIM_COMPOSE_FILE", "Simulation compose file", false],
  ["SIM_COMPOSE_PROJECT", "Simulation compose project", false],
  ["SIM_COMPOSE_SERVICE", "Simulation compose service", false],
  ["SIM_CONTAINER_NAME", "Simulation container name", false],
  ["SIM_USER", "Simulation container user", false],
  ["SIM_NOVNC_ORIGIN", "Simulation noVNC URL", false],
  ["SIM_DRONE_START_SCRIPT_PATH", "Simulation start script", false],
  ["SIM_DRONE_RECORDING_SCRIPT_PATH", "Simulation recording script", false],
  ["SIM_DRONE_MISSION_DIR", "Simulation mission directory", false],
  ["SIM_DRONE_ROS_INSTALL", "Simulation ROS install setup", false],
  ["SIM_DRONE_TMUX_SESSION", "Simulation tmux session", false],
  ["SIM_DRONE_TMUX_CAPTURE_LINES", "Simulation tmux capture lines", false],
  ["SIM_DRONE_TMUX_STOP_GRACE_SECONDS", "Simulation stop grace seconds", false],
  ["SIM_DRONE_MISSION_EXTRA_ARGS", "Simulation mission extra args", false],
  ["SIM_AUTOSTOP_ON_DISCONNECT", "Auto-stop sim on disconnect", false],
  ["VLM_BACKEND", "VLM backend (local or gemini)", false],
  ["VLM_OLLAMA_URL", "Ollama base URL for local VLM", false],
  ["VLM_LOCAL_MODEL", "Ollama model tag for local VLM", false],
  ["VLM_LOCAL_MAX_EDGE", "Max image edge (px) for local VLM", false],
  ["VLM_LOCAL_TIMEOUT_S", "Local VLM HTTP timeout (seconds)", false],
  ["GEMINI_API_KEY", "Gemini API key (when VLM_BACKEND=gemini)", true],
  ["RECONNECT_BACKOFF_MS", "Reconnect backoff ms", false],
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

/**
 * Re-adopt a still-running simulation after a backend restart. Without this,
 * every restart (dev watch mode, crash) wipes the in-memory session and the UI
 * reverts to the default project even though the sim container is still up.
 */
async function restorePersistedSession() {
  const saved = await readSessionState();
  if (!saved || saved.mode !== "sim") return;
  try {
    const project = await loadProject(saved.projectId, {
      mode: "sim",
      ...(saved.projectRoot ? { projectRoot: saved.projectRoot } : {}),
    });
    const target = new SimTarget(project.modes.sim, progress);
    if (!(await target.isContainerRunning())) {
      await clearSessionState().catch(() => {});
      return;
    }
    session.projectId = project.id;
    session.openProjectRoot = project.openProjectRoot || "";
    session.project = project;
    session.mode = "sim";
    session.target = target;
    session.sshConnected = true;
    session.connectionState = "connected_idle";
    session.connectTrace = [
      `Re-adopted running simulation for ${project.name || project.id} after backend restart.`,
    ];
    progress.update("simSetupProgress", 100, "Connected", "Simulation container is available.", true);
    await reconcileInFlightFromTarget();
    console.log(`Re-adopted running sim session: ${project.id} (${project.modes.sim.containerName})`);
  } catch (error) {
    console.warn(`Could not re-adopt persisted session: ${error.message}`);
    await clearSessionState().catch(() => {});
  }
}

app.listen(appConfig().port, async () => {
  console.log(`Elytra Bridge backend listening on http://localhost:${appConfig().port}`);
  await restorePersistedSession();
});
