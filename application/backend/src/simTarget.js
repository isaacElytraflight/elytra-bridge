import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runFile, shellQuote, sleep } from "./shell.js";

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

  async connect() {
    if (!this.config.composeFile || !fs.existsSync(this.config.composeFile)) {
      throw new Error(`Simulation compose file not found: ${this.config.composeFile || "unset"}`);
    }
    this.progress.update("simSetupProgress", 10, "Checking Docker", "Starting Docker Compose simulation stack.");
    await runFile("docker", this.composeArgs(["up", "-d", "--build"]), { timeout: 1000 * 60 * 30 });
    this.progress.update("simSetupProgress", 80, "Inspecting container", "Waiting for the configured simulation container.");
    await runFile("docker", ["inspect", this.config.containerName], { timeout: 30000 });
    this.progress.update("simSetupProgress", 100, "Connected", "Simulation container is available.", true);
  }

  async disconnect() {}

  async exec(command) {
    const { stdout, stderr } = await runFile("docker", ["exec", this.config.containerName, "bash", "-lc", command], {
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
    const source = this.config.rosInstallSetupPath ? `source ${shellQuote(this.config.rosInstallSetupPath)} || true; ` : "";
    const mission = remoteMissionPath ? ` ${shellQuote(remoteMissionPath)}` : "";
    const args = extraArgs || this.config.missionExtraArgs || "";
    const command = `${source}export ELYTRA_TARGET=sim; export ELYTRA_ROS_DISTRO=jazzy; bash ${shellQuote(scriptPath)}${mission}${args ? ` ${args}` : ""}`;
    await this.exec(`tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`);
    await this.exec(`tmux new-session -d -s ${shellQuote(session)} ${shellQuote(`bash -lc ${shellQuote(command)}`)}`);
  }

  async stop() {
    const session = this.config.tmuxSession;
    await this.exec(`tmux send-keys -t ${shellQuote(session)} C-c 2>/dev/null || true`);
    await sleep(this.config.tmuxStopGraceSeconds * 1000);
    await this.exec(`tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`);
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
      const { stdout } = await this.exec(`tmux capture-pane -pt ${shellQuote(this.config.tmuxSession)} -S -${this.config.tmuxCaptureLines} 2>/dev/null || true`);
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
}
