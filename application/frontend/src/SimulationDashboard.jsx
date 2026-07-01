import { useEffect, useState } from "react";
import { api } from "./api";
import { resolveSimViewerUrl, simViewFrameUrl } from "./simViewUtils";

function ViewPanel({ view, active, tick }) {
  const [status, setStatus] = useState("waiting");
  const [src, setSrc] = useState("");

  useEffect(() => {
    if (!active || !view?.id) {
      setStatus("waiting");
      setSrc("");
      return undefined;
    }

    let cancelled = false;
    let objectUrl = "";
    const url = simViewFrameUrl(view.id, tick);

    fetch(url)
      .then((response) => {
        if (cancelled) return null;
        if (!response.ok) {
          setStatus(response.status === 404 ? "waiting" : "error");
          setSrc("");
          return null;
        }
        return response.blob();
      })
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        setStatus("live");
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
          setSrc("");
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, view?.id, tick]);

  const panelClass = view.primary ? "sim-view-panel sim-view-primary" : "sim-view-panel";

  return (
    <div className={panelClass}>
      <div className="sim-view-header">
        <strong>{view.label}</strong>
        <span className="muted sim-view-status">
          {status === "live" ? "Live" : status === "error" ? "Stream error" : "Waiting for stream…"}
        </span>
      </div>
      <div className="sim-view-frame">
        {status !== "live" && (
          <div className="sim-view-placeholder">
            {status === "error" ? "Stream error" : "Waiting for stream…"}
          </div>
        )}
        {src && (
          <img
            className="sim-view-img"
            src={src}
            alt={view.label}
          />
        )}
      </div>
    </div>
  );
}

export default function SimulationDashboard({ connected, simViewerUrl, views: initialViews = [] }) {
  const [views, setViews] = useState(initialViews);
  const [tick, setTick] = useState(0);
  const resolvedNovnc = resolveSimViewerUrl(simViewerUrl, window.location.hostname);
  const hasViews = views.length > 0;

  useEffect(() => {
    setViews(initialViews);
  }, [initialViews]);

  useEffect(() => {
    if (!connected) return undefined;
    if (hasViews) {
      api.simViews().then((data) => setViews(data.views || [])).catch(() => {});
    }
    const id = setInterval(() => setTick((value) => value + 1), 100);
    return () => clearInterval(id);
  }, [connected, hasViews]);

  if (!connected) return null;

  return (
    <section className="panel">
      <h2>Simulation Dashboard</h2>
      <p className="muted">
        Live camera and map panels streamed from ROS topics configured in project.yaml.
      </p>

      {hasViews ? (
        <div className="sim-dashboard">
          {views.map((view) => (
            <ViewPanel key={view.id} view={view} active={connected} tick={tick} />
          ))}
        </div>
      ) : (
        <p className="muted">No views configured for this project.</p>
      )}

      {resolvedNovnc && (
        <details className="sim-debug-novnc">
          <summary>Debug: full desktop (noVNC)</summary>
          <p className="muted">Legacy first-person desktop stream from the container VNC server.</p>
          <iframe
            allow="fullscreen"
            allowFullScreen
            className="novnc"
            src={resolvedNovnc}
            title="Simulation noVNC viewer"
          />
        </details>
      )}
    </section>
  );
}
