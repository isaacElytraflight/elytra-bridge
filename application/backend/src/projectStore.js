import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { appConfig, envNumber, envValue, resolvePath } from "./config.js";

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

export async function loadProject(projectId = appConfig().defaultProjectId) {
  const safeId = String(projectId || appConfig().defaultProjectId).replace(/[^a-zA-Z0-9_.-]/g, "");
  const projectRoot = path.join(appConfig().projectsDir, safeId);
  const descriptorPath = path.join(projectRoot, "project.yaml");
  const text = await fs.readFile(descriptorPath, "utf-8");
  const descriptor = yaml.load(text) || {};
  const id = descriptor.id || safeId;

  return {
    ...descriptor,
    id,
    root: projectRoot,
    descriptorPath,
    modes: {
      physical: buildPhysicalConfig(descriptor, projectRoot),
      sim: buildSimConfig(descriptor, projectRoot),
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

function buildCommonModeConfig(raw = {}, prefix) {
  return {
    missionDir: envValue(`${prefix}_MISSION_DIR`, raw.missionDir || ""),
    rosInstallSetupPath: envValue(`${prefix}_ROS_INSTALL`, raw.rosInstallSetupPath || ""),
    tmuxSession: envValue(`${prefix}_TMUX_SESSION`, raw.tmuxSession || "elytra_bridge"),
    tmuxCaptureLines: Math.max(100, envNumber(`${prefix}_TMUX_CAPTURE_LINES`, raw.tmuxCaptureLines || 2500)),
    tmuxStopGraceSeconds: Math.max(0, envNumber(`${prefix}_TMUX_STOP_GRACE_SECONDS`, raw.tmuxStopGraceSeconds || 20)),
    missionExtraArgs: envValue(`${prefix}_MISSION_EXTRA_ARGS`, raw.missionExtraArgs || ""),
    startScriptPath: envValue(`${prefix}_START_SCRIPT_PATH`, raw.startScriptPath || ""),
    recordingScriptPath: envValue(`${prefix}_RECORDING_SCRIPT_PATH`, raw.recordingScriptPath || ""),
    actions: raw.actions || {},
  };
}

function buildPhysicalConfig(descriptor, projectRoot) {
  const raw = descriptor.real || {};
  const common = buildCommonModeConfig(raw, MODE_ENV_PREFIX.physical);
  return {
    ...common,
    mode: "physical",
    host: envValue("DRONE_HOST", raw.host || ""),
    port: envNumber("DRONE_PORT", raw.port || 22),
    user: envValue("DRONE_USER", raw.user || ""),
    privateKeyPath: resolvePath(envValue("DRONE_PRIVATE_KEY_PATH", raw.privateKeyPath || ""), projectRoot),
    privateKeyPassphrase: envValue("DRONE_PRIVATE_KEY_PASSPHRASE", raw.privateKeyPassphrase || ""),
    sshPassword: envValue("DRONE_SSH_PASSWORD", raw.sshPassword || ""),
    novncOrigin: "",
  };
}

function buildSimConfig(descriptor, projectRoot) {
  const raw = descriptor.sim || {};
  const common = buildCommonModeConfig(raw, MODE_ENV_PREFIX.sim);
  return {
    ...common,
    mode: "sim",
    composeFile: resolvePath(envValue("SIM_COMPOSE_FILE", raw.composeFile || ""), projectRoot),
    composeProject: envValue("SIM_COMPOSE_PROJECT", raw.composeProject || ""),
    containerName: envValue("SIM_CONTAINER_NAME", raw.containerName || ""),
    novncOrigin: envValue("SIM_NOVNC_ORIGIN", raw.novncOrigin || ""),
    autoStopOnDisconnect: envValue("SIM_AUTOSTOP_ON_DISCONNECT", raw.autoStopOnDisconnect ? "1" : "0") === "1",
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
