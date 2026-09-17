import assert from "node:assert/strict";
import test from "node:test";

import { CANCEL_REASON } from "../src/index.js";
import { BUILD_ID, buildStatus } from "./fake-hypit.js";
import { createHarness, eventTrace } from "./fixture.js";

test("a cancel requested while a Build is running cancels the Build and ends the job CANCELLED", async () => {
  const harness = await createHarness();
  try {
    const queued = harness.queue();
    // The Build never reports progress, so the job is still in BUILDING when the flag arrives —
    // and the flag arrives the way it really does, from the API, in the middle of a poll loop.
    harness.hypit.statuses = [buildStatus("running", null)];
    harness.hypit.onStatus = (call: number): void => {
      if (call === 1) harness.store.requestCancel(queued.jobId, harness.now());
    };

    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "CANCELLED");
    assert.equal(terminal?.errorCode, "CANCELLED");
    assert.equal(terminal?.retryable, false);
    assert.equal(terminal?.hypitBuildId, BUILD_ID);
    // Contract 17.7: requested is all anyone may claim. The record says so in as many words.
    assert.match(terminal?.errorMessage ?? "", /cancellation requested/u);

    assert.deepEqual(harness.hypit.cancelledBuilds, [BUILD_ID]);
    assert.deepEqual(eventTrace(harness.events(queued.jobId)), [
      "-->QUEUED created",
      "QUEUED->PREPARING_WORKSPACE claimed",
      "PREPARING_WORKSPACE->VALIDATING stage_advanced",
      "VALIDATING->PLANNING stage_advanced",
      "PLANNING->BUILDING build_submit_marker",
      "BUILDING->CANCELLED cancelled",
    ]);
    // Nothing was exported or published from a cancelled job.
    assert.equal(harness.hypit.calls.export, 0);
    assert.deepEqual(harness.store.listArtifacts(queued.jobId), []);
  } finally {
    await harness.close();
  }
});

test("a cancellation reason is short prose the adapter's argument rules accept", async () => {
  // The adapter rejects a reason with a separator, a dash-leading value or a line break before it
  // spawns anything; a constant that failed that check would fail every cancellation.
  assert.match(CANCEL_REASON, /^[A-Za-z0-9][A-Za-z0-9 ._,:-]{0,199}$/u);
});

test("a Build cancelled outside the control plane ends the job CANCELLED rather than COMPLETED", async () => {
  const harness = await createHarness();
  try {
    // A cancelled Build exits 0, so only the Build view says what happened (contract 17.1).
    harness.hypit.statuses = [buildStatus("cancelled")];
    const queued = harness.queue();
    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "CANCELLED");
    assert.equal(eventTrace(harness.events(queued.jobId)).at(-1), "BUILDING->CANCELLED cancelled");
  } finally {
    await harness.close();
  }
});
