/**
 * Cancellation, and the one sentence it is allowed to say.
 *
 * Contract 17.7: the CLI reports only that cancellation was REQUESTED, and the remote-provider
 * outcome is deliberately absent from its output. A control plane that reported "cancelled" would
 * be claiming something no layer beneath it knows — and if the operation was paid for, that claim
 * is the expensive kind of wrong. So the job's terminal record says what was asked, what was
 * observed, and nothing more.
 */
import { JOB_EVENT_REASONS, jobError } from "@hypit/job-core";

import { WORKER_CODES, toJobError } from "./errors.js";
import type { StageContext, StageOutcome } from "./stage.js";

/** Matches the adapter's `REASON_TEXT`; a value it would reject never reaches a spawn. */
export const CANCEL_REASON = "cancel requested by the control plane";

/**
 * Asks Hypit to stop the Build when one exists, then ends the job as CANCELLED. A failed
 * cancellation request is recorded, not raised: the caller asked for the job to stop, and leaving
 * it RUNNING because the CLI could not see the Build would serve nobody.
 */
export async function cancelJob(ctx: StageContext, buildId: string | null): Promise<StageOutcome> {
  let requested = false;
  let observed = false;
  let note = "no Build had been submitted";
  if (buildId !== null) {
    try {
      const outcome = await ctx.hypit.cancelBuild(buildId, CANCEL_REASON, ctx.hypitContext);
      requested = outcome.requested;
      observed = outcome.observed;
      note = outcome.observed
        ? "the Build was asked to stop"
        // Contract 17.7: `cancel` cannot reach a Build still in its submitting window.
        : "the Build could not be observed, so the request may not have reached it";
    } catch (cause) {
      note = `the cancellation request failed with ${toJobError(cause).code}`;
    }
  }
  const error = jobError({
    class: "CANCELLED",
    code: WORKER_CODES.cancelled,
    message: `cancellation requested: ${note}. Any remote operation already in flight is reported`
      + " as requested, never as stopped.",
    ...(buildId === null ? {} : { receipt: buildId }),
  });
  ctx.advance("CANCELLED", {
    reason: JOB_EVENT_REASONS.cancelled,
    detail: { cancel: { requested, observed } },
    error,
    ...(buildId === null ? {} : { hypitBuildId: buildId }),
  });
  return { finished: "CANCELLED" };
}
