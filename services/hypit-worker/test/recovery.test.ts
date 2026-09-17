import assert from "node:assert/strict";
import test from "node:test";

import { JOB_EVENT_REASONS } from "@hypit/job-core";
import type { Job } from "@hypit/job-core";

import { WORKER_EVENT_REASONS } from "../src/index.js";
import { BUILD_ID, OTHER_BUILD_ID } from "./fake-hypit.js";
import { CRASHED_WORKER_ID, RUN_SOURCE, createHarness, eventTrace } from "./fixture.js";
import type { Harness } from "./fixture.js";

/**
 * Drives a job to the point of no return and stops: the submit marker is durable, the Build id is
 * not. This is the exact state a worker killed between `hypit build`'s submission and its printed
 * id leaves behind, and the one state in which submitting again would build — and pay — twice.
 */
function crashAfterSubmitMarker(harness: Harness): Job {
  const queued = harness.queue();
  harness.store.claimNext(CRASHED_WORKER_ID, harness.now());
  harness.store.recordTransition(queued.jobId, "VALIDATING", {
    now: harness.now(), reason: JOB_EVENT_REASONS.stageAdvanced,
  });
  harness.store.recordTransition(queued.jobId, "PLANNING", {
    now: harness.now(), reason: JOB_EVENT_REASONS.stageAdvanced,
  });
  harness.store.recordTransition(queued.jobId, "BUILDING", {
    now: harness.now(), reason: WORKER_EVENT_REASONS.buildSubmitMarker,
  });
  // Long enough that the store's stale recovery hands the job back to the queue.
  harness.clock.ms += 5_000;
  return queued;
}

test("a restart with a submit marker and no Build id adopts the existing Build", async () => {
  const harness = await createHarness();
  try {
    const queued = crashAfterSubmitMarker(harness);
    harness.hypit.builds = [
      { id: BUILD_ID, run: RUN_SOURCE, createdAt: "2026-09-17T12:11:34.939Z", outcome: "complete" },
    ];

    const terminal = await harness.loop.runOnce();

    // The whole point: not one second Build.
    assert.equal(harness.hypit.calls.submit, 0);
    assert.deepEqual(harness.hypit.submitted, []);
    assert.equal(harness.hypit.calls.list, 1);
    assert.equal(terminal?.hypitBuildId, BUILD_ID);
    assert.equal(terminal?.state, "COMPLETED");

    assert.deepEqual(eventTrace(harness.events(queued.jobId)), [
      "-->QUEUED created",
      "QUEUED->PREPARING_WORKSPACE claimed",
      "PREPARING_WORKSPACE->VALIDATING stage_advanced",
      "VALIDATING->PLANNING stage_advanced",
      "PLANNING->BUILDING build_submit_marker",
      "BUILDING->QUEUED stale_heartbeat",
      "QUEUED->PREPARING_WORKSPACE claimed",
      "PREPARING_WORKSPACE->BUILDING build_adopted",
      "BUILDING->RENDERING build_rendering",
      "RENDERING->QUALITY_CHECK stage_advanced",
      "QUALITY_CHECK->PUBLISHING stage_advanced",
      "PUBLISHING->COMPLETED completed",
    ]);
  } finally {
    await harness.close();
  }
});

test("two Builds in one job's project directory are never adopted by guesswork", async () => {
  const harness = await createHarness();
  try {
    crashAfterSubmitMarker(harness);
    harness.hypit.builds = [
      { id: BUILD_ID, run: RUN_SOURCE, createdAt: "2026-09-17T12:11:34.939Z", outcome: "complete" },
      { id: OTHER_BUILD_ID, run: RUN_SOURCE, createdAt: "2026-09-17T12:12:00.000Z", outcome: "working" },
    ];

    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "FAILED");
    assert.equal(terminal?.errorCode, "BUILD_ADOPTION_AMBIGUOUS");
    // PROVIDER_SUBMISSION_UNKNOWN: a human decides, because a wrong guess costs a whole Build.
    assert.equal(terminal?.retryable, false);
    assert.equal(harness.hypit.calls.submit, 0);
  } finally {
    await harness.close();
  }
});

test("a marker with no Build behind it means the CLI died before submitting, and the job runs", async () => {
  const harness = await createHarness();
  try {
    const queued = crashAfterSubmitMarker(harness);
    harness.hypit.builds = [];

    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "COMPLETED");
    // Exactly one submission in the job's whole life: the first attempt never made one.
    assert.equal(harness.hypit.calls.submit, 1);
    const trace = eventTrace(harness.events(queued.jobId));
    assert.equal(trace.includes("PREPARING_WORKSPACE->BUILDING build_adopted"), false);
    assert.equal(trace.filter((entry) => entry.endsWith("build_submit_marker")).length, 2);
  } finally {
    await harness.close();
  }
});
