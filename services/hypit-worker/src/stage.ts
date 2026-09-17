/**
 * What a stage is.
 *
 * A stage is a small function of `(job, ctx)`. It does not decide which state it runs in, when it
 * is retried or how its failure is classified — the pipeline declares the first, the runner decides
 * the second, and the failure class decides the third. That split is what keeps each handler short
 * enough to read in one screen and testable without a loop around it.
 *
 * A handler records nothing directly on the `jobs` row: it returns what it established, and the
 * runner writes it on the transition that enters the next stage, so every durable change still
 * travels with exactly one event. The one exception is `ctx.advance`, which the build stage needs
 * because it crosses a state boundary of its own (BUILDING to RENDERING) and because a Build id
 * must become durable the moment it is known.
 */
import type { ArtifactPublisher, ErrorClass, Job, JobError, JobState, PreparedRunRequest } from "@hypit/job-core";
import type { FfprobeContext, HypitContext, VideoProbe } from "@hypit/hypit-adapter";
import type { JobStore } from "@hypit/job-store-sqlite";

import type { WorkerConfig } from "./config.js";
import type { HypitPort } from "./hypit-port.js";
import type { JobPaths } from "./workspace.js";

export type StageName = "prepare" | "validate" | "plan" | "build" | "export" | "qc" | "publish";

/**
 * The little that crosses stage boundaries. Each field is written by exactly one stage and read by
 * exactly one other — the probe by QC for publish, the exported path by export for QC — which is
 * why this is a plain record and not a message bus. Everything else a stage learns is either
 * recorded on the job or re-read from the CLI.
 */
export type StageNotes = {
  buildComplete: boolean;
  probe: VideoProbe | null;
  exportedPath: string | null;
};

export function newStageNotes(): StageNotes {
  return { buildComplete: false, probe: null, exportedPath: null };
}

/** Liveness shared between the loop and the run it is heartbeating for. */
export type RunSignal = {
  /** Set when a heartbeat is refused: another worker owns this job now, so we must stop touching it. */
  lost: boolean;
  /** Set by SIGTERM. The run stops at the next stage boundary, leaving the job for recovery. */
  stopping: boolean;
};

export type AdvanceOptions = {
  readonly reason?: string;
  readonly detail?: unknown;
  readonly progress?: number;
  readonly workspacePath?: string;
  readonly hypitBuildId?: string;
  readonly error?: JobError;
};

export type StageContext = {
  readonly config: WorkerConfig;
  readonly store: JobStore;
  readonly hypit: HypitPort;
  readonly publisher: ArtifactPublisher;
  /** The request as validated, not as stored: a corrupted row fails the job rather than driving it. */
  readonly request: PreparedRunRequest;
  readonly paths: JobPaths;
  readonly hypitContext: HypitContext;
  readonly ffprobeContext: FfprobeContext;
  readonly notes: StageNotes;
  readonly signal: RunSignal;
  /** ISO-8601 UTC. Injected, so a test asserts an exact timestamp instead of "roughly now". */
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  /** A fresh read of `cancel_requested_at`, never a cached one: the flag arrives while we work. */
  readonly cancelRequested: () => boolean;
  readonly currentJob: () => Job;
  readonly advance: (to: JobState, options: AdvanceOptions) => Job;
};

export type StageOutcome = {
  readonly progress?: number;
  readonly workspacePath?: string;
  readonly hypitBuildId?: string;
  /** Recorded in the next transition's `detail_json`, which is the stage's own audit trail. */
  readonly detail?: unknown;
  /** Set when the stage already ended the job — cancellation seen mid-poll is the only case. */
  readonly finished?: JobState;
};

export type StageHandler = (job: Job, ctx: StageContext) => Promise<StageOutcome>;

export type Stage = {
  readonly name: StageName;
  /** The state the runner moves the job into before the handler runs. */
  readonly state: JobState;
  readonly reason: string;
  /** How an unrecognised throw from this stage is classified, and therefore whether it is retried. */
  readonly fallback: ErrorClass;
  readonly run: StageHandler;
};
