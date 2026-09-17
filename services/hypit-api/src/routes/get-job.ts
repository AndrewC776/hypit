import type { RequestContext } from "../context.js";
import { requireJob } from "../policy.js";
import { writeJson } from "../respond.js";
import { pathRoots } from "../sanitize.js";
import type { RouteParams } from "../router.js";
import { jobView } from "../views.js";

/** `GET /v1/jobs/:id`: the job as the caller may see it — state, progress, timings, error summary. */
export async function getJob(context: RequestContext, params: RouteParams): Promise<void> {
  const job = requireJob(context.deps, params);
  writeJson(context.response, 200, jobView(job, pathRoots(context.deps.config, job)));
}
