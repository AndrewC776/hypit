import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { WorkerError, jobPaths, prepareWorkspace, resolveProjectPath } from "../src/index.js";
import { PROJECT_KEY, createHarness } from "./fixture.js";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

test("a prepared workspace copies the project without .hypit, node_modules or a runtime profile", async () => {
  const harness = await createHarness();
  try {
    const queued = harness.queue();
    const paths = await prepareWorkspace(harness.config, queued.jobId, PROJECT_KEY);

    // What Hypit needs: the run source and each component's prebuilt dist/ (contract 16.2).
    assert.equal(await exists(join(paths.project, "chat.svrun")), true);
    assert.equal(await exists(join(paths.project, "components", "chat", "dist", "activation.js")), true);
    // What would poison the job: another run's Results, an installed tree, a competing profile.
    assert.equal(await exists(join(paths.project, ".hypit")), false);
    assert.equal(await exists(join(paths.project, "node_modules")), false);
    assert.equal(await exists(join(paths.project, "hypit.runtime.json")), false);
    assert.equal(await exists(join(paths.project, "hypit.runtime.local.json")), false);

    for (const directory of [paths.input, paths.project, paths.output, paths.logs]) {
      assert.equal(await exists(directory), true);
    }
    // The copy is idempotent: a resumed job re-prepares rather than failing on its own leftovers.
    await prepareWorkspace(harness.config, queued.jobId, PROJECT_KEY);
    assert.equal(await exists(join(paths.project, "chat.svrun")), true);
  } finally {
    await harness.close();
  }
});

test("a job workspace is owner-only", { skip: process.platform === "win32" }, async () => {
  const harness = await createHarness();
  try {
    const queued = harness.queue();
    const paths = await prepareWorkspace(harness.config, queued.jobId, PROJECT_KEY);
    const mode = (await stat(paths.root)).mode & 0o777;
    assert.equal(mode, 0o700);
  } finally {
    await harness.close();
  }
});

test("a project key absent from the registry resolves to nothing and prepares nothing", async () => {
  const harness = await createHarness();
  try {
    assert.throws(
      () => resolveProjectPath(harness.config, "ghost"),
      (error: unknown) => error instanceof WorkerError
        && error.code === "PROJECT_NOT_REGISTERED"
        && error.errorClass === "VALIDATION_FAILED",
    );

    const queued = harness.queue({ project: "ghost" });
    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "FAILED");
    assert.equal(terminal?.errorCode, "PROJECT_NOT_REGISTERED");
    assert.equal(terminal?.retryable, false);
    // No key, no path: the job's own directory was never even created.
    assert.equal(await exists(jobPaths(harness.config.jobsRoot, queued.jobId).root), false);
    assert.equal(harness.hypit.calls.check, 0);
  } finally {
    await harness.close();
  }
});

test("a mode this worker does not implement fails the job instead of half-running it", async () => {
  const harness = await createHarness();
  try {
    harness.queue({ mode: "clone" });
    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "FAILED");
    assert.equal(terminal?.errorCode, "MODE_NOT_IMPLEMENTED");
    assert.equal(harness.hypit.calls.check, 0);
  } finally {
    await harness.close();
  }
});
