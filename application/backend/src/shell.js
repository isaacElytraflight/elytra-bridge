import { execFile, spawn } from "node:child_process";

export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function runFile(command, args, options = {}) {
  const timeout = options.timeout ?? 120000;
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function runFileStream(command, args, options = {}) {
  const timeout = options.timeout ?? 120000;
  const onOutput = typeof options.onOutput === "function" ? options.onOutput : () => {};

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      const error = new Error(`Command timed out after ${timeout}ms: ${command} ${args.join(" ")}`);
      error.stdout = stdout;
      error.stderr = stderr;
      settled = true;
      reject(error);
    }, timeout);

    const handleChunk = (source) => (chunk) => {
      const text = chunk.toString();
      if (source === "stdout") stdout += text;
      else stderr += text;
      onOutput(text, source);
    };

    child.stdout?.on("data", handleChunk("stdout"));
    child.stderr?.on("data", handleChunk("stderr"));
    child.on("error", (error) => {
      if (settled) return;
      clearTimeout(timer);
      error.stdout = stdout;
      error.stderr = stderr;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
