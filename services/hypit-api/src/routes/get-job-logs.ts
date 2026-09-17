import type { RequestContext } from "../context.js";
import { apiError } from "../errors.js";
import { DEFAULT_LOG_TAIL, MAX_LOG_TAIL } from "../limits.js";
import { requireJob } from "../policy.js";
import { writeJson } from "../respond.js";
import { pathRoots, sanitizeText } from "../sanitize.js";
import type { RouteParams } from "../router.js";

/**
 * `GET /v1/jobs/:id/logs?tail=N`.
 *
 * Every line passes through both halves of the sanitiser before it is written, with no path around
 * it: Hypit's execution-log records embed URL-encoded absolute paths, and a worker's failure message
 * can carry whatever a provider printed at it. The tail is bounded so one request cannot ask for an
 * unbounded response.
 */
/** Plain digits only: `Number` would happily read `1e3` or ` 12 `, and a query value is not arithmetic. */
const TAIL = /^[0-9]{1,4}$/u;

function readTail(url: URL): number {
  const raw = url.searchParams.get("tail");
  if (raw === null || raw.trim() === "") return DEFAULT_LOG_TAIL;
  const tail = TAIL.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > MAX_LOG_TAIL) {
    throw apiError(400, "TAIL_INVALID", `tail must be an integer between 1 and ${MAX_LOG_TAIL}`);
  }
  return tail;
}

export async function getJobLogs(context: RequestContext, params: RouteParams): Promise<void> {
  const { deps } = context;
  const job = requireJob(deps, params);
  const tail = readTail(context.url);
  const roots = pathRoots(deps.config, job);
  const lines = await deps.readLogs(job, tail);
  writeJson(context.response, 200, {
    job_id: job.jobId,
    tail,
    lines: lines.map((line) => sanitizeText(line, roots)),
  });
}
