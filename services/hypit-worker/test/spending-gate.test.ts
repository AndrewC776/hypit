import assert from "node:assert/strict";
import test from "node:test";

import { WorkerError, assertSpendingAllowed, planIsLocalOnly, spendingAuthorized } from "../src/index.js";
import { localPlan, paidPlan } from "./fake-hypit.js";
import { createHarness, eventTrace } from "./fixture.js";

test("a plan is local-only only when every count is zero and every provider is priced locally", async () => {
  assert.equal(planIsLocalOnly(localPlan()), true);
  assert.equal(planIsLocalOnly(paidPlan()), false);
  assert.equal(planIsLocalOnly({ ...localPlan(), unresolvedRequestCount: 1 }), false);
  assert.equal(planIsLocalOnly({
    ...localPlan(),
    providers: [{ name: "seedance", pricingKind: "metered" }],
  }), false);
  // A count the CLI did not report is not a zero: a plan we cannot account for must not spend.
  assert.equal(planIsLocalOnly({ ...localPlan(), providerRequestCount: null }), false);
  // And the adapter's own verdict is required as well, so loosening one definition loosens nothing.
  assert.equal(planIsLocalOnly({ ...localPlan(), localOnly: false }), false);
});

test("the spending gate refuses a paid plan and lets an authorized one through", async () => {
  assert.doesNotThrow(() => {
    assertSpendingAllowed(localPlan(), false);
  });
  assert.doesNotThrow(() => {
    assertSpendingAllowed(paidPlan(), true);
  });
  assert.throws(
    () => {
      assertSpendingAllowed(paidPlan(), false);
    },
    (error: unknown) => error instanceof WorkerError
      && error.code === "SPENDING_NOT_AUTHORIZED"
      && error.errorClass === "VALIDATION_FAILED"
      // Never retried: the same plan would be refused identically every time.
      && !error.retryable,
  );
});

test("a prepared_run request cannot carry a spending authorization at all", async () => {
  assert.equal(spendingAuthorized({
    mode: "prepared_run",
    project: "demo",
    run: "chat.svrun",
    output: { width: 540, height: 960, fps: 30 },
  }), false);
  assert.equal(spendingAuthorized({
    mode: "clone",
    reference: { type: "url", url: "https://www.tiktok.com/@a/video/1" },
    instruction: "shorter",
    assets: [],
    output: { width: 540, height: 960, fps: 30 },
    constraints: { spendingAuthorized: true },
  }), true);
});

test("a plan carrying a paid provider request fails the job before any Build is submitted", async () => {
  const harness = await createHarness();
  try {
    harness.hypit.plan = paidPlan();
    const queued = harness.queue();
    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "FAILED");
    assert.equal(terminal?.errorCode, "SPENDING_NOT_AUTHORIZED");
    assert.equal(terminal?.retryable, false);
    assert.equal(terminal?.hypitBuildId, null);

    // Nothing was submitted, and the job never even entered BUILDING, so no submit marker exists
    // for recovery to interpret later.
    assert.equal(harness.hypit.calls.submit, 0);
    const trace = eventTrace(harness.events(queued.jobId));
    assert.deepEqual(trace, [
      "-->QUEUED created",
      "QUEUED->PREPARING_WORKSPACE claimed",
      "PREPARING_WORKSPACE->VALIDATING stage_advanced",
      "VALIDATING->PLANNING stage_advanced",
      "PLANNING->FAILED failed",
    ]);
  } finally {
    await harness.close();
  }
});
