import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runFile, runFileStream, shellQuote, sleep } from "./shell.js";

const HOTSWAP_REMOTE_REPO_URL = "https://github.com/UAVs-at-Berkeley/drone-2026.git";
const HOTSWAP_DEFAULT_BRANCH = "main";
const HOTSWAP_SYNC_ENTRIES = [
  { source: "ros_workspace/src/uav_mission", target: "ros_workspace/src/uav_mission" },
  { source: "ros_workspace/src/uav_msgs", target: "ros_workspace/src/uav_msgs" },
  { source: "start_drone.sh", target: "buttons/scripts/start_drone.sh" },
  { source: "start_recording.sh", target: "buttons/scripts/start_recording.sh" },
  { source: "start_mission_stack.sh", target: "buttons/scripts/start_mission_stack.sh" },
  { source: "start_ros.sh", target: "buttons/scripts/start_ros.sh" },
];
const HOTSWAP_SOURCE_RELATIVE_PATHS = HOTSWAP_SYNC_ENTRIES.map((entry) => entry.source);

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function parseBuildKitStep(text) {
  const clean = stripAnsi(text).replace(/\s+/g, " ").trim();
  const match = clean.match(/^(?:=>\s*)?(?:CACHED\s+|DONE\s+|ERROR\s+)?\[([A-Za-z][^\]]*?\s+(\d+)\s*\/\s*(\d+))\]/);
  if (!match) return null;
  const count = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0) return null;
  return {
    label: match[1].replace(/\s+/g, " ").trim(),
    count,
    total,
    percent: Math.round((count / total) * 100),
    line: clean,
  };
}

function safeLockName(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return {};
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function serviceImage(composeText, serviceName, fallback) {
  const servicePattern = new RegExp(`^\\s{2}${serviceName}:\\s*$([\\s\\S]*?)(?=^\\s{2}[A-Za-z0-9_-]+:\\s*$|\\s*$)`, "m");
  const serviceMatch = composeText.match(servicePattern);
  const imageMatch = serviceMatch?.[1]?.match(/^\s{4}image:\s*(\S+)\s*$/m);
  return imageMatch?.[1] || fallback;
}

function isSafeGitBranchName(input) {
  if (typeof input !== "string") return false;
  const branch = input.trim();
  if (!branch || branch.length > 120) return false;
  if (branch.startsWith("-") || branch.includes("..") || branch.includes("//")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(branch);
}

export class SimTarget {
  constructor(config, progress) {
    this.config = config;
    this.progress = progress;
  }

  composeArgs(args) {
    const result = ["compose"];
    if (this.config.composeFile) result.push("-f", this.config.composeFile);
    if (this.config.composeProject) result.push("-p", this.config.composeProject);
    return result.concat(args);
  }

  composeProfileArgs(profile, args) {
    const result = ["compose", "--profile", profile];
    if (this.config.composeFile) result.push("-f", this.config.composeFile);
    if (this.config.composeProject) result.push("-p", this.config.composeProject);
    return result.concat(args);
  }

  buildLockPath() {
    return path.join(os.tmpdir(), `elytra-${safeLockName(this.config.composeProject || this.config.containerName)}-docker-build.lock`);
  }

  async imageExists(imageName) {
    if (!imageName) return false;
    try {
      await runFile("docker", ["image", "inspect", imageName], { timeout: 30000 });
      return true;
    } catch {
      return false;
    }
  }

  async acquireBuildLock() {
    const lockPath = this.buildLockPath();
    const staleAfterMs = 1000 * 60 * 60 * 3;
    const startedAt = Date.now();
    let waitedForActiveBuild = false;

    while (true) {
      if (waitedForActiveBuild && !fs.existsSync(lockPath)) {
        return { acquired: false, lockPath };
      }

      try {
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        fs.closeSync(fd);
        return { acquired: true, lockPath };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = readLockOwner(lockPath);
        if (owner.pid && !processIsAlive(owner.pid)) {
          fs.unlinkSync(lockPath);
          continue;
        }

        const waitSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const ownerText = owner.pid ? ` PID ${owner.pid}` : "";
        this.progress.update("dockerBuildProgress", 0, "Waiting for Docker build", `Another Elytra backend${ownerText} is already building these images. Waiting ${waitSeconds}s.`, false, {
          count: 0,
          total: 0,
        });

        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleAfterMs) {
            fs.unlinkSync(lockPath);
            waitedForActiveBuild = false;
            continue;
          }
        } catch (statError) {
          if (statError.code === "ENOENT") {
            return { acquired: false, lockPath };
          }
          throw statError;
        }

        waitedForActiveBuild = true;
        await sleep(2000);
      }
    }
  }

  async prebuildComposeImages() {
    if (!this.config.composeFile || !fs.existsSync(this.config.composeFile)) return;
    const lock = await this.acquireBuildLock();
    if (!lock.acquired) {
      this.progress.update("dockerBuildProgress", 100, "Build already completed", "Another Elytra backend finished the Docker Compose build.", true, {
        count: 0,
        total: 0,
      });
      return;
    }
    try {
      await this.runPrebuildComposeImages();
    } finally {
      if (lock.acquired) {
        try {
          fs.unlinkSync(lock.lockPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }

  async runPrebuildComposeImages() {
    const composeText = fs.readFileSync(this.config.composeFile, "utf8");
    const steps = [];
    if (composeText.includes("simulator-base:")) {
      const simulatorImage = serviceImage(composeText, "simulator-base", "drone-2026-simulator:local");
      steps.push({
        label: "simulator-base",
        image: simulatorImage,
        skipIfImageExists: true,
        detail: "Preparing PX4/Gazebo simulator base image.",
        args: this.composeProfileArgs("build", ["build", "--progress=plain", "simulator-base"]),
      });
    }
    steps.push({
      label: "sim",
      detail: "Building Drone 2026 robot image.",
      args: this.composeArgs(["build", "--progress=plain", "sim"]),
    });

    this.progress.update("dockerBuildProgress", 0, "Queued", "Docker Compose build queued.", false, {
      count: 0,
      total: 0,
    });

    for (const [index, step] of steps.entries()) {
      if (step.skipIfImageExists && await this.imageExists(step.image)) {
        this.progress.update("dockerBuildProgress", 100, `Using ${step.label}`, `${step.image} already exists; skipping base image rebuild.`, index === steps.length - 1, {
          count: 0,
          total: 0,
        });
        continue;
      }

      this.progress.update("dockerBuildProgress", 0, `Building ${step.label}`, step.detail, false, {
        count: 0,
        total: 0,
      });
      let outputBuffer = "";
      let lastParsed = null;
      await runFileStream("docker", step.args, {
        timeout: 1000 * 60 * 30,
        onOutput: (text) => {
          outputBuffer += text;
          const lines = outputBuffer.split(/\r?\n|\r/);
          outputBuffer = lines.pop() || "";
          for (const line of lines) {
            const parsed = parseBuildKitStep(line);
            if (!parsed) continue;
            lastParsed = parsed;
            this.progress.update("dockerBuildProgress", parsed.percent, parsed.label, parsed.line, parsed.count === parsed.total, {
              count: parsed.count,
              total: parsed.total,
            });
          }
        },
      });
      const tailParsed = parseBuildKitStep(outputBuffer);
      if (tailParsed) lastParsed = tailParsed;
      this.progress.update("dockerBuildProgress", 100, `Built ${step.label}`, "Docker Compose build target complete.", index === steps.length - 1, {
        count: lastParsed?.total || 0,
        total: lastParsed?.total || 0,
      });
    }
  }

  async connect() {
    if (!this.config.composeFile || !fs.existsSync(this.config.composeFile)) {
      throw new Error(`Simulation compose file not found: ${this.config.composeFile || "unset"}`);
    }
    this.progress.update("simSetupProgress", 10, "Checking Docker", "Starting Docker Compose simulation stack.");
    await this.prebuildComposeImages();
    this.progress.update("simSetupProgress", 55, "Starting container", "Starting Docker Compose simulation stack from prebuilt images.");
    await runFile("docker", this.composeArgs(["up", "-d"]), { timeout: 1000 * 60 * 30 });
    this.progress.update("simSetupProgress", 80, "Inspecting container", "Waiting for the configured simulation container.");
    await runFile("docker", ["inspect", this.config.containerName], { timeout: 30000 });
    this.progress.update("simSetupProgress", 100, "Connected", "Simulation container is available.", true);
  }

  async disconnect() {}

  async exec(command, { user = "" } = {}) {
    const args = ["exec"];
    if (user) args.push("-u", user);
    args.push(this.config.containerName, "bash", "-lc", command);
    const { stdout, stderr } = await runFile("docker", args, {
      timeout: 120000,
    });
    return { stdout, stderr };
  }

  async saveMission(filename, yamlText) {
    const localPath = path.join(os.tmpdir(), `elytra-${Date.now()}-${filename}`);
    fs.writeFileSync(localPath, yamlText, "utf8");
    const remotePath = `${this.config.missionDir.replace(/\/$/, "")}/${filename}`;
    await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(remotePath))}`);
    await runFile("docker", ["cp", localPath, `${this.config.containerName}:${remotePath}`], { timeout: 60000 });
    fs.unlinkSync(localPath);
    return remotePath;
  }

  async runScript(scriptPath, { remoteMissionPath = "", extraArgs = "" } = {}) {
    const session = this.config.tmuxSession;
    const simUser = this.config.user || "sim";
    const simHome = `/home/${simUser}`;
    const mission = remoteMissionPath ? ` ${shellQuote(remoteMissionPath)}` : "";
    const args = extraArgs || this.config.missionExtraArgs || "";
    const envExports = [
      ["HOME", simHome],
      ["USER", simUser],
      ["ELYTRA_TARGET", "sim"],
      ["ELYTRA_ROS_DISTRO", "jazzy"],
      ["DRONE_ROS_INSTALL", this.config.rosInstallSetupPath || `${simHome}/drone_workspace/drone-2026/ros_workspace/install/setup.bash`],
      ["DRONE_MISSION_EXTRA_ARGS", args],
      ["PASSIVE_CAMERA_EXTRA_ARGS", args],
      ["MAVROS_FCU_URL", "udp://:14540@"],
      ["BAG_DIR", `${simHome}/drone_workspace/bags`],
    ]
      .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
      .join(" ");
    const command = `${envExports} bash ${shellQuote(scriptPath)}${mission}${args ? ` ${args}` : ""}`;
    await this.exec(`tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`, { user: simUser });
    await this.exec(`tmux new-session -d -s ${shellQuote(session)} ${shellQuote(`bash -lc ${shellQuote(command)}`)}`, { user: simUser });
  }

  async stop() {
    const session = this.config.tmuxSession;
    await this.exec(`tmux send-keys -t ${shellQuote(session)} C-c 2>/dev/null || true`, { user: "sim" });
    await sleep(this.config.tmuxStopGraceSeconds * 1000);
    await this.exec(`tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`, { user: "sim" });
  }

  async reset() {
    await this.stop();
    if (this.config.composeFile) {
      await runFile("docker", this.composeArgs(["restart"]), { timeout: 120000 });
    }
  }

  async shutdown() {
    if (this.config.composeFile) {
      await runFile("docker", this.composeArgs(["down"]), { timeout: 120000 });
    }
  }

  async captureLog() {
    try {
      const { stdout } = await this.exec(`tmux capture-pane -pt ${shellQuote(this.config.tmuxSession)} -S -${this.config.tmuxCaptureLines} 2>/dev/null || true`, { user: "sim" });
      return { text: stdout, hasSession: Boolean(stdout) };
    } catch {
      return { text: "", hasSession: false };
    }
  }

  async diagnostics() {
    const out = {};
    try {
      out.composePs = (await runFile("docker", this.composeArgs(["ps", "--all"]), { timeout: 30000 })).stdout;
    } catch (error) {
      out.composePs = error.stderr || error.stdout || error.message;
    }
    try {
      out.composeLogsTail = (await runFile("docker", this.composeArgs(["logs", "--tail", "120"]), { timeout: 30000 })).stdout;
    } catch (error) {
      out.composeLogsTail = error.stderr || error.stdout || error.message;
    }
    return out;
  }

  async materializeHotswapBranch(branchInput = HOTSWAP_DEFAULT_BRANCH) {
    const branch = String(branchInput || HOTSWAP_DEFAULT_BRANCH).trim();
    if (!isSafeGitBranchName(branch)) throw new Error("Invalid branch name.");

    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "elytra-drone-hotswap-"));
    const repoRoot = path.join(tmpRoot, "repo");
    try {
      await runFile("git", [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        branch,
        "--single-branch",
        HOTSWAP_REMOTE_REPO_URL,
        repoRoot,
      ], { timeout: 300000 });
      await runFile("git", ["-C", repoRoot, "sparse-checkout", "set", "--no-cone", ...HOTSWAP_SOURCE_RELATIVE_PATHS], {
        timeout: 120000,
      });
      for (const relPath of HOTSWAP_SOURCE_RELATIVE_PATHS) {
        await fsp.access(path.join(repoRoot, relPath));
      }
      return { tmpRoot, repoRoot, branch, syncEntries: HOTSWAP_SYNC_ENTRIES };
    } catch (error) {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async hotswapFromBranch(branchInput = HOTSWAP_DEFAULT_BRANCH) {
    const upload = await this.materializeHotswapBranch(branchInput);
    try {
      await this.applyRepoToContainer(upload.repoRoot, upload.syncEntries);
      return upload;
    } finally {
      await fsp.rm(upload.tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  repoRootInContainer() {
    const missionDir = this.config.missionDir || "";
    if (missionDir.includes("/ros_workspace/")) return missionDir.split("/ros_workspace/")[0];
    const startScript = this.config.startScriptPath || "/home/sim/drone_workspace/drone-2026/buttons/scripts/start_drone.sh";
    return path.posix.dirname(path.posix.dirname(path.posix.dirname(startScript)));
  }

  async applyRepoToContainer(localRepoRoot, syncEntries = HOTSWAP_SYNC_ENTRIES) {
    const repoRootInContainer = this.repoRootInContainer();
    const rosWorkspace = `${repoRootInContainer}/ros_workspace`;
    const backupRoot = path.posix.join(repoRootInContainer, ".hotswap_backup");
    const simUser = "sim";

    const execAsRoot = async (script) => {
      await runFile("docker", ["exec", "-u", "root", this.config.containerName, "bash", "-lc", script], { timeout: 120000 });
    };

    const entries = [];
    for (const item of syncEntries) {
      const sourceRelPath = typeof item === "string" ? item : item.source;
      const targetRelPath = typeof item === "string" ? item : item.target;
      const sourcePath = path.join(localRepoRoot, sourceRelPath);
      const sourceStat = await fsp.lstat(sourcePath);
      const targetPath = path.posix.join(repoRootInContainer, targetRelPath);
      entries.push({
        relPath: targetRelPath,
        sourcePath,
        isDirectory: sourceStat.isDirectory(),
        targetPath,
        targetParent: path.posix.dirname(targetPath),
        stagingPath: `${targetPath}.new`,
        backupPath: path.posix.join(backupRoot, relPath),
      });
    }

    await execAsRoot([
      `rm -rf ${entries.flatMap((entry) => [entry.stagingPath, entry.backupPath]).map(shellQuote).join(" ")}`,
      `mkdir -p ${entries.flatMap((entry) => [entry.targetParent, path.posix.dirname(entry.backupPath)]).map(shellQuote).join(" ")}`,
    ].join(" && "));

    for (const entry of entries) {
      const sourceSpec = entry.isDirectory ? path.join(entry.sourcePath, ".") : entry.sourcePath;
      await runFile("docker", ["cp", sourceSpec, `${this.config.containerName}:${entry.stagingPath}`], { timeout: 120000 });
      await this.exec(`test ${entry.isDirectory ? "-d" : "-f"} ${shellQuote(entry.stagingPath)}`);
    }

    for (const entry of entries) {
      await execAsRoot(
        `if [ -e ${shellQuote(entry.targetPath)} ]; then mv ${shellQuote(entry.targetPath)} ${shellQuote(entry.backupPath)}; fi && mv ${shellQuote(entry.stagingPath)} ${shellQuote(entry.targetPath)}`
      );
      await execAsRoot(`chown -R ${shellQuote(`${simUser}:${simUser}`)} ${shellQuote(entry.targetPath)}`);
    }

    const startupScripts = ["start_drone.sh", "start_recording.sh", "start_mission_stack.sh", "start_ros.sh"]
      .map((name) => path.posix.join(repoRootInContainer, "buttons", "scripts", name));
    const normalizeScriptsPy =
      "import pathlib, stat\n" +
      `files = ${JSON.stringify(startupScripts)}\n` +
      "for item in files:\n" +
      "    p = pathlib.Path(item)\n" +
      "    if not p.exists() or not p.is_file():\n" +
      "        continue\n" +
      "    data = p.read_bytes().replace(b'\\r\\n', b'\\n').replace(b'\\r', b'\\n')\n" +
      "    p.write_bytes(data)\n" +
      "    p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)\n";
    await runFile("docker", ["exec", "-u", "root", this.config.containerName, "python3", "-c", normalizeScriptsPy], {
      timeout: 120000,
    });
    await execAsRoot(`chown ${shellQuote(`${simUser}:${simUser}`)} ${startupScripts.map(shellQuote).join(" ")}`);

    try {
      const source = this.config.rosInstallSetupPath
        ? `source ${shellQuote(this.config.rosInstallSetupPath)} || true; `
        : "source /opt/ros/jazzy/setup.bash; ";
      await this.exec(`${source}cd ${shellQuote(rosWorkspace)} && colcon build --symlink-install`);
      await execAsRoot(`rm -rf ${entries.map((entry) => shellQuote(entry.backupPath)).join(" ")}`);
    } catch (error) {
      for (const entry of entries) {
        await execAsRoot(
          `if [ -e ${shellQuote(entry.backupPath)} ]; then rm -rf ${shellQuote(entry.targetPath)} && mv ${shellQuote(entry.backupPath)} ${shellQuote(entry.targetPath)}; fi`
        ).catch(() => {});
      }
      throw new Error(`colcon build failed after hotswap: ${error.message}`);
    }
  }
}
