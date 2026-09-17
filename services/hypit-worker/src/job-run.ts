/**
 * One claimed job, from PREPARING_WORKSPACE to a terminal state.
 *
 * The runner is deliberately the only place that writes a transition. A stage returns what it
 * established; the runner records it on the move into the next stage, opens and closes the attempt
 * row, decides whether a failure may be retried, and stops the moment the job stops being ours.
 * Concentrating that here is what keeps seven stage handlers free of lifecycle code — and what makes
 * the two rules that cost money if broken checkable in one file: never submit twice, never retry an
 * unknown submission.
 */
import {
  JOB_EVENT_REASONS,
  isTerminalJobState,
  validateJobRequest,
} from "@hypit/job-core";
import type {
  ArtifactPublisher,
  Job,
  JobError,
  JobEvent,
  JobState,
  PreparedRunRequest,
} from "@hypit/job-core";
import type { FfprobeContext, HypitContext } from "@hypit/hypit-adapter";
import type { JobStore } from "@hypit/job-store-sqlite";

import { cancelJob } from "./cancel.js";
import type { WorkerConfig } from "./config.js";
import { WORKER_CODES, WorkerError, carry, toJobError } from "./errors.js";
import { WORKER_EVENT_REASONS } from "./events.js";
import type { HypitPort } from "./hypit-port.js";
import { PREPARED_RUN_STAGES, stagesFrom } from "./pipeline.js";
import { decideAdoption, hasSubmitMarker } from "./recovery.js";
import { newStageNotes } from "./stage.js";
import type { AdvanceOptions, RunSignal, Stage, StageContext, StageOutcome } from "./stage.js";
import { createWorkspaceDirectories, jobPaths } from "./workspace.js";

export type JobRunDeps = {
  readonly config: WorkerConfig;
  readonly store: JobStore;
  readonly hypit: HypitPort;
  readonly publisher: ArtifactPublisher;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly newAttemptId: () => string;
};

/**
 * The stored request is re-validated rather than trusted. It was validated once at the API, but a
 * row read back is input again, and a worker that drove a corrupted row would turn a storage fault
 * into a Build.
 */
function readPreparedRunRequest(job: Job): PreparedRunRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.requestJson);
  } catch {
    throw new WorkerError({
      class: "VALIDATION_FAILED",
      code: WORKER_CODES.requestUnusable,
      message: `the stored request for job ${job.jobId} is not JSON`,
    });
  }
  const validation = validateJobRequest(parsed);
  if (!validation.ok) {
    // Field paths and codes only: the request's content is the caller's, not a log line's.
    const summary = validation.issues.map((issue) => `${issue.path}:${issue.code}`).join(", ");
    throw new WorkerError({
      class: "VALIDATION_FAILED",
      code: WORKER_CODES.requestUnusable,
      message: `the stored request for job ${job.jobId} is invalid (${summary})`,
    });
  }
  if (validation.value.mode !== "prepared_run") {
    throw new WorkerError({
      class: "VALIDATION_FAILED",
      code: WORKER_CODES.modeNotImplemented,
      message: `mode ${validation.value.mode} is not implemented by this worker`,
    });
  }
  return validation.value;
}

function transitionFields(outcome: StageOutcome): AdvanceOptions {
  return {
    ...(outcome.progress === undefined ? {} : { progress: outcome.progress }),
    ...(outcome.workspacePath === undefined ? {} : { workspacePath: outcome.workspacePath }),
    ...(outcome.hypitBuildId === undefined ? {} : { hypitBuildId: outcome.hypitBuildId }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  };
}

/**
 * A number no attempt row for this job and state has used. `UNIQUE(job_id, attempt_no, state)`
 * makes a reused number an insert error, and a job that is requeued and re-claimed would otherwise
 * collide with its own earlier retries the moment it retried the same stage twice.
 */
function nextAttemptNo(store: JobStore, job: Job, state: JobState): number {
  let used = 0;
  for (const attempt of store.listAttempts(job.jobId)) {
    if (attempt.state === state && attempt.attemptNo > used) used = attempt.attemptNo;
  }
  return Math.max(job.attemptNo, used + 1);
}

/**
 * Runs one stage, retrying only what the failure class says may be retried. The bound is per stage
 * and per claim; `PROVIDER_SUBMISSION_UNKNOWN` and every validation failure leave on the first
 * throw, because repeating them either costs money or fails identically.
 */
async function runStage(stage: Stage, ctx: StageContext, deps: JobRunDeps): Promise<StageOutcome> {
  let last: JobError | undefined;
  for (let attempt = 0; attempt < deps.config.maxAttempts; attempt += 1) {
    const job = ctx.currentJob();
    const attemptId = deps.newAttemptId();
    ctx.store.startAttempt({
      attemptId,
      jobId: job.jobId,
      attemptNo: nextAttemptNo(ctx.store, job, stage.state),
      state: stage.state,
      workerId: deps.config.workerId,
      startedAt: deps.now(),
    });
    try {
      const outcome = await stage.run(job, ctx);
      ctx.store.finishAttempt(attemptId, {
        endedAt: deps.now(),
        outcome: outcome.finished === "CANCELLED" ? "cancelled" : "succeeded",
      });
      return outcome;
    } catch (cause) {
      const error = toJobError(cause, stage.fallback);
      ctx.store.finishAttempt(attemptId, { endedAt: deps.now(), outcome: "failed", error });
      if (!error.retryable) throw carry(error);
      last = error;
      if (attempt + 1 < deps.config.maxAttempts) await ctx.sleep(deps.config.retryDelayMs);
    }
  }
  // Exhausted. The class stays what it was — the failure was retryable, the attempts were not
  // infinite — so the record says "retryable, and we tried" rather than reclassifying it.
  // `maxAttempts` is a positive integer, so the loop ran at least once and only the catch branch
  // can reach here; the assertion states that rather than inventing a second failure value.
  throw carry(last!);
}

/**
 * Where this claim re-enters the pipeline. A job with a recorded Build id, or with a submit marker
 * and a Build sitting in its own project directory, resumes at the build stage as an observer.
 * Everything else starts from the beginning.
 */
async function resumeStages(ctx: StageContext, events: readonly JobEvent[]): Promise<readonly Stage[]> {
  const job = ctx.currentJob();
  if (job.hypitBuildId === null && !hasSubmitMarker(events)) return PREPARED_RUN_STAGES;
  // The CLI needs the project directory to answer at all; a crashed attempt left it behind, but
  // creating it costs nothing and keeps a half-cleaned workspace from looking like a missing Build.
  await createWorkspaceDirectories(ctx.paths);
  const builds = job.hypitBuildId === null ? await ctx.hypit.listBuilds(ctx.hypitContext) : [];
  const decision = decideAdoption(job, events, builds, ctx.request.run);
  if (decision.kind === "none" || decision.kind === "absent") return PREPARED_RUN_STAGES;
  if (decision.kind === "ambiguous") {
    throw new WorkerError({
      class: "PROVIDER_SUBMISSION_UNKNOWN",
      code: WORKER_CODES.buildAdoptionAmbiguous,
      message: `${decision.count} Builds are recorded for this job's project directory, so which one`
        + " belongs to this job cannot be decided without a human",
    });
  }
  ctx.advance("BUILDING", {
    reason: WORKER_EVENT_REASONS.buildAdopted,
    hypitBuildId: decision.buildId,
    detail: { adopted: decision.kind === "adopt" },
  });
  return stagesFrom("build");
}

async function runStages(stages: readonly Stage[], ctx: StageContext, deps: JobRunDeps): Promise<Job> {
  let pending: StageOutcome = {};
  for (const stage of stages) {
    // A lost job belongs to another worker now and a stopping worker is on its way out; in both
    // cases the job is left non-terminal for the store's stale recovery to hand back.
    if (ctx.signal.lost || ctx.signal.stopping) return ctx.currentJob();
    if (ctx.cancelRequested()) {
      await cancelJob(ctx, ctx.currentJob().hypitBuildId);
      return ctx.currentJob();
    }
    if (ctx.currentJob().state === stage.state) {
      // The previous stage already moved the job here — the build stage does, on the Build's first
      // reported progress — and recorded what it had established on that move, so nothing is left
      // to carry and a self-transition would be refused anyway.
      pending = {};
    } else {
      ctx.advance(stage.state, { reason: stage.reason, ...transitionFields(pending) });
    }
    const outcome = await runStage(stage, ctx, deps);
    if (outcome.finished !== undefined) return ctx.currentJob();
    pending = outcome;
  }
  ctx.advance("COMPLETED", { reason: JOB_EVENT_REASONS.completed, ...transitionFields(pending) });
  return ctx.currentJob();
}

export async function runJob(claimed: Job, signal: RunSignal, deps: JobRunDeps): Promise<Job> {
  let job = claimed;
  const fail = (error: JobError): Job => {
    const current = deps.store.readJob(job.jobId) ?? job;
    // Terminal is immutable, and a job cancelled mid-stage has already written its own ending.
    if (isTerminalJobState(current.state)) return current;
    return deps.store.recordTransition(job.jobId, "FAILED", {
      now: deps.now(),
      reason: JOB_EVENT_REASONS.failed,
      error,
    });
  };
  try {
    const request = readPreparedRunRequest(job);
    const paths = jobPaths(deps.config.jobsRoot, job.jobId);
    const hypitContext: HypitContext = {
      executable: deps.config.hypitExecutable,
      workspace: paths.project,
      runtimeProfile: deps.config.runtimeProfile,
      env: deps.config.env,
      allowedRoots: deps.config.allowedRoots,
      // Deliberately no AbortSignal: a shutdown that aborted `hypit build` mid-submission is
      // exactly how an orphan Build is created. The worker stops between stages instead.
      ...(deps.config.cliTimeoutMs === null ? {} : { timeoutMs: deps.config.cliTimeoutMs }),
    };
    const ffprobeContext: FfprobeContext = {
      executable: deps.config.ffprobeExecutable,
      env: deps.config.env,
      allowedRoots: deps.config.allowedRoots,
      ...(deps.config.cliTimeoutMs === null ? {} : { timeoutMs: deps.config.cliTimeoutMs }),
    };
    const ctx: StageContext = {
      config: deps.config,
      store: deps.store,
      hypit: deps.hypit,
      publisher: deps.publisher,
      request,
      paths,
      hypitContext,
      ffprobeContext,
      notes: newStageNotes(),
      signal,
      now: deps.now,
      sleep: deps.sleep,
      cancelRequested: (): boolean => {
        const current = deps.store.readJob(job.jobId);
        return current !== undefined && current.cancelRequestedAt !== null;
      },
      currentJob: (): Job => job,
      advance: (to: JobState, options: AdvanceOptions): Job => {
        job = deps.store.recordTransition(job.jobId, to, { now: deps.now(), ...options });
        return job;
      },
    };
    const stages = await resumeStages(ctx, deps.store.listEvents(job.jobId));
    return await runStages(stages, ctx, deps);
  } catch (cause) {
    return fail(toJobError(cause, "INTERNAL"));
  }
}
