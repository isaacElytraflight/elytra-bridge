/** Validate and normalize project.yaml `views:` entries for the sim dashboard. */

export const VIEW_TYPES = new Set(["ros-image", "ros-compressed", "file"]);

/**
 * @param {unknown} rawViews
 * @returns {{ ok: true, views: Array<{ id: string, label: string, type: string, topic?: string, path?: string, primary: boolean }> } | { ok: false, message: string }}
 */
export function normalizeViews(rawViews) {
  if (rawViews == null) {
    return { ok: true, views: [] };
  }
  if (!Array.isArray(rawViews)) {
    return { ok: false, message: "views must be an array." };
  }

  const views = [];
  const seenIds = new Set();

  for (let i = 0; i < rawViews.length; i += 1) {
    const entry = rawViews[i];
    if (!entry || typeof entry !== "object") {
      return { ok: false, message: `views[${i}] must be an object.` };
    }

    const id = String(entry.id || "").trim();
    const label = String(entry.label || "").trim();
    const type = String(entry.type || "").trim();

    if (!id) {
      return { ok: false, message: `views[${i}] is missing required field "id".` };
    }
    if (seenIds.has(id)) {
      return { ok: false, message: `Duplicate view id: ${id}` };
    }
    seenIds.add(id);

    if (!label) {
      return { ok: false, message: `View "${id}" is missing required field "label".` };
    }
    if (!VIEW_TYPES.has(type)) {
      return { ok: false, message: `View "${id}" has unknown type "${type}".` };
    }

    const topic = String(entry.topic || "").trim();
    const filePath = String(entry.path || "").trim();

    if (type === "file") {
      if (!filePath) {
        return { ok: false, message: `View "${id}" (type file) requires "path".` };
      }
    } else if (!topic) {
      return { ok: false, message: `View "${id}" (type ${type}) requires "topic".` };
    }

    views.push({
      id,
      label,
      type,
      ...(topic ? { topic } : {}),
      ...(filePath ? { path: filePath } : {}),
      primary: Boolean(entry.primary),
    });
  }

  return { ok: true, views };
}

/** @param {Array<{ primary?: boolean }>} views */
export function selectPrimaryView(views) {
  if (!Array.isArray(views) || views.length === 0) return null;
  return views.find((view) => view.primary) || views[0];
}

/** @param {string} viewId */
export function buildViewFramePath(viewId) {
  const safe = String(viewId || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  return `/views/${safe}/frame.jpg`;
}
