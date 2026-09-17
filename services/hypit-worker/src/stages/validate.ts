/**
 * VALIDATING. `hypit check` against the copied project, which is the first thing that proves the
 * copy is loadable at all — components resolve, assets exist, the source parses.
 *
 * A refusal here is VALIDATION_FAILED and is never retried: the project will be just as invalid the
 * second time, and the answer is a corrected project, not another attempt.
 */
import type { Job } from "@hypit/job-core";

import { WORKER_CODES, WorkerError } from "../errors.js";
import type { StageContext, StageOutcome } from "../stage.js";

export async function runValidate(job: Job, ctx: StageContext): Promise<StageOutcome> {
  const result = await ctx.hypit.checkSource(ctx.request.run, ctx.hypitContext);
  if (!result.ok) {
    throw new WorkerError({
      class: "VALIDATION_FAILED",
      code: WORKER_CODES.requestUnusable,
      message: `hypit check refused ${ctx.request.run} for job ${job.jobId}`,
    });
  }
  return {
    // Contract 17.9: truncation is silent unless the paired `omitted*` counter is carried along.
    detail: {
      sourceKind: result.sourceKind,
      outputCount: result.outputCount,
      ...(result.omitted.length === 0 ? {} : { omitted: result.omitted }),
    },
  };
}
