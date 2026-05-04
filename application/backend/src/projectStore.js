import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { appConfig, envNumberFrom, envValueFrom, projectModeEnvPath, readEnvFile, resolvePath } from "./config.js";

const MODE_ENV_PREFIX = {
  physical: "DRONE",
  sim: "SIM_DRONE",
};

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
  const safeId = String(projectId || appConfig().defaultProjectId).replace(/[^a-zA-Z0-9_.-]/g, "");
  const projectRoot = path.join(appConfig().projectsDir, safeId);
  const descriptorPath = path.join(projectRoot, "project.yaml");
  const text = await fs.readFile(descriptorPath, "utf-8");
  const descriptor = yaml.load(text) || {};
  const id = descriptor.id || safeId;
  const selectedMode = options.mode === "sim" ? "sim" : options.mode === "physical" ? "physical" : "";
  const physicalEnv = selectedMode === "physical" ? readEnvFile(projectModeEnvPath(projectRoot, "physical")) : {};
  const simEnv = selectedMode === "sim" ? readEnvFile(projectModeEnvPath(projectRoot, "sim")) : {};

  return {
    ...descriptor,
    id,
    root: projectRoot,
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
    containerName: envValueFrom(env, "SIM_CONTAINER_NAME", raw.containerName || ""),
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
