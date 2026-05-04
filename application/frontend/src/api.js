const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed with ${response.status}`);
    error.details = data;
    throw error;
  }
  return data;
}

export const api = {
  health: () => request("/health"),
  projects: () => request("/projects"),
  project: (projectId) => request(`/projects/${encodeURIComponent(projectId)}`),
  status: () => request("/drone/status"),
  prefill: () => request("/drone/prefill"),
  defaultMission: (projectId) => request(`/mission/default?projectId=${encodeURIComponent(projectId || "")}`),
  connect: ({ projectId, mode, password }) =>
    request("/drone/connect", {
      method: "POST",
      body: JSON.stringify({ projectId, mode, password }),
    }),
  disconnect: () => request("/session/disconnect", { method: "POST", body: "{}" }),
  saveMission: (projectId, filename, yamlText) =>
    request("/mission/save", {
      method: "POST",
      body: JSON.stringify({ projectId, filename, yamlText }),
    }),
  runAction: (actionId, body = {}) =>
    request(`/actions/${encodeURIComponent(actionId)}/run`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  startFlight: (remoteMissionPath) =>
    request("/flight/start", { method: "POST", body: JSON.stringify({ remoteMissionPath }) }),
  startPassiveRecording: () => request("/flight/start-passive", { method: "POST", body: "{}" }),
  stopFlight: () => request("/flight/stop", { method: "POST", body: "{}" }),
  resetSimulation: () => request("/simulation/reset", { method: "POST", body: "{}" }),
  shutdownSimulation: () => request("/simulation/shutdown", { method: "POST", body: "{}" }),
  hotswapSimulationBranch: ({ branch }) =>
    request("/sim/hotswap", {
      method: "POST",
      body: JSON.stringify({ branch }),
    }),
  tmuxLog: () => request("/drone/tmux-log"),
  getSettingsEnv: () => request("/settings/env"),
  putSettingsEnv: (updates) => request("/settings/env", { method: "PUT", body: JSON.stringify(updates) }),
};
