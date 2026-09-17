import type { DatabaseSync } from "node:sqlite";

import type { Artifact, Attempt, AttemptOutcome, JobError, JobEvent, JobState, Revision } from "@hypit/job-core";

import { encodeBoolean, encodeText, parseArtifact, parseAttempt, parseJobEvent, parseRevision } from "./rows.js";
import type { Row } from "./rows.js";

/**
 * The satellite tables — events, attempts, revisions, artifacts — as free functions over an open
 * database rather than methods. Every one of them may be called inside a transaction the job
 * lifecycle already opened (an event must land in the same transaction as the `jobs` update it
 * describes), so none of them opens one: the caller owns the transaction, and that ownership is
 * easier to see when these are plain functions taking the database.
 */

/**
 * One event per state change, written by the lifecycle methods in `store.ts`. Every field is
 * required rather than optional: a caller that means "no reason" says `null`, which keeps an
 * omitted field from quietly becoming an unexplained row.
 */
export type JobEventInput = {
  readonly jobId: string;
  readonly at: string;
  /** Null only for the row that records the job's creation, which comes from nowhere. */
  readonly fromState: JobState | null;
  readonly toState: JobState;
  readonly attemptNo: number;
  readonly reason: string | null;
  readonly detailJson: string | null;
  readonly hypitBuildId: string | null;
  readonly errorCode: string | null;
  readonly retryable: boolean | null;
};

/**
 * Appends an event and returns its sequence number. The `seq` is `MAX + 1` read inside the caller's
 * transaction, which is what makes it both monotonic and contiguous: the write lock is already held,
 * so no second writer can take the same number, and nothing ever deletes an event to leave a hole.
 */
export function insertJobEvent(database: DatabaseSync, input: JobEventInput): number {
  const row = database.prepare(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
    FROM job_events
    WHERE job_id = ?
  `).get(input.jobId) as Row | undefined;
  const seq = typeof row?.next_seq === "number" ? row.next_seq : 1;
  database.prepare(`
    INSERT INTO job_events (
      job_id, seq, at, from_state, to_state, attempt_no, reason, detail_json,
      hypit_build_id, error_code, retryable
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.jobId, seq, input.at, input.fromState, input.toState, input.attemptNo,
    input.reason, input.detailJson, input.hypitBuildId, input.errorCode,
    encodeBoolean(input.retryable),
  );
  return seq;
}

export function listJobEvents(database: DatabaseSync, jobId: string): readonly JobEvent[] {
  const rows = database.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY seq ASC")
    .all(jobId) as readonly Row[];
  return rows.map(parseJobEvent);
}

/**
 * A stage retry does not re-enter its state — the machine forbids a self-transition — so the second
 * run of a stage is recorded here instead, which is what keeps `job_events` free of loops while
 * still showing that the stage ran twice.
 */
export type AttemptStart = {
  readonly attemptId: string;
  readonly jobId: string;
  readonly attemptNo: number;
  readonly state: JobState;
  readonly workerId: string;
  readonly startedAt: string;
};

export type AttemptEnd = {
  readonly endedAt: string;
  readonly outcome: AttemptOutcome;
  readonly error?: JobError;
};

export function insertAttempt(database: DatabaseSync, input: AttemptStart): void {
  database.prepare(`
    INSERT INTO attempts (attempt_id, job_id, attempt_no, state, worker_id, started_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.attemptId, input.jobId, input.attemptNo, input.state, input.workerId, input.startedAt);
}

/** Returns the closed attempt, or undefined when no attempt carries that id. */
export function completeAttempt(
  database: DatabaseSync,
  attemptId: string,
  end: AttemptEnd,
): Attempt | undefined {
  const row = database.prepare(`
    UPDATE attempts
       SET ended_at = ?, outcome = ?, error_code = ?, error_message = ?, retryable = ?
     WHERE attempt_id = ?
    RETURNING *
  `).get(
    end.endedAt, end.outcome, encodeText(end.error?.code), encodeText(end.error?.message),
    encodeBoolean(end.error?.retryable), attemptId,
  ) as Row | undefined;
  return row === undefined ? undefined : parseAttempt(row);
}

export function listAttempts(database: DatabaseSync, jobId: string): readonly Attempt[] {
  const rows = database.prepare(`
    SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_no ASC, started_at ASC
  `).all(jobId) as readonly Row[];
  return rows.map(parseAttempt);
}

export function insertRevision(database: DatabaseSync, revision: Revision): void {
  database.prepare(`
    INSERT INTO revisions (
      revision_id, root_job_id, parent_job_id, job_id, revision_no, instruction, reuse_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.revisionId, revision.rootJobId, revision.parentJobId, revision.jobId,
    revision.revisionNo, revision.instruction, revision.reuseJson, revision.createdAt,
  );
}

/** The whole revision chain of a root job, oldest first. Readable from either end by design. */
export function listRevisions(database: DatabaseSync, rootJobId: string): readonly Revision[] {
  const rows = database.prepare(`
    SELECT * FROM revisions WHERE root_job_id = ? ORDER BY revision_no ASC, created_at ASC
  `).all(rootJobId) as readonly Row[];
  return rows.map(parseRevision);
}

export function insertArtifact(database: DatabaseSync, artifact: Artifact): void {
  database.prepare(`
    INSERT INTO artifacts (
      artifact_id, job_id, kind, name, uri, media_type, bytes, checksum_sha256,
      width, height, duration_seconds, fps, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.artifactId, artifact.jobId, artifact.kind, artifact.name, artifact.uri,
    artifact.mediaType, artifact.bytes, artifact.checksumSha256, artifact.width, artifact.height,
    artifact.durationSeconds, artifact.fps, artifact.createdAt,
  );
}

export function listArtifacts(database: DatabaseSync, jobId: string): readonly Artifact[] {
  const rows = database.prepare(`
    SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at ASC, artifact_id ASC
  `).all(jobId) as readonly Row[];
  return rows.map(parseArtifact);
}
