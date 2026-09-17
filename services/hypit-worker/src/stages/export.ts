/**
 * RENDERING, second half: pull the Build's output out of its Result repository and into the job's
 * own `output/final.mp4`.
 *
 * Two CLI facts shape this (contract 17.6). `hypit get` refuses to overwrite a destination, so a
 * retried export would fail on the leftovers of the attempt before it — the destination is removed
 * first, and it is inside the job's own workspace, so removing it can destroy nothing else. And a
 * `composite` output is a DIRECTORY of resources, which ffprobe cannot read; that is a local render
 * failure worth retrying once the build is redone, not a video to hand a caller.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { Job } from "@hypit/job-core";

import { FINAL_VIDEO_NAME } from "../config.js";
import { WORKER_CODES, WorkerError } from "../errors.js";
import type { StageContext, StageOutcome } from "../stage.js";

export async function runExport(job: Job, ctx: StageContext): Promise<StageOutcome> {
  const buildId = ctx.currentJob().hypitBuildId;
  if (buildId === null) {
    throw new WorkerError({
      class: "INTERNAL",
      code: WORKER_CODES.internal,
      message: `job ${job.jobId} reached the export stage without a recorded Build id`,
    });
  }
  const destination = join(ctx.paths.output, FINAL_VIDEO_NAME);
  await rm(destination, { recursive: true, force: true });
  const result = await ctx.hypit.exportOutput(buildId, ctx.config.outputName, destination, ctx.hypitContext);
  if (result.directory) {
    throw new WorkerError({
      class: "LOCAL_RENDER_FAILED",
      code: WORKER_CODES.exportComposite,
      message: `output ${ctx.config.outputName} is a composite directory, not a single video file`,
      receipt: buildId,
    });
  }
  ctx.notes.exportedPath = destination;
  return { detail: { output: ctx.config.outputName, kind: result.kind, type: result.type } };
}
