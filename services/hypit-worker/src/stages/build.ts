/**
 * BUILDING, and the crossing into RENDERING.
 *
 * The order of operations is the whole point of this file. The runner has already written the
 * submit marker in the transaction that entered BUILDING, so by the time `submitBuild` is called
 * the possibility of a Build is durable. Submission returns while the Build is still working
 * (contract 16.3) — nothing waits on it — and the id becomes durable on the first transition after
 * it is known, which is the move into RENDERING when the Build reports work under way.
 *
 * A job that arrives here already carrying an id is resuming: either the same worker recorded it
 * before restarting, or recovery adopted it. Either way this stage observes, it does not submit.
 */
import type { Job } from "@hypit/job-core";
import type { BuildStatus } from "@hypit/hypit-adapter";

import { cancelJob } from "../cancel.js";
import { WORKER_CODES, WorkerError } from "../errors.js";
import { WORKER_EVENT_REASONS } from "../events.js";
import type { StageContext, StageOutcome } from "../stage.js";

function observationDeadline(ctx: StageContext): number {
  return Date.parse(ctx.now()) + ctx.config.buildTimeoutMs;
}

function failedBuild(status: BuildStatus): WorkerError {
  return new WorkerError({
    class: "HYPIT_BUILD_FAILED",
    code: WORKER_CODES.buildFailed,
    // The Build's Result survives a failure, so a revision can reuse whatever did succeed.
    message: `the Build failed with work ${status.workOutcome ?? "unknown"}`
      + ` and result ${status.resultState ?? "unknown"}`,
    receipt: status.buildId,
  });
}

/**
 * Polls one Build to a conclusion. Every iteration re-reads the cancel flag first, because a caller
 * can ask to stop at any point during a render that takes minutes.
 */
async function observeBuild(buildId: string, ctx: StageContext): Promise<StageOutcome> {
  const deadline = observationDeadline(ctx);
  let rendering = ctx.currentJob().state === "RENDERING";
  const enterRendering = (progress: number | null): void => {
    ctx.advance("RENDERING", {
      reason: WORKER_EVENT_REASONS.buildRendering,
      hypitBuildId: buildId,
      ...(progress === null ? {} : { progress }),
    });
    rendering = true;
  };
  for (;;) {
    if (ctx.cancelRequested()) return cancelJob(ctx, buildId);
    const status = await ctx.hypit.getBuildStatus(buildId, ctx.hypitContext);
    if (status.outcome === "not_found") {
      // Contract 15 TRAP 2: `build: null` is never "still running". A Build we recorded and can no
      // longer see is an internal inconsistency, not a transient condition.
      throw new WorkerError({
        class: "INTERNAL",
        code: WORKER_CODES.buildNotFound,
        message: "the Build this job recorded is not in its project's Result repository",
        receipt: buildId,
      });
    }
    if (status.outcome === "failed") throw failedBuild(status);
    if (status.outcome === "cancelled") {
      // Cancelled out from under us — a cancelled Build exits 0, so only the view says so.
      return cancelJob(ctx, buildId);
    }
    if (status.outcome === "complete") {
      ctx.notes.buildComplete = true;
      if (!rendering) enterRendering(1);
      return { hypitBuildId: buildId, progress: 1 };
    }
    // `running` and `unknown` both keep polling: an unfamiliar state from a later CLI is not a
    // reason to abandon a Build that is probably fine, and the deadline bounds the wait either way.
    if (!rendering && status.progress !== null) enterRendering(status.progress);
    if (Date.parse(ctx.now()) >= deadline) {
      throw new WorkerError({
        class: "INTERNAL",
        code: WORKER_CODES.buildObservationTimeout,
        // The Build is durable and goes on without us; what expired is our willingness to watch.
        message: "stopped observing the Build after the observation window expired",
        receipt: buildId,
      });
    }
    await ctx.sleep(ctx.config.buildPollIntervalMs);
  }
}

export async function runBuild(job: Job, ctx: StageContext): Promise<StageOutcome> {
  const recorded = job.hypitBuildId ?? ctx.currentJob().hypitBuildId;
  if (recorded !== null) return observeBuild(recorded, ctx);
  const { buildId } = await ctx.hypit.submitBuild(ctx.request.run, ctx.hypitContext);
  return observeBuild(buildId, ctx);
}
