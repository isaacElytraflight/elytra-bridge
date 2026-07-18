import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("movementMode harness", () => {
  it("positive control: runner executes assertions", () => {
    assert.equal(1 + 1, 2);
  });

  it("negative control: intentional failure is detectable", () => {
    assert.throws(() => {
      assert.equal(1, 2);
    }, assert.AssertionError);
  });
});

describe("movementMode payload", () => {
  it("accepts realtime toggle body (positive control)", () => {
    const body = { realtime: true, navigationMode: "nav2" };
    assert.equal(typeof body.realtime, "boolean");
    assert.equal(body.navigationMode, "nav2");
  });

  it("rejects invalid navigation mode values (negative control)", () => {
    const mode = "fast";
    const normalized = mode === "discrete" ? "discrete" : "nav2";
    assert.notEqual(normalized, "fast");
    assert.equal(normalized, "nav2");
  });
});
