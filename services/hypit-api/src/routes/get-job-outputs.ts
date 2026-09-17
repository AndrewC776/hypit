import type { RequestContext } from "../context.js";
import { requireJob } from "../policy.js";
import { writeJson } from "../respond.js";
import type { RouteParams } from "../router.js";
import { artifactView } from "../views.js";

/**
 * `GET /v1/jobs/:id/outputs`: artifact metadata and a URI. No bytes travel through this API — a
 * rendered video is hundreds of megabytes and belongs in a store the caller fetches from directly.
 */
export async function getJobOutputs(context: RequestContext, params: RouteParams): Promise<void> {
  const { deps } = context;
  const job = requireJob(deps, params);
  const artifacts = deps.store.listArtifacts(job.jobId);
  writeJson(context.response, 200, {
    job_id: job.jobId,
    state: job.state,
    outputs: artifacts.map((artifact) => artifactView(artifact)),
  });
}
