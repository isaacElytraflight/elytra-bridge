import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { appConfig, envNumberFrom, envValueFrom, projectModeEnvPath, readEnvFile, resolvePath } from "./config.js";

const MODE_ENV_PREFIX = {
  physical: "DRONE",
  sim: "SIM_DRONE",
};

/**
 * Structural validation before opening a project folder from disk (bundled or arbitrary path).
 * @returns {{ ok: boolean, warnings: string[], errors: string[], root: string, descriptor: Record<string, unknown> }}
 */
export async function validateProjectFolder(projectRootInput) {
  const warnings = [];
  const errors = [];
  let root = "";
  try {
    root = path.resolve(String(projectRootInput || "").trim());
  } catch (error) {
    errors.push(`Invalid path: ${error.message}`);
    return { ok: false, warnings, errors, root: "", descriptor: {} };
  }

  if (!root) {
    errors.push("Project path is empty.");
    return { ok: false, warnings, errors, root: "", descriptor: {} };
  }

  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    errors.push("Project root does not exist.");
    return { ok: false, warnings, errors, root, descriptor: {} };
  }
  if (!stat.isDirectory()) {
    errors.push("Project root is not a directory.");
    return { ok: false, warnings, errors, root, descriptor: {} };
  }

  const yamlPath = path.join(root, "project.yaml");
  try {
    await fs.access(yamlPath);
  } catch {
    errors.push("Missing project.yaml");
    return { ok: false, warnings, errors, root, descriptor: {} };
  }

  for (const sub of ["real", "sim"]) {
    const p = path.join(root, sub);
    try {
      const st = await fs.stat(p);
      if (!st.isDirectory()) errors.push(`${sub}/ exists but is not a directory`);
    } catch {
      errors.push(`Missing required ${sub}/ directory`);
    }
  }

  for (const rel of ["real/.env.example", "sim/.env.example"]) {
    try {
      await fs.access(path.join(root, ...rel.split("/")));
    } catch {
      warnings.push(`Recommended template missing: ${rel}`);
    }
  }

  let descriptor = {};
  try {
    const text = await fs.readFile(yamlPath, "utf-8");
    descriptor = yaml.load(text) || {};
  } catch (error) {
    errors.push(`Could not parse project.yaml: ${error.message}`);
    return { ok: false, warnings, errors, root, descriptor: {} };
  }

  const simRaw = descriptor.sim || {};
  if (simRaw.composeFile) {
    const composeAbs = resolvePath(String(simRaw.composeFile).trim(), root);
    if (composeAbs) {
      try {
        await fs.access(composeAbs);
      } catch {
        warnings.push(`sim.composeFile not found at resolved path: ${composeAbs}`);
      }
    }
  }

  async function warnIfRelativeRepoMissing(label, rawPath) {
    if (!rawPath || typeof rawPath !== "string") return;
    const trimmed = rawPath.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) return;
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) return;
    const abs = resolvePath(trimmed, root);
    if (!abs) return;
    try {
      await fs.access(abs);
    } catch {
      warnings.push(`${label} not found under project root (${abs})`);
    }
  }

  await warnIfRelativeRepoMissing("real.privateKeyPath", descriptor.real?.privateKeyPath);

  return { ok: errors.length === 0, warnings, errors, root, descriptor };
}

export async function listProjects() {
  const { projectsDir } = appConfig();
  let entries = [];
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const project = await loadProject(entry.name);
      projects.push(toProjectSummary(project));
    } catch {
      // Ignore malformed folders in the MVP project list.
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadProject(projectId = appConfig().defaultProjectId, options = {}) {
  const explicitRootRaw = options.projectRoot ? String(options.projectRoot).trim() : "";
  const explicitRoot = explicitRootRaw ? path.resolve(explicitRootRaw) : "";

  let projectRoot;
  let descriptorPath;
  let fallbackId;

  if (explicitRoot) {
    projectRoot = explicitRoot;
    descriptorPath = path.join(projectRoot, "project.yaml");
    fallbackId = path.basename(projectRoot);
  } else {
    fallbackId = String(projectId || appConfig().defaultProjectId).replace(/[^a-zA-Z0-9_.-]/g, "");
    projectRoot = path.join(appConfig().projectsDir, fallbackId);
    descriptorPath = path.join(projectRoot, "project.yaml");
  }

  const text = await fs.readFile(descriptorPath, "utf-8");
  const descriptor = yaml.load(text) || {};
  const id = descriptor.id || fallbackId;
  const selectedMode = options.mode === "sim" ? "sim" : options.mode === "physical" ? "physical" : "";
  const physicalEnv = selectedMode === "physical" ? readEnvFile(projectModeEnvPath(projectRoot, "physical")) : {};
  const simEnv = selectedMode === "sim" ? readEnvFile(projectModeEnvPath(projectRoot, "sim")) : {};

  return {
    ...descriptor,
    id,
    root: projectRoot,
    openProjectRoot: explicitRoot ? projectRoot : "",
    descriptorPath,
    modeEnvPath: selectedMode ? projectModeEnvPath(projectRoot, selectedMode) : "",
    modeEnvLoaded: selectedMode ? Object.keys(selectedMode === "sim" ? simEnv : physicalEnv).length > 0 : false,
    modes: {
      physical: buildPhysicalConfig(descriptor, projectRoot, physicalEnv),
      sim: buildSimConfig(descriptor, projectRoot, simEnv),
    },
    buttons: Array.isArray(descriptor.buttons) ? descriptor.buttons : [],
  };
}

export function toProjectSummary(project) {
  return {
    id: project.id,
    name: project.name || project.id,
    robotType: project.robotType || "robot",
    rosDistro: project.ros?.distro || "jazzy",
    description: project.description || "",
  };
}

function buildCommonModeConfig(raw = {}, prefix, env = {}) {
  return {
    missionDir: envValueFrom(env, `${prefix}_MISSION_DIR`, raw.missionDir || ""),
    rosInstallSetupPath: envValueFrom(env, `${prefix}_ROS_INSTALL`, raw.rosInstallSetupPath || ""),
    tmuxSession: envValueFrom(env, `${prefix}_TMUX_SESSION`, raw.tmuxSession || "elytra_bridge"),
    tmuxCaptureLines: Math.max(100, envNumberFrom(env, `${prefix}_TMUX_CAPTURE_LINES`, raw.tmuxCaptureLines || 2500)),
    tmuxStopGraceSeconds: Math.max(0, envNumberFrom(env, `${prefix}_TMUX_STOP_GRACE_SECONDS`, raw.tmuxStopGraceSeconds || 20)),
    missionExtraArgs: envValueFrom(env, `${prefix}_MISSION_EXTRA_ARGS`, raw.missionExtraArgs || ""),
    startScriptPath: envValueFrom(env, `${prefix}_START_SCRIPT_PATH`, raw.startScriptPath || ""),
    recordingScriptPath: envValueFrom(env, `${prefix}_RECORDING_SCRIPT_PATH`, raw.recordingScriptPath || ""),
    actions: raw.actions || {},
  };
}

function buildPhysicalConfig(descriptor, projectRoot, env = {}) {
  const raw = descriptor.real || {};
  const common = buildCommonModeConfig(raw, MODE_ENV_PREFIX.physical, env);
  return {
    ...common,
    mode: "physical",
    host: envValueFrom(env, "DRONE_HOST", raw.host || ""),
    port: envNumberFrom(env, "DRONE_PORT", raw.port || 22),
    user: envValueFrom(env, "DRONE_USER", raw.user || ""),
    privateKeyPath: resolvePath(envValueFrom(env, "DRONE_PRIVATE_KEY_PATH", raw.privateKeyPath || ""), projectRoot),
    privateKeyPassphrase: envValueFrom(env, "DRONE_PRIVATE_KEY_PASSPHRASE", raw.privateKeyPassphrase || ""),
    sshPassword: envValueFrom(env, "DRONE_SSH_PASSWORD", raw.sshPassword || ""),
    novncOrigin: "",
  };
}

function buildSimConfig(descriptor, projectRoot, env = {}) {
  const raw = descriptor.sim || {};
  const common = buildCommonModeConfig(raw, MODE_ENV_PREFIX.sim, env);
  return {
    ...common,
    mode: "sim",
    composeFile: resolvePath(envValueFrom(env, "SIM_COMPOSE_FILE", raw.composeFile || ""), projectRoot),
    composeProject: envValueFrom(env, "SIM_COMPOSE_PROJECT", raw.composeProject || ""),
    composeService: envValueFrom(env, "SIM_COMPOSE_SERVICE", raw.composeService || "sim"),
    containerName: envValueFrom(env, "SIM_CONTAINER_NAME", raw.containerName || ""),
    // Container user for docker exec. Empty means the container's default user
    // (e.g. root); "sim" preserved as drone-2026's convention via project.yaml.
    user: envValueFrom(env, "SIM_USER", raw.user || ""),
    novncOrigin: envValueFrom(env, "SIM_NOVNC_ORIGIN", raw.novncOrigin || ""),
    autoStopOnDisconnect: envValueFrom(env, "SIM_AUTOSTOP_ON_DISCONNECT", raw.autoStopOnDisconnect ? "1" : "0") === "1",
  };
}

export function projectForClient(project) {
  return {
    id: project.id,
    name: project.name || project.id,
    description: project.description || "",
    robotType: project.robotType || "robot",
    ros: project.ros || { distro: "jazzy" },
    defaultMission: project.defaultMission || {},
    buttons: project.buttons.map((button) => ({
      id: button.id,
      label: button.label,
      kind: button.kind || "script",
      description: button.description || "",
      requiresMission: Boolean(button.requiresMission),
      stopAction: Boolean(button.stopAction),
    })),
  };
}
