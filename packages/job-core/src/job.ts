import type { JobMode } from "./request.js";
import type { JobState } from "./state-machine.js";

/**
 * The durable records. Each type is one table from the control-plane schema, one property per
 * column, and the mapping is mechanical: a column name converted from snake_case to camelCase.
 * Nothing is renamed, dropped or folded, so a store maps a row without inventing a translation
 * and a reader can check a record against the DDL by eye.
 *
 * Two deliberate representation choices:
 *
 * - A column that is nullable in SQL is `| null` here, not an optional property. A row always has
 *   the key; only its value is absent. This also sidesteps `exactOptionalPropertyTypes`, which
 *   forbids assigning `undefined` to an optional property — the mistake a row mapper would
 *   otherwise make on every nullable column.
 * - `retryable` and the other INTEGER-encoded booleans are `boolean | null`. Converting 0/1 at the
 *   store boundary keeps the rest of the control plane from re-deciding what 0 means.
 *
 * The fifth table, `artifacts`, is `Artifact` in `artifact.ts`, next to the publisher that mints it.
 */

/** `jobs`. The root of the record graph; every other table hangs off `job_id`. */
export type Job = {
  readonly jobId: string;
  /** The first job of a revision chain. A job with no parent is its own root. */
  readonly rootJobId: string;
  readonly parentJobId: string | null;
  readonly revisionNo: number;
  readonly mode: JobMode;
  readonly state: JobState;
  /** The validated request, serialised. Stored verbatim so a revision can replay what was asked. */
  readonly requestJson: string;
  readonly callerId: string;
  readonly idempotencyKey: string | null;
  readonly workspacePath: string | null;
  /** Set once the Hypit Build is submitted. Its presence is what stops a restart double-submitting. */
  readonly hypitBuildId: string | null;
  /** 0..1. Derived from the Build's own request counts, so it may stall but never goes backwards. */
  readonly progress: number;
  readonly attemptNo: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly heartbeatAt: string | null;
  /** Set by the cancel route. The worker reads it between stages and while polling. */
  readonly cancelRequestedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
};

/**
 * `job_events`. Exactly one row per state change, written in the same transaction as the `jobs`
 * update: a state change that is not durably recorded did not happen.
 */
export type JobEvent = {
  readonly eventId: number;
  readonly jobId: string;
  /** Per-job sequence, unique with `job_id`. The event order is the job's history. */
  readonly seq: number;
  readonly at: string;
  /** Null only for the row that records the job's creation, which comes from nowhere. */
  readonly fromState: JobState | null;
  readonly toState: JobState;
  readonly attemptNo: number;
  /** Why, in machine form — `stale_heartbeat`, `cancel_requested`, `qc_failed`, … */
  readonly reason: string | null;
  readonly detailJson: string | null;
  readonly hypitBuildId: string | null;
  readonly errorCode: string | null;
  readonly retryable: boolean | null;
};

/**
 * Known `reason` values. Exported as data so the store, the worker and an operator reading the
 * table all name the same event the same way; the column stays a free string so a new reason does
 * not need a migration.
 */
export const JOB_EVENT_REASONS = {
  created: "created",
  claimed: "claimed",
  stageAdvanced: "stage_advanced",
  staleHeartbeat: "stale_heartbeat",
  cancelRequested: "cancel_requested",
  cancelled: "cancelled",
  failed: "failed",
  completed: "completed",
} as const;

export type JobEventReason = (typeof JOB_EVENT_REASONS)[keyof typeof JOB_EVENT_REASONS];

/** How an attempt ended. Null while it is still running. */
export type AttemptOutcome = "succeeded" | "failed" | "cancelled";

export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ["succeeded", "failed", "cancelled"];

/**
 * `attempts`. A retry of a stage does NOT re-enter the state — the state machine forbids a
 * self-transition — it opens one of these instead, which is what keeps `job_events` free of loops
 * while still recording that the stage ran twice.
 */
export type Attempt = {
  readonly attemptId: string;
  readonly jobId: string;
  readonly attemptNo: number;
  readonly state: JobState;
  readonly workerId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: AttemptOutcome | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
};

/**
 * `revisions`. A revision is a new job that reuses part of its parent's work; the link is recorded
 * here as well as on the child job so the chain can be read from either end.
 */
export type Revision = {
  readonly revisionId: string;
  readonly rootJobId: string;
  readonly parentJobId: string;
  /** The child job this revision created. */
  readonly jobId: string;
  readonly revisionNo: number;
  /** What the caller asked to change. Subject to the same 20 000 character cap as an instruction. */
  readonly instruction: string;
  /** Which of the parent's outputs the child may reuse, serialised. */
  readonly reuseJson: string | null;
  readonly createdAt: string;
};
