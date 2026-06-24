import fs from "node:fs";
import { Client } from "ssh2";
import { shellQuote, sleep, tmuxScriptRunningProbe } from "./shell.js";

function remoteDir(remotePath) {
  const idx = remotePath.lastIndexOf("/");
  return idx > 0 ? remotePath.slice(0, idx) : ".";
}

export class SshTarget {
  constructor(config) {
    this.config = config;
    this.client = null;
  }

  async connect(passwordOverride = "") {
    if (!this.config.host || !this.config.user) {
      throw new Error("Physical mode requires DRONE_HOST and DRONE_USER.");
    }
    await this.disconnect();
    const client = new Client();
    const connectionConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.user,
      readyTimeout: 20000,
    };
    if (this.config.privateKeyPath && fs.existsSync(this.config.privateKeyPath)) {
      connectionConfig.privateKey = fs.readFileSync(this.config.privateKeyPath);
      if (this.config.privateKeyPassphrase) {
        connectionConfig.passphrase = this.config.privateKeyPassphrase;
      }
    }
    const password = passwordOverride || this.config.sshPassword;
    if (password) connectionConfig.password = password;

    await new Promise((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", reject);
      client.connect(connectionConfig);
    });
    this.client = client;
  }

  async disconnect() {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  ensureConnected() {
    if (!this.client) throw new Error("SSH target is not connected.");
  }

  exec(command) {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        if (error) return reject(error);
        let stdout = "";
        let stderr = "";
        stream.on("close", (code) => {
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(stderr || stdout || `Remote command failed with exit ${code}`));
        });
        stream.on("data", (data) => { stdout += data.toString(); });
        stream.stderr.on("data", (data) => { stderr += data.toString(); });
      });
    });
  }

  async writeText(remotePath, text) {
    await this.exec(`mkdir -p ${shellQuote(remoteDir(remotePath))}`);
    const sftp = await new Promise((resolve, reject) => {
      this.client.sftp((error, handle) => (error ? reject(error) : resolve(handle)));
    });
    await new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, text, "utf8", (error) => (error ? reject(error) : resolve()));
    });
    sftp.end();
  }

  async saveMission(filename, yamlText) {
    const remotePath = `${this.config.missionDir.replace(/\/$/, "")}/${filename}`;
    await this.writeText(remotePath, yamlText);
    return remotePath;
  }

  async runScript(scriptPath, { remoteMissionPath = "", extraArgs = "" } = {}) {
    const session = this.config.tmuxSession;
    const source = this.config.rosInstallSetupPath ? `source ${shellQuote(this.config.rosInstallSetupPath)} || true; ` : "";
    const mission = remoteMissionPath ? ` ${shellQuote(remoteMissionPath)}` : "";
    const args = extraArgs || this.config.missionExtraArgs || "";
    const command = `${source}export ELYTRA_TARGET=physical; export ELYTRA_ROS_DISTRO=jazzy; bash ${shellQuote(scriptPath)}${mission}${args ? ` ${args}` : ""}`;
    await this.exec(`tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`);
    await this.exec(`tmux new-session -d -s ${shellQuote(session)} ${shellQuote(`bash -lc ${shellQuote(command)}`)}`);
  }

  async stop() {
    const session = this.config.tmuxSession;
    await this.exec(`tmux send-keys -t ${shellQuote(session)} C-c 2>/dev/null || true`);
    await sleep(this.config.tmuxStopGraceSeconds * 1000);
    await this.exec(`tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`);
  }

  async isScriptRunning() {
    try {
      await this.exec(tmuxScriptRunningProbe(this.config.tmuxSession));
      return true;
    } catch {
      return false;
    }
  }

  async captureLog() {
    const session = this.config.tmuxSession;
    const lines = this.config.tmuxCaptureLines;
    let hasSession = false;
    try {
      await this.exec(`tmux has-session -t ${shellQuote(session)} 2>/dev/null`);
      hasSession = true;
    } catch {
      hasSession = false;
    }
    try {
      const { stdout } = await this.exec(`tmux capture-pane -pt ${shellQuote(session)} -S -${lines} 2>/dev/null || true`);
      return { text: stdout, hasSession };
    } catch {
      return { text: "", hasSession };
    }
  }
}
