import { createJobId } from "@hypit/job-core";
import type { Job } from "@hypit/job-core";

import { JobStore } from "../src/index.js";

/**
 * A fixed UTC instant. Every id and timestamp in these tests is derived from it, so an assertion
 * reads as an exact value rather than "roughly now" — which is also the only way to test the stale
 * recovery window without sleeping.
 */
export const CLOCK_BASE = Date.UTC(2026, 8, 17, 11, 0, 0);

export function at(offsetMs: number): string {
  return new Date(CLOCK_BASE + offsetMs).toISOString();
}

/** Ids are minted from the same offset, so a job's id and its `created_at` agree by construction. */
export function jobIdAt(offsetMs: number): string {
  return createJobId({
    now: () => CLOCK_BASE + offsetMs,
    nonce: () => offsetMs.toString(16).toUpperCase().padStart(8, "0"),
  });
}

export const WORKER_A = "wkr_probe_101_0000000A";
export const WORKER_B = "wkr_probe_102_0000000B";

const REQUEST = JSON.stringify({
  mode: "prepared_run",
  project: "semantic-composition",
  run: "chat.svrun",
  output: { width: 540, height: 960, fps: 30 },
});

export type QueuedJobOptions = {
  readonly offsetMs?: number;
  readonly callerId?: string;
  readonly idempotencyKey?: string;
  readonly jobId?: string;
};

export function queueJob(store: JobStore, options: QueuedJobOptions = {}): Job {
  const offsetMs = options.offsetMs ?? 0;
  return store.createJob({
    jobId: options.jobId ?? jobIdAt(offsetMs),
    mode: "prepared_run",
    requestJson: REQUEST,
    callerId: options.callerId ?? "caller-a",
    now: at(offsetMs),
    // Conditional spread, not `key: options.idempotencyKey`: exactOptionalPropertyTypes refuses
    // undefined for an optional property, and "absent" and "null" mean different things here.
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  }).job;
}
