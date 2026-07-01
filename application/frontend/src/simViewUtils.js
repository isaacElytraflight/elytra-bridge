/** Resolve noVNC URL for the current browser hostname. */
export function resolveSimViewerUrl(raw, hostname) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value, "http://localhost");
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      parsed.hostname = hostname || parsed.hostname;
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

/** Build a cache-busted frame URL for polling. */
export function simViewFrameUrl(viewId, tick = Date.now()) {
  const base = import.meta.env.VITE_API_BASE || "http://localhost:8787";
  return `${base}/sim/views/${encodeURIComponent(viewId)}/frame?t=${tick}`;
}
