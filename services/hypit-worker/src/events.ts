/**
 * Event reasons the worker writes that the shared `JOB_EVENT_REASONS` vocabulary does not name.
 * The `reason` column is a free string on purpose, so a new reason needs no migration — but it is
 * declared here rather than spelled at each call site, because two of these are read back as
 * evidence, not just displayed.
 */
export const WORKER_EVENT_REASONS = {
  /**
   * Contract 17.5. Written in the same transaction that enters BUILDING, BEFORE `hypit build` is
   * spawned. A Build id is minted client-side at submission, so a process killed between the
   * submission and the printed id leaves a real Build we never saw; this marker is what tells the
   * next worker that a Build for this job may already exist.
   */
  buildSubmitMarker: "build_submit_marker",
  /** A Build found in the job's own project directory and taken over instead of submitting again. */
  buildAdopted: "build_adopted",
  /** The Build reported work under way, which is where BUILDING ends and RENDERING begins. */
  buildRendering: "build_rendering",
} as const;

export type WorkerEventReason = (typeof WORKER_EVENT_REASONS)[keyof typeof WORKER_EVENT_REASONS];
