import { ATTEMPT_OUTCOMES, JOB_MODES, isArtifactKind, isJobState } from "@hypit/job-core";
import type {
  Artifact,
  ArtifactKind,
  Attempt,
  AttemptOutcome,
  Job,
  JobEvent,
  JobMode,
  JobState,
  Revision,
} from "@hypit/job-core";

import { assertRow } from "./errors.js";

/**
 * The row boundary. Everything SQLite hands back is `unknown`, and every domain record in
 * `@hypit/job-core` is exactly one table with one property per column, so the mapping here is
 * mechanical: read the column, check it is the type the schema promised, rename snake_case to
 * camelCase. Nothing is computed, defaulted or folded — a record that disagrees with its row would
 * make the event log unreadable as evidence.
 *
 * Two conversions are the store's own, because SQLite has neither type: a nullable column becomes
 * `| null` rather than an optional property (so no row mapper ever assigns `undefined` to an
 * optional, which `exactOptionalPropertyTypes` forbids), and an INTEGER-encoded boolean becomes a
 * real boolean here so that nothing downstream re-decides what 0 means.
 */
export type Row = Record<string, unknown>;

/** SQLite has no boolean. 0/1 in, boolean out, in exactly these two functions. */
export function encodeBoolean(value: boolean | null | undefined): number | null {
  return value === undefined || value === null ? null : value ? 1 : 0;
}

export function encodeText(value: string | null | undefined): string | null {
  return value === undefined ? null : value;
}

function text(row: Row, column: string): string {
  const value = row[column];
  assertRow(typeof value === "string", `column ${column} must hold TEXT`);
  return value;
}

function nullableText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  assertRow(typeof value === "string", `column ${column} must hold TEXT or NULL`);
  return value;
}

function numeric(row: Row, column: string): number {
  const value = row[column];
  assertRow(typeof value === "number", `column ${column} must hold a number`);
  return value;
}

function nullableNumeric(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  assertRow(typeof value === "number", `column ${column} must hold a number or NULL`);
  return value;
}

function nullableBoolean(row: Row, column: string): boolean | null {
  const value = nullableNumeric(row, column);
  return value === null ? null : value !== 0;
}

function jobState(row: Row, column: string): JobState {
  const value = row[column];
  assertRow(isJobState(value), `column ${column} must hold a job state`);
  return value;
}

function nullableJobState(row: Row, column: string): JobState | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  assertRow(isJobState(value), `column ${column} must hold a job state or NULL`);
  return value;
}

function jobMode(row: Row, column: string): JobMode {
  const value = row[column];
  assertRow(typeof value === "string" && (JOB_MODES as readonly string[]).includes(value),
    `column ${column} must hold a job mode`);
  return value as JobMode;
}

function attemptOutcome(row: Row, column: string): AttemptOutcome | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  assertRow(typeof value === "string" && (ATTEMPT_OUTCOMES as readonly string[]).includes(value),
    `column ${column} must hold an attempt outcome or NULL`);
  return value as AttemptOutcome;
}

function artifactKind(row: Row, column: string): ArtifactKind {
  const value = row[column];
  assertRow(isArtifactKind(value), `column ${column} must hold an artifact kind`);
  return value;
}

export function parseJob(row: Row): Job {
  return {
    jobId: text(row, "job_id"),
    rootJobId: text(row, "root_job_id"),
    parentJobId: nullableText(row, "parent_job_id"),
    revisionNo: numeric(row, "revision_no"),
    mode: jobMode(row, "mode"),
    state: jobState(row, "state"),
    requestJson: text(row, "request_json"),
    callerId: text(row, "caller_id"),
    idempotencyKey: nullableText(row, "idempotency_key"),
    workspacePath: nullableText(row, "workspace_path"),
    hypitBuildId: nullableText(row, "hypit_build_id"),
    progress: numeric(row, "progress"),
    attemptNo: numeric(row, "attempt_no"),
    errorCode: nullableText(row, "error_code"),
    errorMessage: nullableText(row, "error_message"),
    retryable: nullableBoolean(row, "retryable"),
    claimedBy: nullableText(row, "claimed_by"),
    claimedAt: nullableText(row, "claimed_at"),
    heartbeatAt: nullableText(row, "heartbeat_at"),
    cancelRequestedAt: nullableText(row, "cancel_requested_at"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    terminalAt: nullableText(row, "terminal_at"),
  };
}

export function parseJobEvent(row: Row): JobEvent {
  return {
    eventId: numeric(row, "event_id"),
    jobId: text(row, "job_id"),
    seq: numeric(row, "seq"),
    at: text(row, "at"),
    fromState: nullableJobState(row, "from_state"),
    toState: jobState(row, "to_state"),
    attemptNo: numeric(row, "attempt_no"),
    reason: nullableText(row, "reason"),
    detailJson: nullableText(row, "detail_json"),
    hypitBuildId: nullableText(row, "hypit_build_id"),
    errorCode: nullableText(row, "error_code"),
    retryable: nullableBoolean(row, "retryable"),
  };
}

export function parseAttempt(row: Row): Attempt {
  return {
    attemptId: text(row, "attempt_id"),
    jobId: text(row, "job_id"),
    attemptNo: numeric(row, "attempt_no"),
    state: jobState(row, "state"),
    workerId: text(row, "worker_id"),
    startedAt: text(row, "started_at"),
    endedAt: nullableText(row, "ended_at"),
    outcome: attemptOutcome(row, "outcome"),
    errorCode: nullableText(row, "error_code"),
    errorMessage: nullableText(row, "error_message"),
    retryable: nullableBoolean(row, "retryable"),
  };
}

export function parseRevision(row: Row): Revision {
  return {
    revisionId: text(row, "revision_id"),
    rootJobId: text(row, "root_job_id"),
    parentJobId: text(row, "parent_job_id"),
    jobId: text(row, "job_id"),
    revisionNo: numeric(row, "revision_no"),
    instruction: text(row, "instruction"),
    reuseJson: nullableText(row, "reuse_json"),
    createdAt: text(row, "created_at"),
  };
}

export function parseArtifact(row: Row): Artifact {
  return {
    artifactId: text(row, "artifact_id"),
    jobId: text(row, "job_id"),
    kind: artifactKind(row, "kind"),
    name: text(row, "name"),
    uri: text(row, "uri"),
    mediaType: text(row, "media_type"),
    bytes: numeric(row, "bytes"),
    checksumSha256: text(row, "checksum_sha256"),
    width: nullableNumeric(row, "width"),
    height: nullableNumeric(row, "height"),
    durationSeconds: nullableNumeric(row, "duration_seconds"),
    fps: nullableNumeric(row, "fps"),
    createdAt: text(row, "created_at"),
  };
}
