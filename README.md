# elytra-bridge

Middleware UI/backend for sim-to-real robot workflows.

Elytra Bridge lets a project describe the pieces needed to run the same ROS workflow in simulation and on a physical robot: simulator setup, ROS workspace paths, real robot setup, and operator buttons. The MVP ships with a `drone-2026` compatibility project that mirrors the control flow from the working UAVs at Berkeley drone UI.

## MVP Contents

- `docs/architecture-roadmap.md` - design doc, diagrams, and roadmap.
- `application/frontend` - React + Vite operator UI.
- `application/backend` - Express backend for project loading, SSH/tmux control, Docker simulation control, mission saves, and logs.
- `projects/drone-2026` - vendored Drone 2026 compatibility package with sim, ROS, real setup, docs, and action scripts.

## Run Locally

```bash
cd application
npm install
npm run dev
```

Or use a root launcher from `scripts/run-elytra-bridge-ui/`:

- `run-elytra-bridge-ui.bat` for Windows Command Prompt
- `run-elytra-bridge-ui.ps1` for Windows PowerShell
- `run-elytra-bridge-ui.sh` for macOS/Linux/Git Bash

Default URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`

Copy `application/backend/.env.example` to `application/backend/.env` for app-wide defaults. Project mode env files can live beside the project package: when you connect in real mode, the backend loads `projects/<project-id>/real/.env`; when you connect in sim mode, it loads `projects/<project-id>/sim/.env`. Values from the selected mode env file override `application/backend/.env`, and `project.yaml` remains the fallback.

## Drone Compatibility Notes

The bundled project vendors the behavior-bearing assets from `UAVs-at-Berkeley/drone-2026` under `projects/drone-2026`. Simulation uses `projects/drone-2026/sim/docker/docker-compose.yml` by default; leave `SIM_COMPOSE_FILE` unset unless you need to override that package-local compose file.

Project-specific env templates live at `projects/drone-2026/real/.env.example` and `projects/drone-2026/sim/.env.example`.
