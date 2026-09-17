import { isTerminalJobState, validateJobRequest } from "@hypit/job-core";
import type { Job, JobRequest } from "@hypit/job-core";

import { httpBodySource, readJsonBody } from "../body.js";
import { nowIso } from "../context.js";
import type { RequestContext, ResolvedDependencies } from "../context.js";
import { apiError, validationFailed } from "../errors.js";
import { readCallerId, readIdempotencyKey } from "../headers.js";
import { requireJob } from "../policy.js";
import { writeJson } from "../respond.js";
import { validateRevisionRequest } from "../revision-request.js";
import type { RouteParams } from "../router.js";
import { createdJobView } from "../views.js";

/**
 * `POST /v1/jobs/:id/revisions`: a new job that continues its parent's chain.
 *
 * A revision is only offered once the parent has finished. A job still running is not revised, it is
 * cancelled and resubmitted — revising a moving target would mean deciding, per stage, which of the
 * parent's half-written outputs the child inherits, and there is no honest answer to that while the
 * worker is still writing them.
 *
 * The chain is recorded twice on purpose: on the child row, so a job knows its parent, and in
 * `revisions`, so a root job can list its descendants without walking the chain backwards.
 */
function childRequest(parent: Job, instruction: string): JobRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(parent.requestJson);
  } catch {
    throw apiError(500, "INTERNAL", "the parent job's stored request could not be read");
  }
  const base = validateJobRequest(parsed);
  if (!base.ok) throw apiError(500, "INTERNAL", "the parent job's stored request is no longer valid");
  // A clone carries its instruction in the request, so the revision's instruction replaces it. A
  // prepared_run has no instruction field; its revision is recorded in `revisions` alone, and the
  // request it replays is the parent's, unchanged.
  const revised: JobRequest = base.value.mode === "clone"
    ? { ...base.value, instruction }
    : base.value;
  const check = validateJobRequest(revised);
  if (!check.ok) throw validationFailed(check.issues);
  return check.value;
}

function assertReusable(deps: ResolvedDependencies, parent: Job, reuse: readonly string[]): void {
  if (reuse.length === 0) return;
  const owned = new Set(deps.store.listArtifacts(parent.jobId).map((artifact) => artifact.artifactId));
  for (const artifactId of reuse) {
    if (!owned.has(artifactId)) {
      throw apiError(404, "ARTIFACT_NOT_FOUND", `artifact ${artifactId} does not belong to job ${parent.jobId}`);
    }
  }
}

export async function createRevision(context: RequestContext, params: RouteParams): Promise<void> {
  const { deps } = context;
  const parent = requireJob(deps, params);
  const callerId = readCallerId(context.request.headers);
  const idempotencyKey = readIdempotencyKey(context.request.headers);
  const body = await readJsonBody(httpBodySource(context.request), { maxBytes: deps.config.maxBodyBytes });
  const validation = validateRevisionRequest(body);
  if (!validation.ok) throw validationFailed(validation.issues);
  const { instruction, reuse } = validation.value;
  if (!isTerminalJobState(parent.state)) {
    throw apiError(409, "JOB_NOT_REVISABLE",
      `job ${parent.jobId} is still ${parent.state}; cancel it or wait for it to finish before revising`);
  }
  assertReusable(deps, parent, reuse);
  const request = childRequest(parent, instruction);
  const now = nowIso(deps);
  const revisionNo = parent.revisionNo + 1;
  const created = deps.store.createJob({
    jobId: deps.newJobId(),
    mode: request.mode,
    requestJson: JSON.stringify(request),
    callerId,
    now,
    rootJobId: parent.rootJobId,
    parentJobId: parent.jobId,
    revisionNo,
    ...(idempotencyKey === null ? {} : { idempotencyKey }),
  });
  // A replay created no child, so it must not append a second revision row for the same request.
  if (!created.replayed) {
    deps.store.addRevision({
      revisionId: deps.newRevisionId(),
      rootJobId: parent.rootJobId,
      parentJobId: parent.jobId,
      jobId: created.job.jobId,
      revisionNo,
      instruction,
      reuseJson: reuse.length === 0 ? null : JSON.stringify(reuse),
      createdAt: now,
    });
  }
  writeJson(context.response, created.replayed ? 200 : 202, {
    ...createdJobView(created.job),
    parent_job_id: parent.jobId,
    revision_no: created.job.revisionNo,
  }, { location: `/v1/jobs/${created.job.jobId}` });
}
