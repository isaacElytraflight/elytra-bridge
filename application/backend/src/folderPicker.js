import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Opens a native folder picker on the machine running the backend (not the browser).
 * Windows: PowerShell + WinForms FolderBrowserDialog (STA).
 * macOS: AppleScript choose folder.
 * Linux: zenity or kdialog.
 * @returns {Promise<string|null>} Absolute path, or null if cancelled / unavailable.
 */
export async function pickProjectFolderNative() {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      return await pickFolderWindows();
    }
    if (platform === "darwin") {
      return await pickFolderMac();
    }
    return await pickFolderLinux();
  } catch {
    return null;
  }
}

async function pickFolderWindows() {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = 'Select Elytra project folder (contains project.yaml, real/, sim/)'
$f.ShowNewFolderButton = $false
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $f.SelectedPath
}
`.trim();
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { encoding: "utf8", windowsHide: true },
  );
  const line = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  return line || null;
}

async function pickFolderMac() {
  const script =
    'POSIX path of (choose folder with prompt "Select Elytra project folder")';
  const { stdout } = await execFileAsync("osascript", ["-e", script], { encoding: "utf8" });
  const line = String(stdout || "").trim();
  return line || null;
}

async function pickFolderLinux() {
  try {
    const { stdout } = await execFileAsync(
      "zenity",
      ["--file-selection", "--directory", "--title=Select Elytra project folder"],
      { encoding: "utf8" },
    );
    const line = String(stdout || "").trim();
    return line || null;
  } catch {
    try {
      const { stdout } = await execFileAsync(
        "kdialog",
        ["--getexistingdirectory", "."],
        { encoding: "utf8" },
      );
      const line = String(stdout || "").trim();
      return line || null;
    } catch {
      return null;
    }
  }
}
