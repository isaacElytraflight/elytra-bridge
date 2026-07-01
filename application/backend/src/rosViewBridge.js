import { buildViewFramePath } from "./viewConfig.js";

/**
 * @param {string} baseUrl e.g. http://127.0.0.1:8090
 * @param {string} viewId
 */
export function viewServerFrameUrl(baseUrl, viewId) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  return `${base}${buildViewFramePath(viewId)}`;
}

/**
 * Fetch a JPEG frame from the in-container view server.
 * @param {string} baseUrl
 * @param {string} viewId
 * @returns {Promise<{ ok: true, buffer: Buffer, contentType: string } | { ok: false, status: number, message: string }>}
 */
export async function fetchViewFrame(baseUrl, viewId) {
  const url = viewServerFrameUrl(baseUrl, viewId);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    return {
      ok: false,
      status: 503,
      message: `View server unreachable: ${error.message}`,
    };
  }

  if (response.status === 404) {
    return { ok: false, status: 404, message: "No frame available yet." };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      message: text.trim() || response.statusText || "View server error.",
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "image/jpeg";
  return { ok: true, buffer, contentType };
}
