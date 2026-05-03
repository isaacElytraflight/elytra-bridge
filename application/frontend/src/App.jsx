import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

const emptyStatus = {
  projectId: "drone-2026",
  connectionState: "disconnected",
  sshConnected: false,
  inFlight: false,
  runMode: null,
  mode: "physical",
  simViewerUrl: "",
  lastError: "",
  simSetupProgress: { percent: 0, step: "Idle", detail: "Waiting to start.", complete: false },
  missionStartupProgress: { percent: 0, step: "Idle", detail: "Waiting to start.", complete: false },
};

function clampPct(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function ProgressBar({ label, progress }) {
  const percent = clampPct(progress?.percent);
  return (
    <div className="progress-block">
      <div className="row split">
        <strong>{label}</strong>
        <span>{percent}%</span>
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
  const [project, setProject] = useState(null);
  const [projectId, setProjectId] = useState("drone-2026");
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
  const tmuxPreRef = useRef(null);
  const followLogRef = useRef(true);

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
      const selected = data.defaultProjectId || data.projects?.[0]?.id || "drone-2026";
      setProjectId(selected);
      await loadProject(selected);
    }
    boot().catch((error) => setInfo(error.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 3000);
    return () => clearInterval(id);
  }, []);

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

  async function loadProject(nextProjectId) {
    const data = await api.project(nextProjectId);
    setProject(data.project);
    const mission = await api.defaultMission(nextProjectId);
    setMissionName(mission.filename || "mission_ui.yaml");
    setMissionYaml(mission.yamlText || "mission:\n  steps: []\n");
  }

  async function refreshStatus() {
    try {
      const next = await api.status();
      setStatus(next);
    } catch (error) {
      setStatus((prev) => ({ ...prev, connectionState: "disconnected", sshConnected: false, lastError: error.message }));
    }
  }

  async function handleProjectChange(nextProjectId) {
    setProjectId(nextProjectId);
    setSavedMissionPath("");
    setInfo("");
    await loadProject(nextProjectId);
  }

  async function connect() {
    setBusy(true);
    setInfo("");
    try {
      const next = await api.connect({ projectId, mode: connectionMode, password: sshPassword });
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

  return (
    <main className="app">
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
          </div>
        </div>
      </header>

      <section className="panel grid two">
        <label>
          Project
          <select value={projectId} onChange={(event) => handleProjectChange(event.target.value)} disabled={busy || status.sshConnected}>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
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
            <button className="secondary" onClick={shutdownSimulation} disabled={busy || !status.sshConnected}>
              Shutdown Simulation
            </button>
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
                disabled={!status.sshConnected || busy || (action.requiresMission && !savedMissionPath)}
                title={action.description}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {simModeActive && resolvedSimViewerUrl && (
        <section className="panel">
          <h2>Simulation View</h2>
          <p className="muted">Live simulator desktop stream from the Docker container through noVNC.</p>
          <iframe className="novnc" src={resolvedSimViewerUrl} title="Simulation noVNC viewer" />
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

      {(info || status.lastError) && <section className="notice">{info || status.lastError}</section>}
    </main>
  );
}
