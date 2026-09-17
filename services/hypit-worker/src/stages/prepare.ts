/**
 * PREPARING_WORKSPACE. Builds the job its own directory and copies the registered project into it.
 *
 * The workspace path is returned rather than written here: the runner records it on the transition
 * that enters VALIDATING, so the row and its event stay in one transaction.
 */
import type { Job } from "@hypit/job-core";

import type { StageContext, StageOutcome } from "../stage.js";
import { prepareWorkspace } from "../workspace.js";

export async function runPrepare(job: Job, ctx: StageContext): Promise<StageOutcome> {
  const paths = await prepareWorkspace(ctx.config, job.jobId, ctx.request.project);
  return { workspacePath: paths.root, detail: { project: ctx.request.project } };
}
