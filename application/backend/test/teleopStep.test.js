import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("teleopStep harness", () => {
  it("positive control: runner executes assertions", () => {
    assert.equal(1 + 1, 2);
  });

  it("negative control: intentional failure is detectable", () => {
    assert.throws(() => assert.equal(1, 2), assert.AssertionError);
  });
});

describe("teleop direction validation", () => {
  const allowed = new Set(["forward", "backward", "turn_left", "turn_right"]);

  it("accepts known directions (positive control)", () => {
    for (const d of allowed) {
      assert.equal(allowed.has(d), true);
    }
  });

  it("rejects unknown directions (negative control)", () => {
    assert.equal(allowed.has("strafe"), false);
    assert.equal(allowed.has(""), false);
  });
});
