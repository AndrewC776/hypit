import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  JOB_EVENT_REASONS,
  JOB_STATES,
  MODE_STATE_PATHS,
  JobStateTransitionError,
  jobError,
} from "@hypit/job-core";
import type { Artifact, JobState } from "@hypit/job-core";

import { JobStore } from "../src/index.js";
import { WORKER_A, WORKER_B, at, jobIdAt, queueJob } from "./fixture.js";

function countJobs(path: string): number {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare("SELECT COUNT(*) AS total FROM jobs").get() as Record<string, unknown>;
    return typeof row.total === "number" ? row.total : -1;
  } finally {
    database.close();
  }
}

test("claiming an empty queue yields null", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-claim-empty-"));
  const store = new JobStore(join(directory, "jobs.sqlite3"));
  try {
    assert.equal(store.claimNext(WORKER_A, at(0)), null);
    // A cancelled job is not claimable either, so the queue stays empty after one is cancelled.
    const job = queueJob(store, { offsetMs: 0 });
    store.requestCancel(job.jobId, at(10));
    assert.equal(store.claimNext(WORKER_A, at(20)), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two store handles over one database file never claim the same job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-claim-race-"));
  const path = join(directory, "jobs.sqlite3");
  const first = new JobStore(path);
  const second = new JobStore(path);
  try {
    const older = queueJob(first, { offsetMs: 0 });
    const newer = queueJob(first, { offsetMs: 60_000 });

    const claimedByFirst = first.claimNext(WORKER_A, at(120_000));
    const claimedBySecond = second.claimNext(WORKER_B, at(120_001));
    assert.notEqual(claimedByFirst, null);
    assert.notEqual(claimedBySecond, null);
    assert.notEqual(claimedByFirst?.jobId, claimedBySecond?.jobId);
    // Oldest first: the claim orders by created_at, so the queue is FIFO.
    assert.equal(claimedByFirst?.jobId, older.jobId);
    assert.equal(claimedBySecond?.jobId, newer.jobId);

    assert.equal(claimedByFirst?.state, "PREPARING_WORKSPACE");
    assert.equal(claimedByFirst?.claimedBy, WORKER_A);
    assert.equal(claimedByFirst?.claimedAt, at(120_000));
    assert.equal(claimedByFirst?.heartbeatAt, at(120_000));
    assert.equal(claimedByFirst?.attemptNo, 1);

    // Nothing claimable is left, and the second handle sees that too.
    assert.equal(first.claimNext(WORKER_A, at(120_002)), null);
    assert.equal(second.claimNext(WORKER_B, at(120_003)), null);

    // The narrow case the atomic claim exists for: one job, two handles, and exactly one winner.
    const lone = queueJob(first, { offsetMs: 180_000 });
    assert.equal(second.claimNext(WORKER_B, at(240_000))?.jobId, lone.jobId);
    assert.equal(first.claimNext(WORKER_A, at(240_001)), null);
  } finally {
    second.close();
    first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a repeated idempotency key returns the same job and inserts exactly one row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-idempotency-"));
  const path = join(directory, "jobs.sqlite3");
  const store = new JobStore(path);
  try {
    const created = store.createJob({
      jobId: jobIdAt(0), mode: "prepared_run", requestJson: "{}", callerId: "caller-a",
      now: at(0), idempotencyKey: "key-1",
    });
    assert.equal(created.replayed, false);
    // The defaults the schema promises, read back through the row mapper: a new job is QUEUED, has
    // made no attempt, is its own revision root, and carries no failure yet.
    assert.equal(created.job.state, "QUEUED");
    assert.equal(created.job.progress, 0);
    assert.equal(created.job.attemptNo, 0);
    assert.equal(created.job.revisionNo, 1);
    assert.equal(created.job.rootJobId, created.job.jobId);
    assert.equal(created.job.parentJobId, null);
    assert.equal(created.job.retryable, null);
    assert.equal(created.job.terminalAt, null);

    // A different job id, the same caller and key: the partial unique index refuses the insert and
    // the store re-reads the winner instead of creating a second job.
    const replay = store.createJob({
      jobId: jobIdAt(1_000), mode: "prepared_run", requestJson: "{}", callerId: "caller-a",
      now: at(1_000), idempotencyKey: "key-1",
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.job.jobId, created.job.jobId);
    assert.equal(replay.job.createdAt, at(0));
    assert.equal(countJobs(path), 1);
    // The refused insert wrote no history: only the creation event exists.
    assert.deepEqual(store.listEvents(created.job.jobId).map((event) => event.seq), [1]);

    // The key is scoped to the caller, so another caller may reuse it.
    const otherCaller = store.createJob({
      jobId: jobIdAt(2_000), mode: "prepared_run", requestJson: "{}", callerId: "caller-b",
      now: at(2_000), idempotencyKey: "key-1",
    });
    assert.equal(otherCaller.replayed, false);

    // And an absent key never collides, however many jobs are created without one.
    for (const offsetMs of [3_000, 4_000, 5_000]) queueJob(store, { offsetMs });
    assert.equal(countJobs(path), 5);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an illegal transition is refused and writes no event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-illegal-"));
  const store = new JobStore(join(directory, "jobs.sqlite3"));
  try {
    const job = queueJob(store);
    const isRefusal = (error: unknown): boolean =>
      error instanceof JobStateTransitionError && error.code === "JOB_STATE_TRANSITION_INVALID";

    // A stage retry opens an attempt; it never re-enters the state.
    assert.throws(() => store.recordTransition(job.jobId, "QUEUED", { now: at(10) }), isRefusal);
    store.claimNext(WORKER_A, at(20));
    // Backwards, and COMPLETED from anywhere but PUBLISHING.
    assert.throws(() => store.recordTransition(job.jobId, "QUEUED", { now: at(30) }), isRefusal);
    assert.throws(() => store.recordTransition(job.jobId, "COMPLETED", { now: at(40) }), isRefusal);

    assert.equal(store.readJob(job.jobId)?.state, "PREPARING_WORKSPACE");
    assert.equal(store.readJob(job.jobId)?.updatedAt, at(20));
    assert.deepEqual(store.listEvents(job.jobId).map((event) => event.toState),
      ["QUEUED", "PREPARING_WORKSPACE"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a terminal job refuses every further transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-terminal-"));
  const store = new JobStore(join(directory, "jobs.sqlite3"));
  try {
    const job = queueJob(store);
    const failure = jobError({
      class: "VALIDATION_FAILED", code: "VALIDATION_FAILED", message: "the project key is unknown",
    });
    const failed = store.recordTransition(job.jobId, "FAILED", {
      now: at(10), reason: JOB_EVENT_REASONS.failed, error: failure,
    });
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.terminalAt, at(10));
    assert.equal(failed.errorCode, "VALIDATION_FAILED");
    assert.equal(failed.retryable, false);

    for (const state of JOB_STATES) {
      assert.throws(() => store.recordTransition(job.jobId, state, { now: at(20) }),
        (error: unknown) => error instanceof JobStateTransitionError,
        `${state} must be refused from a terminal job`);
    }
    // Cancelling a finished job does not rewrite it either.
    const cancel = store.requestCancel(job.jobId, at(30));
    assert.equal(cancel.cancelled, false);
    assert.equal(cancel.job.state, "FAILED");
    assert.equal(cancel.job.cancelRequestedAt, null);
    assert.equal(store.listEvents(job.jobId).length, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale recovery requeues a job and fails it once its attempts are exhausted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-stale-"));
  const store = new JobStore(join(directory, "jobs.sqlite3"));
  try {
    const job = queueJob(store, { offsetMs: 0 });
    assert.equal(store.claimNext(WORKER_A, at(1_000))?.attemptNo, 1);

    // A fresh heartbeat is not stale, however many recovery sweeps run.
    assert.deepEqual(store.recoverStale({ now: at(61_000), staleAfterMs: 120_000, maxAttempts: 2 }), []);

    assert.deepEqual(store.recoverStale({ now: at(300_000), staleAfterMs: 120_000, maxAttempts: 2 }), [
      { jobId: job.jobId, fromState: "PREPARING_WORKSPACE", attemptNo: 1, outcome: "requeued" },
    ]);
    const requeued = store.readJob(job.jobId);
    assert.equal(requeued?.state, "QUEUED");
    assert.equal(requeued?.claimedBy, null);
    assert.equal(requeued?.heartbeatAt, null);
    assert.equal(requeued?.attemptNo, 1);

    // Requeued means claimable again, by a different worker this time.
    assert.equal(store.claimNext(WORKER_B, at(310_000))?.attemptNo, 2);
    assert.deepEqual(store.recoverStale({ now: at(600_000), staleAfterMs: 120_000, maxAttempts: 2 }), [
      { jobId: job.jobId, fromState: "PREPARING_WORKSPACE", attemptNo: 2, outcome: "failed" },
    ]);
    const failed = store.readJob(job.jobId);
    assert.equal(failed?.state, "FAILED");
    assert.equal(failed?.errorCode, "INTERNAL");
    assert.equal(failed?.retryable, false);
    assert.equal(failed?.terminalAt, at(600_000));
    assert.equal(failed?.claimedBy, null);

    const events = store.listEvents(job.jobId);
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(events.map((event) => event.toState),
      ["QUEUED", "PREPARING_WORKSPACE", "QUEUED", "PREPARING_WORKSPACE", "FAILED"]);
    assert.deepEqual(events.map((event) => event.reason), [
      JOB_EVENT_REASONS.created, JOB_EVENT_REASONS.claimed, JOB_EVENT_REASONS.staleHeartbeat,
      JOB_EVENT_REASONS.claimed, JOB_EVENT_REASONS.staleHeartbeat,
    ]);
    // A terminal job is never swept again.
    assert.deepEqual(store.recoverStale({ now: at(900_000), staleAfterMs: 120_000, maxAttempts: 2 }), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelling a queued job ends it, and cancelling a claimed job only records the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-cancel-"));
  const store = new JobStore(join(directory, "jobs.sqlite3"));
  try {
    const queued = queueJob(store, { offsetMs: 0 });
    const outcome = store.requestCancel(queued.jobId, at(10));
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.job.state, "CANCELLED");
    assert.equal(outcome.job.cancelRequestedAt, at(10));
    assert.equal(outcome.job.terminalAt, at(10));
    assert.equal(outcome.job.errorCode, "CANCELLED");
    assert.equal(outcome.job.retryable, false);
    assert.deepEqual(store.listEvents(queued.jobId).map((event) => event.toState), ["QUEUED", "CANCELLED"]);

    // A claimed job is the worker's to finish: the store records the request and nothing else,
    // because only the worker can ask Hypit to stop the Build it already submitted.
    const running = queueJob(store, { offsetMs: 60_000 });
    store.claimNext(WORKER_A, at(120_000));
    const flagged = store.requestCancel(running.jobId, at(130_000));
    assert.equal(flagged.cancelled, false);
    assert.equal(flagged.job.state, "PREPARING_WORKSPACE");
    assert.equal(flagged.job.cancelRequestedAt, at(130_000));
    assert.deepEqual(store.listEvents(running.jobId).map((event) => event.toState),
      ["QUEUED", "PREPARING_WORKSPACE"]);

    // A second request keeps the first one's time: the flag records when cancellation was asked for.
    assert.equal(store.requestCancel(running.jobId, at(140_000)).job.cancelRequestedAt, at(130_000));

    // The worker then ends the job itself, which is an ordinary transition.
    const cancelled = store.recordTransition(running.jobId, "CANCELLED", {
      now: at(150_000), reason: JOB_EVENT_REASONS.cancelRequested,
    });
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(cancelled.terminalAt, at(150_000));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("every state change writes exactly one event with a contiguous sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-events-"));
  const store = new JobStore(join(directory, "jobs.sqlite3"));
  try {
    const expected = MODE_STATE_PATHS.prepared_run;
    const job = queueJob(store, { offsetMs: 0 });
    store.claimNext(WORKER_A, at(1_000));
    let offsetMs = 2_000;
    // The claim already moved the job to the path's second state, so the loop resumes at the third.
    for (const state of expected.slice(2)) {
      store.recordTransition(job.jobId, state, {
        now: at(offsetMs), reason: JOB_EVENT_REASONS.stageAdvanced, progress: 0.5,
      });
      offsetMs += 1_000;
    }

    const events = store.listEvents(job.jobId);
    assert.deepEqual(events.map((event) => event.seq),
      Array.from({ length: expected.length }, (_unused, index) => index + 1));
    assert.deepEqual(events.map((event) => event.toState), [...expected]);
    // Each event's from_state is the previous event's to_state; the creation event comes from nowhere.
    assert.deepEqual(events.map((event) => event.fromState),
      [null, ...expected.slice(0, -1)] as readonly (JobState | null)[]);
    assert.deepEqual(events.map((event) => event.attemptNo), [0, ...expected.slice(1).map(() => 1)]);

    const completed = store.readJob(job.jobId);
    assert.equal(completed?.state, "COMPLETED");
    assert.equal(completed?.progress, 0.5);
    assert.equal(completed?.terminalAt, at(offsetMs - 1_000));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a heartbeat refreshes only the claiming worker's live job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-heartbeat-"));
  const store = new JobStore(join(directory, "jobs.sqlite3"));
  try {
    const job = queueJob(store);
    assert.equal(store.heartbeat(job.jobId, WORKER_A, at(10)), false, "an unclaimed job has no worker");
    store.claimNext(WORKER_A, at(20));
    assert.equal(store.heartbeat(job.jobId, WORKER_A, at(30)), true);
    assert.equal(store.readJob(job.jobId)?.heartbeatAt, at(30));
    // The worker that lost the job to a recovery sweep learns it from a false heartbeat.
    assert.equal(store.heartbeat(job.jobId, WORKER_B, at(40)), false);
    assert.equal(store.readJob(job.jobId)?.heartbeatAt, at(30));

    store.recordTransition(job.jobId, "FAILED", {
      now: at(50), reason: JOB_EVENT_REASONS.failed,
      error: jobError({ class: "INTERNAL", code: "INTERNAL", message: "stage handler threw" }),
    });
    assert.equal(store.heartbeat(job.jobId, WORKER_A, at(60)), false, "a terminal job is not reported on");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("attempts, revisions and artifacts hang off a job and cannot outlive one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-records-"));
  const store = new JobStore(join(directory, "jobs.sqlite3"));
  try {
    const parent = queueJob(store, { offsetMs: 0 });
    store.claimNext(WORKER_A, at(1_000));

    store.startAttempt({
      attemptId: `${parent.jobId}_1_BUILDING`, jobId: parent.jobId, attemptNo: 1,
      state: "PREPARING_WORKSPACE", workerId: WORKER_A, startedAt: at(1_000),
    });
    const closed = store.finishAttempt(`${parent.jobId}_1_BUILDING`, {
      endedAt: at(2_000), outcome: "succeeded",
    });
    assert.equal(closed?.outcome, "succeeded");
    assert.equal(closed?.endedAt, at(2_000));
    assert.deepEqual(store.listAttempts(parent.jobId).map((attempt) => attempt.attemptNo), [1]);
    assert.equal(store.finishAttempt("attempt-that-does-not-exist", {
      endedAt: at(2_000), outcome: "failed",
    }), undefined);

    const child = store.createJob({
      jobId: jobIdAt(3_000), mode: "prepared_run", requestJson: "{}", callerId: "caller-a",
      now: at(3_000), rootJobId: parent.jobId, parentJobId: parent.jobId, revisionNo: 2,
    }).job;
    store.addRevision({
      revisionId: "rev_20260917T110003000Z_0000000B", rootJobId: parent.jobId,
      parentJobId: parent.jobId, jobId: child.jobId, revisionNo: 2,
      instruction: "shorten the opening beat", reuseJson: JSON.stringify({ reusePlan: true }),
      createdAt: at(3_000),
    });
    assert.deepEqual(store.listRevisions(parent.jobId).map((revision) => revision.jobId), [child.jobId]);

    const artifact: Artifact = {
      artifactId: "art_20260917T110004000Z_0000000C", jobId: parent.jobId, kind: "video",
      name: "final.mp4", uri: pathToFileURL(join(directory, "final.mp4")).href,
      mediaType: "video/mp4", bytes: 75_314, checksumSha256: "a".repeat(64), width: 540,
      height: 960, durationSeconds: 8, fps: 30, createdAt: at(4_000),
    };
    store.addArtifact(artifact);
    assert.deepEqual(store.listArtifacts(parent.jobId), [artifact]);
    assert.deepEqual(store.listArtifacts(child.jobId), []);

    // foreign_keys is ON, so an artifact for a job that does not exist is refused outright.
    assert.throws(() => store.addArtifact({ ...artifact, artifactId: "art_20260917T110005000Z_0000000D", jobId: jobIdAt(9_000) }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as { readonly code?: unknown }).code === "ERR_SQLITE_ERROR");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
