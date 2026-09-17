import { nowIso } from "../context.js";
import type { RequestContext } from "../context.js";
import { requireJob } from "../policy.js";
import { writeJson } from "../respond.js";
import { pathRoots } from "../sanitize.js";
import type { RouteParams } from "../router.js";
import { jobView } from "../views.js";

/**
 * `POST /v1/jobs/:id/cancel`: record that the caller wants this job stopped.
 *
 * The response never claims a running job was stopped, only that cancellation was requested. A Build
 * already in flight may hold a paid remote operation whose cancellation outcome Hypit deliberately
 * does not report, so the honest answer is the request plus the job's current state; the worker
 * reads the flag between stages, asks Hypit to cancel, and moves the job itself.
 *
 * `cancelled` is true only in the one case the API can settle alone: a job still QUEUED and
 * unclaimed, which the store transitions in the same transaction as the flag.
 */
export async function cancelJob(context: RequestContext, params: RouteParams): Promise<void> {
  const { deps } = context;
  const job = requireJob(deps, params);
  const outcome = deps.store.requestCancel(job.jobId, nowIso(deps));
  writeJson(context.response, 202, {
    job_id: outcome.job.jobId,
    cancellation_requested: outcome.job.cancelRequestedAt !== null,
    cancelled: outcome.cancelled,
    job: jobView(outcome.job, pathRoots(deps.config, outcome.job)),
  });
}
