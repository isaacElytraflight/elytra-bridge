import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadProject } from "../src/projectStore.js";

describe("stopScriptPath harness", () => {
  it("positive control: runner executes assertions", () => {
    assert.equal(1 + 1, 2);
  });

  it("negative control: intentional failure is detectable", () => {
    assert.throws(() => assert.equal(1, 2), assert.AssertionError);
  });
});

function writeTempProject(yamlBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "elytra-stop-"));
  fs.mkdirSync(path.join(root, "sim"));
  fs.mkdirSync(path.join(root, "real"));
  fs.writeFileSync(path.join(root, "project.yaml"), yamlBody, "utf8");
  return root;
}

describe("sim stopScriptPath", () => {
  it("loads stopScriptPath from project.yaml (positive control)", async () => {
    const root = writeTempProject(`
id: test-proj
name: Test
views:
  - id: rgb
    label: RGB
    type: ros-image
    topic: /image_data
    primary: true
sim:
  composeFile: sim/docker/docker-compose.yml
  containerName: test-sim
  startScriptPath: /workspace/scripts/start_sim.sh
  stopScriptPath: /workspace/scripts/stop_sim.sh
  tmuxSession: habitat
`);
    const project = await loadProject("test-proj", { projectRoot: root, mode: "sim" });
    assert.equal(project.modes.sim.stopScriptPath, "/workspace/scripts/stop_sim.sh");
  });

  it("defaults stopScriptPath to empty when omitted (negative control)", async () => {
    const root = writeTempProject(`
id: test-proj
name: Test
views:
  - id: rgb
    label: RGB
    type: ros-image
    topic: /image_data
    primary: true
sim:
  composeFile: sim/docker/docker-compose.yml
  containerName: test-sim
  startScriptPath: /workspace/scripts/start_sim.sh
`);
    const project = await loadProject("test-proj", { projectRoot: root, mode: "sim" });
    assert.equal(project.modes.sim.stopScriptPath, "");
  });
});
