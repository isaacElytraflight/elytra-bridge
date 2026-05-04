# Elytra Bridge UI Launcher

These scripts start the local Elytra Bridge backend and frontend from the root repository.

- Windows Command Prompt: `run-elytra-bridge-ui.bat`
- Windows PowerShell: `run-elytra-bridge-ui.ps1`
- macOS/Linux/Git Bash: `run-elytra-bridge-ui.sh`

They check for Docker and Node.js, install npm dependencies on first run, start `npm run dev` from `application`, and open `http://localhost:5173`.
