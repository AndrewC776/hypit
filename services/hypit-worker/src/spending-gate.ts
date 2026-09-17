/**
 * The spending gate: contract 16.4, and the point where note 03's spending policy stops being a
 * comment and becomes a checkable signal.
 *
 * `hypit plan` reports exactly what a Build would ask of the world. If anything in it is remote,
 * unresolved, or priced by something other than the local machine, the worker refuses to build
 * unless the job carries an explicit authorization to spend.
 */
import type { PlanResult } from "@hypit/hypit-adapter";
import type { JobRequest } from "@hypit/job-core";

import { WORKER_CODES, WorkerError } from "./errors.js";

/**
 * A `prepared_run` request has no `constraints` field at all — the validator rejects unknown
 * fields — so in v1 the gate is absolute for that mode by construction, not by policy. Only a
 * clone request can carry the grant, and only when it says so explicitly.
 */
export function spendingAuthorized(request: JobRequest): boolean {
  return request.mode === "clone" && request.constraints?.spendingAuthorized === true;
}

/**
 * Every condition of contract 16.4, spelled out here rather than delegated: every request resolved,
 * none of them remote, every provider priced locally. The adapter reaches the same verdict in
 * `localOnly`, and this requires BOTH — if a future adapter loosens its definition, the gate does
 * not loosen with it. A null count reads as "not local": a plan we cannot account for must not open
 * the wallet.
 */
export function planIsLocalOnly(plan: PlanResult): boolean {
  return plan.providerRequestCount === 0
    && plan.unresolvedRequestCount === 0
    && plan.providers.every((provider) => provider.pricingKind === "local")
    && plan.localOnly;
}

/**
 * Throws unless building this plan is free or the caller authorized spending. VALIDATION_FAILED,
 * so it is never retried: a refused plan will be refused identically every time, and the answer is
 * a human decision, not another attempt.
 */
export function assertSpendingAllowed(plan: PlanResult, authorized: boolean): void {
  if (planIsLocalOnly(plan) || authorized) return;
  const provider = plan.providerRequestCount ?? "an unreported number of";
  const unresolved = plan.unresolvedRequestCount ?? "an unreported number of";
  throw new WorkerError({
    class: "VALIDATION_FAILED",
    code: WORKER_CODES.spendingNotAuthorized,
    message: `the plan carries ${provider} provider requests and ${unresolved} unresolved requests;`
      + " this job carries no spending authorization, so no Build was submitted",
  });
}
