# elytra-bridge

Middleware UI/backend for sim-to-real robot workflows.

Elytra Bridge lets a project describe the pieces needed to run the same ROS workflow in simulation and on a physical robot: simulator setup, ROS workspace paths, real robot setup, and operator buttons. The MVP ships with a `drone-2026` compatibility project that mirrors the control flow from the working UAVs at Berkeley drone UI.

## MVP Contents

- `docs/architecture-roadmap.md` - design doc, diagrams, and roadmap.
- `application/frontend` - React + Vite operator UI.
- `application/backend` - Express backend for project loading, SSH/tmux control, Docker simulation control, mission saves, and logs.
- `projects/drone-2026/project.yaml` - first file-backed project descriptor.

## Run Locally

```bash
cd application
npm install
npm run dev
```

Default URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`

Copy `application/backend/.env.example` to `application/backend/.env` if you want to override physical SSH or simulation Docker settings. The backend creates that file from the example on first start if it does not exist.

## Drone Compatibility Notes

The bundled project expects the same target paths as `UAVs-at-Berkeley/drone-2026`. For simulation, set `SIM_COMPOSE_FILE` to the reference repo's `SITL/web-sim/docker-compose.yml` if it is not checked out at the default relative path.
