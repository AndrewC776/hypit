/**
 * `@hypit/job-store-sqlite` is the control plane's durable state: the job table, its event log, the
 * attempts, revisions and artifacts that hang off it, and the two operations that must be atomic to
 * be correct at all — the idempotent create and the worker claim.
 *
 * It holds no policy. What a legal transition is, what a failure class means and how long an
 * instruction may be are decided in `@hypit/job-core`; the path to the database file, every
 * timestamp and every threshold are injected by the caller.
 */
export { JobStoreError } from "./errors.js";
export type { JobStoreErrorCode } from "./errors.js";
export {
  MIGRATIONS,
  appliedMigrationVersions,
  applyMigrations,
  latestMigrationVersion,
} from "./migrations.js";
export type { Migration, MigrationOptions } from "./migrations.js";
export type { AttemptEnd, AttemptStart, JobEventInput } from "./records.js";
export { DEFAULT_BUSY_TIMEOUT_MS, DEFAULT_STALE_AFTER_MS, JobStore } from "./store.js";
export type {
  CancelOutcome,
  CreateJobInput,
  CreateJobResult,
  JobStoreOptions,
  JobTransition,
  StaleRecovery,
  StaleRecoveryOptions,
} from "./store.js";
