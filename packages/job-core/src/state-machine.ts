import type { JobMode } from "./request.js";

export type JobState =
  | "QUEUED"
  | "PREPARING_WORKSPACE"
  | "DOWNLOADING_REFERENCE"
  | "ANALYZING_REFERENCE"
  | "AUTHORING"
  | "VALIDATING"
  | "PLANNING"
  | "GENERATING_ASSETS"
  | "BUILDING"
  | "RENDERING"
  | "QUALITY_CHECK"
  | "PUBLISHING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/**
 * The canonical forward order. A transition is legal iff it moves strictly forward in this list,
 * which is what lets `prepared_run` skip the reference and authoring stages without a second
 * machine: skipping forward is ordinary, going back is not.
 */
export const JOB_STATE_ORDER: readonly JobState[] = [
  "QUEUED",
  "PREPARING_WORKSPACE",
  "DOWNLOADING_REFERENCE",
  "ANALYZING_REFERENCE",
  "AUTHORING",
  "VALIDATING",
  "PLANNING",
  "GENERATING_ASSETS",
  "BUILDING",
  "RENDERING",
  "QUALITY_CHECK",
  "PUBLISHING",
  "COMPLETED",
];

export const TERMINAL_JOB_STATES: readonly JobState[] = ["COMPLETED", "FAILED", "CANCELLED"];

/** Every state, ordered path first, then the two states reachable from anywhere. */
export const JOB_STATES: readonly JobState[] = [...JOB_STATE_ORDER, "FAILED", "CANCELLED"];

const ORDER_INDEX: ReadonlyMap<JobState, number> = new Map(
  JOB_STATE_ORDER.map((state, index) => [state, index] as const),
);

const STATE_SET: ReadonlySet<string> = new Set(JOB_STATES);

/**
 * The expected path per mode, exported as data so the worker's stage list and the tests agree on
 * one definition instead of two drifting copies. The machine itself does not enforce a path — it
 * only enforces direction — because a stage may legitimately be skipped.
 */
export const MODE_STATE_PATHS: Readonly<Record<JobMode, readonly JobState[]>> = {
  prepared_run: [
    "QUEUED",
    "PREPARING_WORKSPACE",
    "VALIDATING",
    "PLANNING",
    "BUILDING",
    "RENDERING",
    "QUALITY_CHECK",
    "PUBLISHING",
    "COMPLETED",
  ],
  clone: JOB_STATE_ORDER,
};

export function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && STATE_SET.has(value);
}

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

/** Position on the forward path, or undefined for FAILED and CANCELLED, which are off it. */
export function jobStateOrder(state: JobState): number | undefined {
  return ORDER_INDEX.get(state);
}

export class JobStateTransitionError extends Error {
  readonly code = "JOB_STATE_TRANSITION_INVALID";
  readonly from: JobState;
  readonly to: JobState;

  constructor(from: JobState, to: JobState, reason: string) {
    super(`illegal job transition ${from} -> ${to}: ${reason}`);
    this.name = "JobStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

function rejection(from: JobState, to: JobState): string | undefined {
  if (from === to) {
    // A retry of the same stage opens a new attempt row; it never re-enters the state, so the
    // event log keeps one row per real state change and progress can never look like a loop.
    return "a stage retry opens a new attempt instead of re-entering the state";
  }
  if (isTerminalJobState(from)) return "a terminal state is immutable";
  if (to === "FAILED" || to === "CANCELLED") return undefined;
  if (to === "COMPLETED") {
    return from === "PUBLISHING" ? undefined : "COMPLETED is reachable only from PUBLISHING";
  }
  const fromIndex = ORDER_INDEX.get(from);
  const toIndex = ORDER_INDEX.get(to);
  if (fromIndex === undefined || toIndex === undefined) return "state is not on the forward path";
  // The stale-worker recovery path in the store deliberately moves a job back to QUEUED. That is a
  // recovery action recorded with its own reason, not a state transition, and it is refused here.
  return toIndex > fromIndex ? undefined : "transitions are forward-only";
}

export function canTransition(from: JobState, to: JobState): boolean {
  return rejection(from, to) === undefined;
}

export function assertTransition(from: JobState, to: JobState): void {
  const reason = rejection(from, to);
  if (reason !== undefined) throw new JobStateTransitionError(from, to, reason);
}
