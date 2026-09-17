/**
 * Orphan-build recovery (contract 17.5).
 *
 * A Build id is minted client-side by the CLI at submission and only then printed, so a worker
 * killed in that window leaves a REAL Build whose id nobody recorded. Submitting a second Build for
 * the same job is the failure this file exists to prevent: it doubles the work and, for a paid
 * provider, the charge.
 *
 * Two things make recovery unambiguous rather than a guess. The worker writes a submit marker into
 * the event log in the same transaction that enters BUILDING, before the spawn — so "a Build may
 * exist" is durable even though the id is not. And each job owns its project directory, so the
 * Builds recorded there belong to this job and nothing else.
 */
import type { Job, JobEvent } from "@hypit/job-core";

import { WORKER_EVENT_REASONS } from "./events.js";
import type { ListedBuild } from "./hypit-port.js";

/** True once `hypit build` may have been spawned for this job, whether or not an id came back. */
export function hasSubmitMarker(events: readonly JobEvent[]): boolean {
  return events.some((event) => event.reason === WORKER_EVENT_REASONS.buildSubmitMarker);
}

export type AdoptionDecision =
  /** The id is already on the job row; resume observing it. */
  | { readonly kind: "recorded"; readonly buildId: string }
  /** No marker: nothing was ever spawned for this job, so the pipeline may run from the start. */
  | { readonly kind: "none" }
  /** A marker, but no Build in the project's Result repository: the CLI died before submitting. */
  | { readonly kind: "absent" }
  | { readonly kind: "adopt"; readonly buildId: string }
  /** More than one candidate. Adoption would be a guess, so a human decides instead. */
  | { readonly kind: "ambiguous"; readonly count: number };

/**
 * `builds` are the Builds listed for THIS job's project directory. They are filtered by run source
 * as a second confirmation — a listing that does not report `run` is accepted rather than
 * discarded, because losing a real Build is worse than adopting on one signal instead of two.
 */
export function decideAdoption(
  job: Job,
  events: readonly JobEvent[],
  builds: readonly ListedBuild[],
  runSource: string,
): AdoptionDecision {
  if (job.hypitBuildId !== null) return { kind: "recorded", buildId: job.hypitBuildId };
  if (!hasSubmitMarker(events)) return { kind: "none" };
  const candidates = builds.filter((build) => build.run === null || build.run === runSource);
  const only = candidates[0];
  if (only === undefined) return { kind: "absent" };
  if (candidates.length > 1) return { kind: "ambiguous", count: candidates.length };
  return { kind: "adopt", buildId: only.id };
}
