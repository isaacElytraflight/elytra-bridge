import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildViewFramePath, normalizeViews, selectPrimaryView } from "../src/viewConfig.js";
import { fetchViewFrame, viewServerFrameUrl } from "../src/rosViewBridge.js";

describe("simViews harness", () => {
  it("positive control: runner executes assertions", () => {
    assert.equal(1 + 1, 2);
  });

  it("negative control: intentional failure is detectable", () => {
    assert.throws(() => {
      assert.equal(1, 2);
    }, assert.AssertionError);
  });
});

describe("normalizeViews", () => {
  const validViews = [
    {
      id: "third-person",
      label: "Third Person",
      type: "ros-image",
      topic: "/birdseye_data",
      primary: true,
    },
    {
      id: "rgb",
      label: "RGB Camera",
      type: "ros-image",
      topic: "/image_data",
    },
    {
      id: "grid-map",
      label: "Grid Map",
      type: "ros-compressed",
      topic: "/map_renderer/map_img",
    },
  ];

  it("accepts a valid views array (positive control)", () => {
    const result = normalizeViews(validViews);
    assert.equal(result.ok, true);
    assert.equal(result.views.length, 3);
    assert.equal(result.views[0].id, "third-person");
    assert.equal(result.views[0].primary, true);
  });

  it("rejects duplicate ids (negative control)", () => {
    const result = normalizeViews([
      { id: "dup", label: "A", type: "ros-image", topic: "/a" },
      { id: "dup", label: "B", type: "ros-image", topic: "/b" },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.message, /Duplicate view id/);
  });

  it("rejects missing topic for ros-image (negative control)", () => {
    const result = normalizeViews([{ id: "bad", label: "Bad", type: "ros-image" }]);
    assert.equal(result.ok, false);
    assert.match(result.message, /requires "topic"/);
  });

  it("rejects unknown type (negative control)", () => {
    const result = normalizeViews([
      { id: "x", label: "X", type: "ros-lidar", topic: "/scan" },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.message, /unknown type/);
  });

  it("returns empty list when views omitted (positive control)", () => {
    const result = normalizeViews(null);
    assert.equal(result.ok, true);
    assert.deepEqual(result.views, []);
  });
});

describe("selectPrimaryView", () => {
  it("selects the primary view when flagged (positive control)", () => {
    const views = [
      { id: "rgb", primary: false },
      { id: "map", primary: true },
    ];
    assert.equal(selectPrimaryView(views)?.id, "map");
  });

  it("falls back to the first view when none are primary (positive control)", () => {
    const views = [{ id: "first" }, { id: "second" }];
    assert.equal(selectPrimaryView(views)?.id, "first");
  });
});

describe("view frame URLs", () => {
  it("builds the expected frame path (positive control)", () => {
    assert.equal(buildViewFramePath("rgb"), "/views/rgb/frame.jpg");
  });

  it("builds a full view-server URL (positive control)", () => {
    assert.equal(
      viewServerFrameUrl("http://127.0.0.1:8090", "third-person"),
      "http://127.0.0.1:8090/views/third-person/frame.jpg",
    );
  });
});

describe("fetchViewFrame", () => {
  const originalFetch = globalThis.fetch;

  it("returns JPEG bytes on HTTP 200 (positive control)", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff]).buffer,
    });

    const result = await fetchViewFrame("http://127.0.0.1:8090", "rgb");
    assert.equal(result.ok, true);
    assert.equal(result.contentType, "image/jpeg");
    assert.deepEqual([...result.buffer], [0xff, 0xd8, 0xff]);
    globalThis.fetch = originalFetch;
  });

  it("surfaces 404 when no frame exists yet (negative control)", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      text: async () => "No frame yet",
    });

    const result = await fetchViewFrame("http://127.0.0.1:8090", "rgb");
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    globalThis.fetch = originalFetch;
  });

  it("surfaces network failures as 503 (negative control)", async () => {
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };

    const result = await fetchViewFrame("http://127.0.0.1:8090", "rgb");
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.match(result.message, /unreachable/);
    globalThis.fetch = originalFetch;
  });
});
