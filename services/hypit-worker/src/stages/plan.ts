/**
 * PLANNING. `hypit plan` reports what a Build would ask of the world, and the spending gate reads
 * that report before anything is submitted. This is the last stage that costs nothing.
 */
import type { Job } from "@hypit/job-core";

import { assertSpendingAllowed, spendingAuthorized } from "../spending-gate.js";
import type { StageContext, StageOutcome } from "../stage.js";

export async function runPlan(job: Job, ctx: StageContext): Promise<StageOutcome> {
  const plan = await ctx.hypit.planRun(ctx.request.run, ctx.hypitContext);
  assertSpendingAllowed(plan, spendingAuthorized(ctx.request));
  return {
    detail: {
      requestCount: plan.requestCount,
      localRequestCount: plan.localRequestCount,
      providerRequestCount: plan.providerRequestCount,
      unresolvedRequestCount: plan.unresolvedRequestCount,
      ...(plan.omitted.length === 0 ? {} : { omitted: plan.omitted }),
    },
  };
}
