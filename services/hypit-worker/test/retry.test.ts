import assert from "node:assert/strict";
import test from "node:test";

import { AdapterError } from "@hypit/hypit-adapter";

import { createHarness, eventTrace } from "./fixture.js";

test("a retryable transport failure is retried up to maxAttempts and then fails the job", async () => {
  const harness = await createHarness({ maxAttempts: 3 });
  try {
    harness.hypit.throwOnCheck = new AdapterError({
      class: "RETRYABLE_TRANSPORT",
      code: "ETIMEDOUT",
      message: "the endpoint timed out",
    });
    const queued = harness.queue();
    const terminal = await harness.loop.runOnce();

    // Bounded, and bounded per stage: three calls, not an unbounded loop.
    assert.equal(harness.hypit.calls.check, 3);
    assert.equal(terminal?.state, "FAILED");
    assert.equal(terminal?.errorCode, "ETIMEDOUT");
    // The class is not rewritten on the way out: it was retryable, and it was retried.
    assert.equal(terminal?.retryable, true);

    // One attempt row per try, each with its own number, all in the stage's own state.
    const attempts = harness.store.listAttempts(queued.jobId)
      .filter((attempt) => attempt.state === "VALIDATING");
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map((attempt) => attempt.outcome), ["failed", "failed", "failed"]);
    assert.equal(new Set(attempts.map((attempt) => attempt.attemptNo)).size, 3);

    assert.equal(eventTrace(harness.events(queued.jobId)).at(-1), "VALIDATING->FAILED failed");
    // Nothing was planned or submitted: the pipeline never got past validation.
    assert.equal(harness.hypit.calls.plan, 0);
    assert.equal(harness.hypit.calls.submit, 0);
  } finally {
    await harness.close();
  }
});

test("a submission with an unknown outcome is never retried", async () => {
  const harness = await createHarness();
  try {
    // Contract 17.4: EXECUTION_UNKNOWN and SUBMISSION_INTERRUPTED mean the operation may already
    // have been accepted and charged. Retrying can double-charge, so the job fails for a human.
    harness.hypit.throwOnSubmit = new AdapterError({
      class: "PROVIDER_SUBMISSION_UNKNOWN",
      code: "SUBMISSION_INTERRUPTED",
      message: "the submission was interrupted",
    });
    const queued = harness.queue();
    const terminal = await harness.loop.runOnce();

    assert.equal(harness.hypit.calls.submit, 1);
    assert.equal(terminal?.state, "FAILED");
    assert.equal(terminal?.errorCode, "SUBMISSION_INTERRUPTED");
    assert.equal(terminal?.retryable, false);

    // The marker survives the failure, so a later operator or worker knows a Build may exist.
    const trace = eventTrace(harness.events(queued.jobId));
    assert.equal(trace.includes("PLANNING->BUILDING build_submit_marker"), true);
    assert.equal(trace.at(-1), "BUILDING->FAILED failed");
    const attempts = harness.store.listAttempts(queued.jobId)
      .filter((attempt) => attempt.state === "BUILDING");
    assert.equal(attempts.length, 1);
  } finally {
    await harness.close();
  }
});

test("a validation failure is not retried either", async () => {
  const harness = await createHarness();
  try {
    harness.hypit.check = { ok: false, sourceKind: "run", source: null, outputCount: null, omitted: [] };
    harness.queue();
    const terminal = await harness.loop.runOnce();

    assert.equal(harness.hypit.calls.check, 1);
    assert.equal(terminal?.state, "FAILED");
    assert.equal(terminal?.retryable, false);
  } finally {
    await harness.close();
  }
});
