# elytra-bridge

Middleware UI/backend for sim-to-real robot workflows.

Elytra Bridge lets a project describe the pieces needed to run the same ROS workflow in simulation and on a physical robot: simulator setup, ROS workspace paths, real robot setup, and operator buttons. The MVP wires to the **`drone-2026`** compatibility project ([UAVs-at-Berkeley/drone-2026](https://github.com/UAVs-at-Berkeley/drone-2026)) via a **Git submodule** under `projects/drone-2026`.

## Clone

```bash
git clone --recurse-submodules <this-repo-url>
cd elytra-bridge
```

If you cloned without `--recurse-submodules`, populate the default project:

```bash
git submodule update --init --recursive
```

See [`projects/README.md`](projects/README.md) for submodule maintenance (`git submodule update --remote`, and so on).

## MVP Contents

- `docs/architecture-roadmap.md` - design doc, diagrams, and roadmap.
- `docs/project-folder-contract.md` - normative layout and `project.yaml` contract for project folders (`real/`, `sim/`, env precedence).
- `application/frontend` - React + Vite operator UI.
- `application/backend` - Express backend for project loading, SSH/tmux control, Docker simulation control, mission saves, and logs.
- `projects/drone-2026` - **Git submodule** pointing at [UAVs-at-Berkeley/drone-2026](https://github.com/UAVs-at-Berkeley/drone-2026) (sim, ROS workspace, real setup, docs, action scripts).

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

See **`docs/project-folder-contract.md`** for the full required folder layout (`project.yaml`, `real/`, `sim/`), descriptor fields, and precedence rules. You can open any compliant project directory via **File → Open Project** in the UI (the native folder picker is shown on the machine where the **backend** runs; recent folders are stored under `application/backend/.elytra/`).

## Drone Compatibility Notes

The default package is the **`drone-2026` submodule** ([github.com/UAVs-at-Berkeley/drone-2026](https://github.com/UAVs-at-Berkeley/drone-2026)), checked out under `projects/drone-2026`. Simulation uses `projects/drone-2026/sim/docker/docker-compose.yml` by default; leave `SIM_COMPOSE_FILE` unset unless you need to override that package-local compose file.

Project-specific env templates live at `projects/drone-2026/real/.env.example` and `projects/drone-2026/sim/.env.example`.
