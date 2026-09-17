import assert from "node:assert/strict";
import test from "node:test";

import { LocalArtifactPublisher } from "@hypit/job-core";

import { WorkerError, installShutdownHandlers, runJob } from "../src/index.js";
import { buildStatus } from "./fake-hypit.js";
import { WORKER_ID, createHarness } from "./fixture.js";

test("a worker whose Managed Programs are not ready refuses to start and claims nothing", async () => {
  const harness = await createHarness();
  try {
    // Contract 17.8: `build` throws before submitting when a program is down, and the worker does
    // not provision. Refusing to start is the honest response; claiming would queue up failures.
    harness.hypit.programs = { ready: false, readyCount: 1, totalCount: 2 };
    const queued = harness.queue();

    const refused = (error: unknown): boolean =>
      error instanceof WorkerError && error.code === "PROGRAMS_NOT_READY";
    await assert.rejects(harness.loop.run(), refused);
    // The single-step form refuses too: readiness is not a seam a caller can step around.
    await assert.rejects(harness.loop.runOnce(), refused);
    assert.equal(harness.store.readJob(queued.jobId)?.state, "QUEUED");
    assert.equal(harness.hypit.calls.check, 0);
  } finally {
    await harness.close();
  }
});

test("a stopped worker finishes without claiming anything else", async () => {
  const harness = await createHarness();
  try {
    const queued = harness.queue();
    harness.loop.stop();

    await harness.loop.run();

    assert.equal(harness.loop.stopping, true);
    assert.equal(harness.store.readJob(queued.jobId)?.state, "QUEUED");
  } finally {
    await harness.close();
  }
});

test("a long-running job keeps its heartbeat fresh while it is being worked on", async () => {
  const harness = await createHarness({ heartbeatIntervalMs: 5 });
  try {
    // Real elapsed time inside the poll, so the interval timer actually fires: everything else in
    // these tests moves a fake clock, but a heartbeat that only ever fired on a fake clock would
    // prove nothing about the worker staying visible to the store.
    harness.hypit.statusDelayMs = 30;
    harness.hypit.statuses = [buildStatus("running", null), buildStatus("complete")];
    const queued = harness.queue();

    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "COMPLETED");
    const claimedAt = harness.store.listEvents(queued.jobId)[1]?.at ?? "";
    const heartbeatAt = terminal?.heartbeatAt ?? "";
    // Both are `toISOString()` output, so they are fixed width and compare correctly as text.
    assert.equal(heartbeatAt > claimedAt, true);
  } finally {
    await harness.close();
  }
});

test("a run that lost its job or was asked to stop leaves the job alone", async () => {
  const harness = await createHarness();
  try {
    const queued = harness.queue();
    const claimed = harness.store.claimNext(WORKER_ID, harness.now());
    if (claimed === null) throw new Error("the queue held no claimable job");
    const deps = {
      config: harness.config,
      store: harness.store,
      hypit: harness.hypit,
      publisher: new LocalArtifactPublisher(),
      now: harness.now,
      sleep: async (): Promise<void> => {},
      newAttemptId: (): string => "att_lost",
    };

    // A refused heartbeat means another worker owns this job now; a stopping worker is on its way
    // out. Neither may fail the job: it is left non-terminal for the store's recovery to hand back.
    const afterLoss = await runJob(claimed, { lost: true, stopping: false }, deps);
    assert.equal(afterLoss.state, "PREPARING_WORKSPACE");
    const afterStop = await runJob(claimed, { lost: false, stopping: true }, deps);
    assert.equal(afterStop.state, "PREPARING_WORKSPACE");

    assert.equal(harness.hypit.calls.check, 0);
    assert.equal(harness.hypit.calls.submit, 0);
    assert.equal(harness.store.readJob(queued.jobId)?.errorCode, null);
  } finally {
    await harness.close();
  }
});

test("a termination signal stops an idle loop without waiting out its poll interval", async () => {
  const harness = await createHarness({ pollIntervalMs: 60_000 });
  try {
    const listeners = new Map<string, () => void>();
    installShutdownHandlers(harness.loop, {
      once(event: string, listener: () => void): unknown {
        listeners.set(event, listener);
        return this;
      },
    });
    assert.deepEqual([...listeners.keys()], ["SIGTERM", "SIGINT"]);

    // Nothing is queued, so the loop is asleep on a minute-long timer when the signal arrives.
    const running = harness.loop.run();
    listeners.get("SIGTERM")?.();
    await running;

    assert.equal(harness.loop.stopping, true);
  } finally {
    await harness.close();
  }
});
