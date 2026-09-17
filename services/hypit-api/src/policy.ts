import { checkReferenceUrl, isJobId } from "@hypit/job-core";
import type { Job, JobRequest, UrlGuardOptions } from "@hypit/job-core";

import type { ResolvedDependencies } from "./context.js";
import { apiError } from "./errors.js";
import type { RouteParams } from "./router.js";

/**
 * The checks that need the deployment's own knowledge — its project registry and its reference
 * allow-list — and therefore cannot live in `@hypit/job-core` beside the shape validation.
 *
 * The division matters: `validateJobRequest` decides whether a request is well-formed, and this file
 * decides whether a well-formed request is one this host will act on. A path-shaped `project` fails
 * the first; a perfectly-shaped key nobody registered fails the second.
 */
export async function assertRequestAllowed(
  request: JobRequest,
  deps: ResolvedDependencies,
): Promise<void> {
  if (request.mode === "prepared_run") {
    if (!deps.config.projectRegistry.has(request.project)) {
      // Says the key is unknown, never which keys exist: the registry is host layout.
      throw apiError(400, "PROJECT_NOT_REGISTERED", `project ${request.project} is not a registered project`);
    }
    return;
  }
  if (request.reference.type !== "url") return;
  const options: UrlGuardOptions = {
    allowedHosts: deps.config.referenceAllowlist,
    // Conditional spread: exactOptionalPropertyTypes refuses an explicit undefined here, and an
    // absent resolver is what tells the guard to use its own DNS.
    ...(deps.lookup === undefined ? {} : { lookup: deps.lookup }),
  };
  const verdict = await checkReferenceUrl(request.reference.url, options);
  if (!verdict.ok) {
    throw apiError(400, "REFERENCE_URL_BLOCKED", `reference url rejected: ${verdict.message}`);
  }
}

/**
 * Resolves `:id` to a job, or fails the way the caller should read it: a malformed id is the
 * caller's mistake (400), an id that is well-formed but names nothing is a miss (404). Collapsing
 * both into one status would make a typo indistinguishable from a job that has been pruned.
 */
export function requireJob(deps: ResolvedDependencies, params: RouteParams): Job {
  const jobId = params.id ?? "";
  if (!isJobId(jobId)) {
    throw apiError(400, "JOB_ID_INVALID", "job id must look like vid_<timestamp>_<8 upper-case hex>");
  }
  const job = deps.store.readJob(jobId);
  if (job === undefined) throw apiError(404, "JOB_NOT_FOUND", `job ${jobId} does not exist`);
  return job;
}
