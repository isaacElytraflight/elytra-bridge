import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

const emptyStatus = {
  projectId: "drone-2026",
  openProjectRoot: "",
  connectionState: "disconnected",
  sshConnected: false,
  inFlight: false,
  runMode: null,
  mode: "physical",
  simViewerUrl: "",
  lastError: "",
  dockerBuildProgress: { percent: 0, step: "Idle", detail: "Waiting to start.", complete: false },
  simSetupProgress: { percent: 0, step: "Idle", detail: "Waiting to start.", complete: false },
  missionStartupProgress: { percent: 0, step: "Idle", detail: "Waiting to start.", complete: false },
};

function clampPct(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function ProgressBar({ label, progress }) {
  const percent = clampPct(progress?.percent);
  const countLabel = Number(progress?.total) > 0 ? `[${Number(progress?.count) || 0}/${Number(progress?.total)}]` : "";
  return (
    <div className="progress-block">
      <div className="row split">
        <strong>{label}</strong>
        <span>{countLabel ? `${countLabel} ${percent}%` : `${percent}%`}</span>
      </div>
      <div className="progress">
        <div style={{ width: `${percent}%` }} />
      </div>
      <p className="muted">{progress?.step || "Idle"}: {progress?.detail || "Waiting to start."}</p>
    </div>
  );
}

function getInitialTheme() {
  const savedTheme = window.localStorage.getItem("elytra-theme");
  if (savedTheme === "light" || savedTheme === "dark") return savedTheme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [recentProjects, setRecentProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [projectId, setProjectId] = useState("drone-2026");
  const [projectRoot, setProjectRoot] = useState("");
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [pathModalOpen, setPathModalOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [connectionMode, setConnectionMode] = useState("physical");
  const [status, setStatus] = useState(emptyStatus);
  const [missionName, setMissionName] = useState("mission_ui.yaml");
  const [missionYaml, setMissionYaml] = useState("mission:\n  steps: []\n");
  const [savedMissionPath, setSavedMissionPath] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");
  const [tmuxLog, setTmuxLog] = useState("");
  const [tmuxLogNote, setTmuxLogNote] = useState("");
  const [tmuxLogPaused, setTmuxLogPaused] = useState(false);
  const [followLog, setFollowLog] = useState(true);
  const [envRows, setEnvRows] = useState(null);
  const [envDraft, setEnvDraft] = useState({});
  const [envNotice, setEnvNotice] = useState("");
  const [envBusy, setEnvBusy] = useState(false);
  const [theme, setTheme] = useState(getInitialTheme);
  const [hotswapBusy, setHotswapBusy] = useState(false);
  const [hotswapStatus, setHotswapStatus] = useState("");
  const tmuxPreRef = useRef(null);
  const followLogRef = useRef(true);
  const menuRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("elytra-theme", theme);
  }, [theme]);

  useEffect(() => {
    followLogRef.current = followLog;
  }, [followLog]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const data = await api.projects();
      if (cancelled) return;
      setProjects(data.projects || []);
      setRecentProjects(data.recentProjects || []);
      const selected = data.defaultProjectId || data.projects?.[0]?.id || "drone-2026";
      setProjectId(selected);
      setProjectRoot("");
      await loadProject(selected, "");
    }
    boot().catch((error) => setInfo(error.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot runs once; loadProject defined below
  }, []);

  useEffect(() => {
    if (!fileMenuOpen) return undefined;
    function onDocMouseDown(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setFileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [fileMenuOpen]);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 3000);
    return () => clearInterval(id);
  }, []);

  // Keep the locally-loaded project (buttons, mission, description) in sync
  // with the backend's connected session. Without this, reloading the UI (or a
  // second client connecting) shows the connected project's name in the status
  // card while rendering the default project's buttons and mission YAML.
  const projectSyncRef = useRef(false);
  useEffect(() => {
    if (!status.sshConnected || busy || projectSyncRef.current) return;
    const statusRoot = status.openProjectRoot || "";
    const mismatch =
      (status.projectId && status.projectId !== projectId) ||
      statusRoot !== (projectRoot || "");
    if (!mismatch) return;
    projectSyncRef.current = true;
    (async () => {
      try {
        await loadProject(status.projectId, statusRoot);
        setConnectionMode(status.mode === "sim" ? "sim" : "physical");
        setSavedMissionPath(status.savedMissionPath || "");
        setInfo(`Synced to connected project: ${status.projectName || status.projectId}`);
      } catch (error) {
        setInfo(`Could not sync to connected project: ${error.message}`);
      } finally {
        projectSyncRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadProject identity is stable enough for this sync
  }, [status.sshConnected, status.projectId, status.openProjectRoot, projectId, projectRoot, busy]);

  useEffect(() => {
    if (!status.sshConnected || tmuxLogPaused) return undefined;
    let cancelled = false;
    async function pullLog() {
      try {
        const data = await api.tmuxLog();
        if (cancelled) return;
        setTmuxLog(data.text || "");
        setTmuxLogNote(data.hasSession ? "" : "No tmux session yet. Run an action to see output.");
        if (followLogRef.current && tmuxPreRef.current) {
          tmuxPreRef.current.scrollTop = tmuxPreRef.current.scrollHeight;
        }
      } catch (error) {
        if (!cancelled) setTmuxLogNote(error.message);
      }
    }
    pullLog();
    const id = setInterval(pullLog, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status.sshConnected, tmuxLogPaused]);

  async function loadProject(nextProjectId, nextProjectRoot) {
    const resolvedRoot = nextProjectRoot !== undefined ? nextProjectRoot : projectRoot;
    const rootArg = resolvedRoot ? resolvedRoot : undefined;
    const data = await api.project(nextProjectId, rootArg);
    setProject(data.project);
    setProjectId(data.project.id);
    setProjectRoot(data.openProjectRoot || "");
    const mission = await api.defaultMission(data.project.id, rootArg);
    setMissionName(mission.filename || "mission_ui.yaml");
    setMissionYaml(mission.yamlText || "mission:\n  steps: []\n");
  }

  async function selectBundledProject(nextProjectId) {
    setSavedMissionPath("");
    setInfo("");
    await loadProject(nextProjectId, "");
  }

  async function closeProjectToDefault() {
    const data = await api.projects();
    setProjects(data.projects || []);
    setRecentProjects(data.recentProjects || []);
    const selected = data.defaultProjectId || data.projects?.[0]?.id || "drone-2026";
    setSavedMissionPath("");
    setInfo("");
    await loadProject(selected, "");
  }

  async function handleOpenProjectDialog() {
    setFileMenuOpen(false);
    setBusy(true);
    setInfo("");
    try {
      const data = await api.openProjectDialog();
      setRecentProjects(data.recentProjects || []);
      setSavedMissionPath("");
      setProject(data.project);
      setProjectId(data.project.id);
      setProjectRoot(data.openProjectRoot || "");
      const mission = await api.defaultMission(data.project.id, data.openProjectRoot || undefined);
      setMissionName(mission.filename || "mission_ui.yaml");
      setMissionYaml(mission.yamlText || "mission:\n  steps: []\n");
      setInfo(data.warnings?.length ? `Opened with warnings:\n${data.warnings.join("\n")}` : "");
    } catch (error) {
      setInfo(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitOpenProjectPath() {
    const trimmed = pathDraft.trim();
    if (!trimmed) return;
    setBusy(true);
    setPathModalOpen(false);
    setPathDraft("");
    setInfo("");
    try {
      const data = await api.openProjectPath(trimmed);
      setRecentProjects(data.recentProjects || []);
      setSavedMissionPath("");
      setProject(data.project);
      setProjectId(data.project.id);
      setProjectRoot(data.openProjectRoot || "");
      const mission = await api.defaultMission(data.project.id, data.openProjectRoot || undefined);
      setMissionName(mission.filename || "mission_ui.yaml");
      setMissionYaml(mission.yamlText || "mission:\n  steps: []\n");
      setInfo(data.warnings?.length ? `Opened with warnings:\n${data.warnings.join("\n")}` : "");
    } catch (error) {
      setInfo(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function openRecentProject(entry) {
    setFileMenuOpen(false);
    setBusy(true);
    setInfo("");
    try {
      const id = entry.descriptorId || entry.name || projectId;
      setSavedMissionPath("");
      await loadProject(id, entry.root);
    } catch (error) {
      setInfo(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveRecentProject(root, event) {
    event.stopPropagation();
    try {
      const data = await api.removeRecentProject(root);
      setRecentProjects(data.recentProjects || []);
    } catch (error) {
      setInfo(error.message);
    }
  }

  async function refreshStatus() {
    try {
      const next = await api.status();
      setStatus(next);
    } catch (error) {
      setStatus((prev) => ({ ...prev, connectionState: "disconnected", sshConnected: false, lastError: error.message }));
    }
  }

  async function connect() {
    setBusy(true);
    setInfo("");
    try {
      const next = await api.connect({
        projectId,
        mode: connectionMode,
        password: sshPassword,
        projectRoot: projectRoot || "",
      });
      setStatus(next);
      setInfo(connectionMode === "sim" ? "Connected to local simulation." : "Connected to physical robot.");
    } catch (error) {
      if (error.details?.state) setStatus(error.details.state);
      setInfo(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveMission() {
    setBusy(true);
    setInfo("");
    try {
      const result = await api.saveMission(projectId, missionName, missionYaml);
      setSavedMissionPath(result.remotePath);
      if (result.state) setStatus(result.state);
      setInfo(`Saved mission to ${result.remotePath}`);
    } catch (error) {
      setInfo(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action) {
    setBusy(true);
    setInfo("");
    try {
      if (action.stopAction && simModeActive) {
        const result = await api.resetSimulation();
        if (result.state) setStatus(result.state);
        setInfo("Simulation mission ended and SITL restarted to its initial state.");
        return;
      }
      const body = action.requiresMission ? { remoteMissionPath: savedMissionPath } : {};
      const result = await api.runAction(action.id, body);
      if (result.state) setStatus(result.state);
      setInfo(`${action.label} requested.`);
    } catch (error) {
      if (error.details?.state) setStatus(error.details.state);
      setInfo(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function shutdownSimulation() {
    setBusy(true);
    setInfo("");
    try {
      const result = await api.shutdownSimulation();
      if (result.state) setStatus(result.state);
      setInfo("Simulation shutdown requested.");
    } catch (error) {
      if (error.details?.state) setStatus(error.details.state);
      setInfo(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetSimulation() {
    setBusy(true);
    setInfo("");
    try {
      const result = await api.resetSimulation();
      if (result.state) setStatus(result.state);
      setInfo("Simulation reset requested.");
    } catch (error) {
      if (error.details?.state) setStatus(error.details.state);
      setInfo(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadRepoBranch() {
    if (hotswapBusy || busy) return;
    const branch = window.prompt("Enter branch to load from UAVs-at-Berkeley/drone-2026", "main");
    if (branch == null) return;
    const normalizedBranch = branch.trim();
    if (!normalizedBranch) {
      setInfo("Branch name is required.");
      return;
    }

    setHotswapBusy(true);
    setHotswapStatus(`Updating from ${normalizedBranch}...`);
    setInfo(`Fetching drone-2026 branch ${normalizedBranch} and updating simulation.`);
    try {
      const result = await api.hotswapSimulationBranch({ branch: normalizedBranch });
      if (result.state) setStatus(result.state);
      setHotswapStatus(`Updated from ${normalizedBranch}.`);
      setInfo("Repo hotswap complete. Simulation reset complete.");
    } catch (error) {
      if (error.details?.state) setStatus(error.details.state);
      setHotswapStatus(error.message);
      setInfo(error.message);
    } finally {
      setHotswapBusy(false);
    }
  }

  async function loadEnvPanel() {
    setEnvBusy(true);
    try {
      const data = await api.getSettingsEnv();
      setEnvRows(data.fields || []);
      setEnvDraft(Object.fromEntries((data.fields || []).map((field) => [field.key, field.value || ""])));
      setEnvNotice(data.notice || "");
    } catch (error) {
      setInfo(error.message);
    } finally {
      setEnvBusy(false);
    }
  }

  async function saveEnvPanel() {
    setEnvBusy(true);
    try {
      const result = await api.putSettingsEnv(envDraft);
      setInfo(result.message || "Saved backend .env.");
      await loadEnvPanel();
    } catch (error) {
      setInfo(error.message);
    } finally {
      setEnvBusy(false);
    }
  }

  const statusLabel = useMemo(() => {
    if (status.connectionState === "connected_idle") return "Connected";
    if (status.connectionState === "reconnected_in_flight") return "Running";
    if (status.connectionState === "connecting") return "Connecting";
    return "Disconnected";
  }, [status.connectionState]);

  const resolvedSimViewerUrl = useMemo(() => {
    const raw = status.simViewerUrl || "";
    if (!raw) return "";
    try {
      const parsed = new URL(raw, window.location.origin);
      if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
        parsed.hostname = window.location.hostname;
      }
      return parsed.toString();
    } catch {
      return raw;
    }
  }, [status.simViewerUrl]);

  const canSave = status.sshConnected && !busy;
  const simModeActive = (status.mode || connectionMode) === "sim";
  const canHotswapRepo = simModeActive && status.sshConnected && !busy && !hotswapBusy;

  const pickerDisabled = busy || status.sshConnected;

  return (
    <main className="app">
      <div className="menu-bar" ref={menuRef}>
        <div className={`menu-wrap ${fileMenuOpen ? "menu-open" : ""}`}>
          <button
            type="button"
            className="menu-trigger secondary"
            aria-expanded={fileMenuOpen}
            aria-haspopup="true"
            onClick={() => setFileMenuOpen((open) => !open)}
          >
            File
          </button>
          {fileMenuOpen && (
            <div className="menu-dropdown" role="menu">
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                disabled={pickerDisabled}
                onClick={() => void handleOpenProjectDialog()}
              >
                Open Project…
              </button>
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                disabled={pickerDisabled}
                onClick={() => {
                  setFileMenuOpen(false);
                  setPathModalOpen(true);
                }}
              >
                Open Project by Path…
              </button>
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                disabled={pickerDisabled}
                onClick={() => {
                  setFileMenuOpen(false);
                  void closeProjectToDefault();
                }}
              >
                Close Project (bundled default)
              </button>
              <div className="menu-divider" />
              <div className="menu-heading">Bundled projects</div>
              {projects.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  disabled={pickerDisabled}
                  onClick={() => {
                    setFileMenuOpen(false);
                    void selectBundledProject(item.id);
                  }}
                >
                  {item.name}
                </button>
              ))}
              <div className="menu-divider" />
              <div className="menu-heading">Recent projects</div>
              {recentProjects.length === 0 ? (
                <div className="menu-muted menu-item-static">No recent folders yet.</div>
              ) : (
                recentProjects.map((entry) => (
                  <div key={entry.root} className="menu-item-row">
                    <button
                      type="button"
                      className="menu-item menu-item-grow"
                      role="menuitem"
                      disabled={pickerDisabled}
                      title={entry.root}
                      onClick={() => void openRecentProject(entry)}
                    >
                      <span className="menu-item-title">{entry.name || entry.descriptorId || entry.root}</span>
                      <span className="menu-item-sub muted">{entry.root}</span>
                    </button>
                    <button
                      type="button"
                      className="menu-remove secondary"
                      aria-label={`Remove ${entry.root} from recent`}
                      disabled={pickerDisabled}
                      onClick={(event) => void handleRemoveRecentProject(entry.root, event)}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <div className="menu-context muted">
          <strong>{project?.name || projectId}</strong>
          {projectRoot ? (
            <>
              {" · "}
              <span title={projectRoot}>{projectRoot}</span>
            </>
          ) : (
            <span> · bundled package</span>
          )}
        </div>
      </div>

      <header className="hero">
        <div>
          <p className="eyebrow">Elytra Bridge</p>
          <h1>Robot sim-to-real control</h1>
          <p>Project-backed middleware for running the same ROS workflow in simulation and on hardware.</p>
        </div>
        <div className="hero-side">
          <button
            className="theme-toggle"
            type="button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <div className="status-card">
            <span className={`status-dot ${status.sshConnected ? "ok" : ""}`} />
            <strong>{statusLabel}</strong>
            <span>{status.projectName || project?.name || projectId}</span>
            {(projectRoot || status.openProjectRoot) ? (
              <small className="muted status-path" title={projectRoot || status.openProjectRoot}>
                {projectRoot || status.openProjectRoot}
              </small>
            ) : null}
          </div>
        </div>
      </header>

      <section className="panel connection-panel">
        <label>
          Control mode
          <select value={connectionMode} onChange={(event) => setConnectionMode(event.target.value)} disabled={busy || status.sshConnected}>
            <option value="physical">Physical robot</option>
            <option value="sim">Local simulation (Docker)</option>
          </select>
        </label>
        <label className="wide">
          SSH password (optional)
          <input
            type="password"
            value={sshPassword}
            onChange={(event) => setSshPassword(event.target.value)}
            disabled={busy || status.sshConnected}
            placeholder="Leave empty to use key or backend .env password"
          />
        </label>
        <div className="row actions">
          <button onClick={connect} disabled={busy || status.sshConnected}>
            {status.sshConnected ? "Connected" : connectionMode === "sim" ? "Start + Connect Simulation" : "Connect"}
          </button>
          {simModeActive && (
            <>
              <button className="secondary" onClick={resetSimulation} disabled={busy || !status.sshConnected}>
                Reset Simulation
              </button>
              <button className="secondary" onClick={shutdownSimulation} disabled={busy || !status.sshConnected}>
                Shutdown Simulation
              </button>
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <details onToggle={(event) => event.currentTarget.open && !envRows && loadEnvPanel()}>
          <summary>Backend environment (.env)</summary>
          <p className="muted">{envNotice || "View or edit local backend connection variables."}</p>
          {envBusy && <p>Loading...</p>}
          {envRows?.map((row) => (
            <label key={row.key}>
              {row.label}
              <small>{row.key}</small>
              <input
                type={row.sensitive ? "password" : "text"}
                value={envDraft[row.key] || ""}
                onChange={(event) => setEnvDraft((prev) => ({ ...prev, [row.key]: event.target.value }))}
              />
            </label>
          ))}
          {envRows && <button className="secondary" onClick={saveEnvPanel} disabled={envBusy}>Save .env</button>}
        </details>
      </section>

      <section className="grid two">
        <div className="panel">
          <ProgressBar label="Docker build" progress={status.dockerBuildProgress} />
          <ProgressBar label="Simulation setup" progress={status.simSetupProgress} />
          <ProgressBar label="Robot startup" progress={status.missionStartupProgress} />
        </div>
        <div className="panel">
          <h2>Project Actions</h2>
          <p className="muted">{project?.description || "Actions are loaded from project.yaml."}</p>
          <div className="button-list">
            {(project?.buttons || []).map((action) => (
              <button
                key={action.id}
                className={action.stopAction ? "danger" : "secondary"}
                onClick={() => runAction(action)}
                disabled={
                  !status.sshConnected ||
                  busy ||
                  (action.requiresMission && !savedMissionPath) ||
                  (!action.stopAction && status.inFlight) ||
                  (action.stopAction && !status.inFlight)
                }
                title={action.description}
              >
                {action.label}
              </button>
            ))}
            {simModeActive && (
              <>
                <button className="secondary" onClick={loadRepoBranch} disabled={!canHotswapRepo}>
                  {hotswapBusy ? "Loading Repo Branch..." : "Load Repo Branch"}
                </button>
                {hotswapStatus && <span className="hotswap-status">{hotswapStatus}</span>}
              </>
            )}
          </div>
        </div>
      </section>

      {simModeActive && resolvedSimViewerUrl && (
        <section className="panel">
          <h2>Simulation View</h2>
          <p className="muted">Live simulator desktop stream from the Docker container through noVNC.</p>
          <iframe
            allow="fullscreen"
            allowFullScreen
            className="novnc"
            src={resolvedSimViewerUrl}
            title="Simulation noVNC viewer"
          />
        </section>
      )}

      {simModeActive && (
        <section className="panel">
          <details>
            <summary>Simulation diagnostics</summary>
            <pre>{(status.connectTrace || []).join("\n") || "No connect trace yet."}</pre>
            {status.composePs && <pre>{status.composePs}</pre>}
            {status.composeLogsTail && <pre>{status.composeLogsTail}</pre>}
          </details>
        </section>
      )}

      <section className="panel">
        <h2>Mission YAML</h2>
        <label>
          Filename
          <input value={missionName} onChange={(event) => setMissionName(event.target.value)} />
        </label>
        <textarea value={missionYaml} onChange={(event) => setMissionYaml(event.target.value)} rows={14} />
        <div className="row actions">
          <button onClick={saveMission} disabled={!canSave}>Save Mission</button>
          {savedMissionPath && <span className="muted">Saved path: {savedMissionPath}</span>}
        </div>
      </section>

      {status.sshConnected && (
        <section className="panel">
          <div className="row split">
            <h2>tmux Output</h2>
            <div className="row">
              <label className="check"><input type="checkbox" checked={tmuxLogPaused} onChange={(event) => setTmuxLogPaused(event.target.checked)} /> Pause</label>
              <label className="check"><input type="checkbox" checked={followLog} onChange={(event) => setFollowLog(event.target.checked)} /> Auto-scroll</label>
            </div>
          </div>
          <pre
            ref={tmuxPreRef}
            className="tmux"
            onScroll={() => {
              const el = tmuxPreRef.current;
              if (!el) return;
              setFollowLog(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
            }}
          >
            {tmuxLog || "-"}
          </pre>
          {tmuxLogNote && <p className="muted">{tmuxLogNote}</p>}
        </section>
      )}

      {pathModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPathModalOpen(false);
          }}
        >
          <div className="modal" role="dialog" aria-labelledby="open-path-title">
            <h3 id="open-path-title">Open project by path</h3>
            <p className="muted modal-help">
              Absolute path to a folder containing <code>project.yaml</code>, <code>real/</code>, and <code>sim/</code>.
            </p>
            <label>
              Project folder
              <input
                autoFocus
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
                placeholder="e.g. C:/Users/you/repos/my-drone-package"
              />
            </label>
            <div className="row actions modal-actions">
              <button type="button" className="secondary" onClick={() => setPathModalOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={() => void submitOpenProjectPath()} disabled={busy}>
                Open
              </button>
            </div>
          </div>
        </div>
      )}

      {(info || status.lastError) && (
        <section className="notice notice-multiline">{info || status.lastError}</section>
      )}
    </main>
  );
}
