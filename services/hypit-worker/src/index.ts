/**
 * `@hypit/hypit-worker` runs the jobs the API queues: it claims one at a time, prepares its
 * workspace, drives the Hypit CLI through the adapter, and records every state change in the store.
 *
 * It holds no configuration of its own — the database path, the jobs root, the project registry,
 * the executables and every interval are injected — and it spawns nothing: every external process
 * belongs to `@hypit/hypit-adapter`, reached through `HypitPort`, which is also what lets the whole
 * pipeline be tested against a fake with the real state machine and the real store.
 */
export { createAdapterPort } from "./adapter-port.js";
export type { HypitPortExtensions } from "./adapter-port.js";
export { CANCEL_REASON, cancelJob } from "./cancel.js";
export {
  DEFAULT_BUILD_POLL_INTERVAL_MS,
  DEFAULT_BUILD_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_OUTPUT_NAME,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_STALE_AFTER_MS,
  FINAL_VIDEO_NAME,
  resolveProjectPath,
  resolveWorkerConfig,
} from "./config.js";
export type { ProjectRegistry, WorkerConfig, WorkerConfigInput } from "./config.js";
export { WORKER_CODES, WorkerError, carry, toJobError } from "./errors.js";
export { WORKER_EVENT_REASONS } from "./events.js";
export type { WorkerEventReason } from "./events.js";
export type { HypitPort, ListedBuild, ProgramsStatus } from "./hypit-port.js";
export { runJob } from "./job-run.js";
export type { JobRunDeps } from "./job-run.js";
export { WorkerLoop, installShutdownHandlers } from "./loop.js";
export type { SignalTarget, WorkerLoopOptions } from "./loop.js";
export { PREPARED_RUN_STAGES, stagesFrom } from "./pipeline.js";
export { decideAdoption, hasSubmitMarker } from "./recovery.js";
export type { AdoptionDecision } from "./recovery.js";
export { assertSpendingAllowed, planIsLocalOnly, spendingAuthorized } from "./spending-gate.js";
export { newStageNotes } from "./stage.js";
export type {
  AdvanceOptions,
  RunSignal,
  Stage,
  StageContext,
  StageHandler,
  StageName,
  StageNotes,
  StageOutcome,
} from "./stage.js";
export { QC_REPORT_NAME } from "./stages/qc.js";
export { createWorkspaceDirectories, jobPaths, prepareWorkspace } from "./workspace.js";
export type { JobPaths } from "./workspace.js";
