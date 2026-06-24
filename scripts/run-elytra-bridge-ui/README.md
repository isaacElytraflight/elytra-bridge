# Elytra Bridge UI Launcher

These scripts start the local Elytra Bridge backend and frontend from the root repository.

- Windows Command Prompt: `run-elytra-bridge-ui.bat`
- Windows PowerShell: `run-elytra-bridge-ui.ps1`
- macOS/Linux/Git Bash: `run-elytra-bridge-ui.sh`

They check for Docker and Node.js, initialize the **`projects/drone-2026` Git submodule** when `project.yaml` is missing, install npm dependencies on first run, start `npm run dev` from `application`, and open `http://localhost:5173`.

`npm run dev` runs `scripts/ensure-single-instance.js` first (`predev`): any prior Elytra Bridge backend/frontend on ports **8787** / **5173** (or stale **8788** / **5174**) is stopped so only one dev stack runs at a time.
