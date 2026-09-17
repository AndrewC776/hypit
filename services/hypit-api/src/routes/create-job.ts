import { validateJobRequest } from "@hypit/job-core";

import { httpBodySource, readJsonBody } from "../body.js";
import { nowIso } from "../context.js";
import type { RequestContext } from "../context.js";
import { validationFailed } from "../errors.js";
import { readCallerId, readIdempotencyKey } from "../headers.js";
import { assertRequestAllowed } from "../policy.js";
import { writeJson } from "../respond.js";
import { createdJobView } from "../views.js";

/**
 * `POST /v1/jobs`: validate, insert one QUEUED row, answer.
 *
 * The handler deliberately does nothing else. A Build takes minutes and costs money; an HTTP request
 * that waits for one is a request that times out somewhere in the middle and leaves the caller
 * unable to tell a lost answer from a lost job. The worker picks the row up out of band.
 *
 * Idempotency is the store's to enforce, not this handler's: a `SELECT` before the `INSERT` is a race
 * that admits both of two concurrent creates, and for this control plane that means two Builds and
 * two charges. The unique index arbitrates, the loser re-reads the winner's row, and the caller gets
 * the same job id back — a replay answers 200 rather than 202 because nothing was created.
 */
export async function createJob(context: RequestContext): Promise<void> {
  const { deps } = context;
  const callerId = readCallerId(context.request.headers);
  const idempotencyKey = readIdempotencyKey(context.request.headers);
  const body = await readJsonBody(httpBodySource(context.request), { maxBytes: deps.config.maxBodyBytes });
  const validation = validateJobRequest(body);
  if (!validation.ok) throw validationFailed(validation.issues);
  const request = validation.value;
  await assertRequestAllowed(request, deps);
  const result = deps.store.createJob({
    jobId: deps.newJobId(),
    mode: request.mode,
    // The validated value, not the raw body: what is stored is what was accepted, field for field.
    requestJson: JSON.stringify(request),
    callerId,
    now: nowIso(deps),
    ...(idempotencyKey === null ? {} : { idempotencyKey }),
  });
  writeJson(context.response, result.replayed ? 200 : 202, createdJobView(result.job), {
    location: `/v1/jobs/${result.job.jobId}`,
  });
}
