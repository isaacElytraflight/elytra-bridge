# Elytra Bridge — Project Folder Contract

This document describes the **normative contract** between the Elytra Bridge application (`application/frontend`, `application/backend`) and a **project folder** on disk.

A project folder is a portable package that Elytra Bridge loads at runtime. It must describe:

- metadata shown in the UI  
- **physical robot** connectivity (SSH/tmux scripts and paths)  
- **local simulation** connectivity (Docker Compose + container exec paths)  
- optional mode-specific `.env` overrides  
- operator buttons mapped to scripts  

The default checkout wires [`projects/drone-2026`](../projects/drone-2026/) as a **Git submodule** to [UAVs-at-Berkeley/drone-2026](https://github.com/UAVs-at-Berkeley/drone-2026). Clone with submodules or run `git submodule update --init --recursive`; see [`projects/README.md`](../projects/README.md).

---

## 1. Root layout (required)

Every Elytra project **must** be a single directory containing:

| Path | Required | Purpose |
|------|----------|---------|
| `project.yaml` | **Yes** | Canonical descriptor read by the backend (YAML). |
| `real/` | **Yes** | Physical-robot compartment (SSH-side scripts, hardware assets, optional `.env`). |
| `sim/` | **Yes** | Simulator compartment (Compose/Docker assets, scripts, optional `.env`). |

Additional directories (`buttons/`, `ros_workspace/`, `docs/`, etc.) are **project-defined**. Elytra does not hard-require them globally, but **your `project.yaml` must reference paths that exist** for scripts and Compose files your workflow uses.

### 1.1 Mode env files

For each mode, Elytra expects optional secrets/overrides beside that compartment:

| Path | Role |
|------|------|
| `real/.env` | Loaded **only** when the operator connects in **physical** mode. Never shipped with secrets in git; copy from `.env.example`. |
| `sim/.env` | Loaded **only** when the operator connects in **simulation** mode. |

**Recommended (not strictly enforced by code):**

| Path | Role |
|------|------|
| `real/.env.example` | Document physical overrides for collaborators. |
| `sim/.env.example` | Document simulation overrides for collaborators. |

If `.env.example` files are missing, Elytra Bridge may surface **warnings** when opening the project; behavior still falls back to `project.yaml` and `application/backend/.env`.

---

## 2. Descriptor — `project.yaml`

The backend parses `project.yaml` with **js-yaml**. Unknown keys are preserved on the loaded object but **may be ignored** by the MVP backend unless documented below.

### 2.1 Top-level metadata (contract)

These fields drive listing and UI copy:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | Recommended | Stable identifier (ASCII). If omitted, the backend falls back to the bundled folder name when loading from `PROJECTS_DIR`. |
| `name` | string | Recommended | Human-readable title. |
| `description` | string | Optional | Shown in the operator UI. |
| `robotType` | string | Optional | Display/category hint; default `robot`. |
| `ros.distro` | string | Optional | Default `jazzy` if omitted. |

### 2.2 Default mission blob

Optional embedded starter mission for the UI editor:

```yaml
defaultMission:
  filename: mission_ui.yaml
  yamlText: |
    mission:
      steps: []
```

If absent, the backend supplies a minimal default.

### 2.3 Physical mode — `real:` block

Maps to **`descriptor.real`** and is merged with **`real/.env`** (when connecting physically) and `DRONE_*` variables.

Typical keys (see [`projects/drone-2026/project.yaml`](../projects/drone-2026/project.yaml)):

| Field | Meaning |
|-------|---------|
| `host`, `port`, `user` | SSH target |
| `privateKeyPath`, `privateKeyPassphrase`, `sshPassword` | Auth (prefer key + agent for automation) |
| `missionDir` | Remote directory where missions are saved |
| `rosInstallSetupPath` | Remote `setup.bash` for the ROS workspace |
| `startScriptPath`, `recordingScriptPath` | Paths **on the robot** invoked by button actions |
| `tmuxSession`, `tmuxCaptureLines`, `tmuxStopGraceSeconds` | tmux integration |
| `missionExtraArgs` | Extra CLI fragment passed when launching missions |
| `actions` | Optional map of `actionId → script path` overrides |

Relative paths in `privateKeyPath` (and similar) resolve **relative to the project folder root** when not absolute.

### 2.4 Simulation mode — `sim:` block

Maps to **`descriptor.sim`** and merges with **`sim/.env`** (when connecting in sim) and `SIM_*` / `SIM_DRONE_*` variables.

Typical keys:

| Field | Meaning |
|-------|---------|
| `composeFile` | Path to `docker-compose.yml` (often under `sim/docker/`), resolved relative to project root if not absolute |
| `composeProject`, `containerName` | Compose project name and primary exec container |
| `novncOrigin` | URL shown in the UI iframe for noVNC |
| `missionDir`, `rosInstallSetupPath`, `startScriptPath`, `recordingScriptPath`, `tmux*` , `missionExtraArgs` | Same semantics as physical, but paths are **inside the sim container filesystem** unless overridden by env |
| `autoStopOnDisconnect` | Whether the backend should tear down Compose when disconnecting |

### 2.5 Package bookkeeping — `local:` block

Optional map used by vendored packages (e.g. pointers to upstream docs). **Not interpreted by core Elytra MVP orchestration**, but allowed in YAML.

### 2.6 Buttons — `buttons:` array

Each entry defines one UI button:

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | Yes | Stable action id used by `/actions/:id/run`. |
| `label` | Yes | Button text |
| `description` | Optional | Tooltip |
| `kind` | Optional | Default `script` |
| `scriptKey` | Optional | `start` → use mode `startScriptPath`; `recording` → `recordingScriptPath` |
| `scriptPath` | Optional | Explicit remote/container script path |
| `requiresMission` | Optional | If true, mission must be saved before run |
| `stopAction` | Optional | If true, interpreted as “stop mission” / Ctrl+C style cleanup |
| `runMode`, `extraArgs` | Optional | Passed through to launcher |

The backend exposes a **sanitized subset** to the client (`projectForClient`).

---

## 3. Environment precedence

When connecting in a mode, Elytra merges configuration in this order (**later overrides earlier**):

1. Defaults inside `project.yaml` (`real:` or `sim:` blocks)  
2. `application/backend/.env` process environment  
3. **`real/.env`** or **`sim/.env`** for the selected mode only  

Secrets belong in mode `.env` files or backend `.env`, not committed YAML.

---

## 4. Path resolution rules

- **Project root**: the directory containing `project.yaml`.  
- **Relative paths** in `project.yaml` resolve relative to the project root unless noted otherwise (`resolvePath` in backend config).  
- **Tilde paths** (`~/...`) expand using `HOME` / `USERPROFILE`.  

Robots and containers may use **different absolute paths** for the same logical repo layout; use mode-specific YAML + `.env` to bridge that gap.

---

## 5. Application responsibilities vs project responsibilities

### 5.1 Elytra Bridge backend must:

- Parse `project.yaml` and expose safe metadata + buttons to the UI  
- Load the correct mode `.env` on connect  
- In physical mode: SSH/SFTP/tmux orchestration using merged config  
- In sim mode: Docker Compose lifecycle, `docker exec` / copy helpers, diagnostics  

### 5.2 Project folder must:

- Keep **`real/` and `sim/`** compartments present (even if one is minimally populated for future robots)  
- Ensure referenced **`composeFile`** exists when simulation is used  
- Ensure **`startScriptPath` / `recordingScriptPath`** (or `scriptPath` per button) exist **on the target** (robot filesystem or container filesystem)  
- Keep mission save directories writable on the active target  

---

## 6. Opening projects outside `PROJECTS_DIR`

Operators may open **any directory** that satisfies this contract (for example a checkout elsewhere on disk).

When opened by path:

- The backend reads **`project.yaml` directly from that root**  
- **`PROJECTS_DIR` listing remains unchanged** — bundled discovery only scans that folder  
- Recent roots may be persisted locally by the backend for quick reopen  

---

## 7. Versioning & compatibility

- This contract describes the **MVP** Elytra Bridge behavior.  
- Projects **may** carry extra YAML keys for future platform features; backends must tolerate unknown fields.  
- Breaking changes to required files or semantics should bump Elytra’s documented contract version in release notes.

---

## See also

- [`README.md`](../README.md) — env overview  
- [`projects/README.md`](../projects/README.md) — submodule clone / update workflow  
- [`docs/architecture-roadmap.md`](architecture-roadmap.md) — high-level architecture  
- [`projects/drone-2026/README.md`](../projects/drone-2026/README.md) — upstream drone package docs  
