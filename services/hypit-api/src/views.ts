import type { Artifact, Job } from "@hypit/job-core";
import type { PathRoot } from "@hypit/job-core";

import { sanitizeText } from "./sanitize.js";

/**
 * The wire shapes, in snake_case, written out as types because they are the contract the MCP edge
 * codes against — and because writing them down is what makes the omissions deliberate.
 *
 * Two fields are missing on purpose. `workspace_path` is the host's directory layout and is nobody
 * else's business. `request_json` is the caller's own submission echoed back, which costs bytes on
 * every poll and tells them nothing they did not send.
 *
 * `state` doubles as the stage: this state machine has one state per stage, so publishing both under
 * two names would be two names for one value and one more thing to keep consistent.
 */
export type JobErrorView = {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean | null;
};

export type JobView = {
  readonly job_id: string;
  readonly root_job_id: string;
  readonly parent_job_id: string | null;
  readonly revision_no: number;
  readonly mode: string;
  readonly state: string;
  readonly progress: number;
  readonly attempt_no: number;
  readonly hypit_build_id: string | null;
  readonly cancel_requested_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
  readonly error: JobErrorView | null;
};

/**
 * A job's error summary passes through the sanitiser: the message was written by the worker, which
 * has seen filesystem paths and provider output, and this is the last point before it leaves.
 */
export function jobView(job: Job, roots: readonly PathRoot[]): JobView {
  return {
    job_id: job.jobId,
    root_job_id: job.rootJobId,
    parent_job_id: job.parentJobId,
    revision_no: job.revisionNo,
    mode: job.mode,
    state: job.state,
    progress: job.progress,
    attempt_no: job.attemptNo,
    hypit_build_id: job.hypitBuildId,
    cancel_requested_at: job.cancelRequestedAt,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    terminal_at: job.terminalAt,
    error: job.errorCode === null ? null : {
      code: job.errorCode,
      message: sanitizeText(job.errorMessage ?? "", roots),
      retryable: job.retryable,
    },
  };
}

export type CreatedJobView = {
  readonly job_id: string;
  readonly status: string;
  readonly mode: string;
  readonly created_at: string;
};

/** What `POST /v1/jobs` answers with: an id and a state, immediately, never a Build. */
export function createdJobView(job: Job): CreatedJobView {
  return { job_id: job.jobId, status: job.state, mode: job.mode, created_at: job.createdAt };
}

export type ArtifactView = {
  readonly artifact_id: string;
  readonly kind: string;
  readonly name: string;
  readonly uri: string;
  readonly media_type: string;
  readonly bytes: number;
  readonly checksum_sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration_seconds: number | null;
  readonly fps: number | null;
  readonly created_at: string;
};

/**
 * Metadata and a URI, never bytes. The URI is published as the publisher minted it, because it is
 * the locator a caller fetches the artifact by — the artifact contract names it explicitly, and a
 * relativised locator would identify nothing.
 */
export function artifactView(artifact: Artifact): ArtifactView {
  return {
    artifact_id: artifact.artifactId,
    kind: artifact.kind,
    name: artifact.name,
    uri: artifact.uri,
    media_type: artifact.mediaType,
    bytes: artifact.bytes,
    checksum_sha256: artifact.checksumSha256,
    width: artifact.width,
    height: artifact.height,
    duration_seconds: artifact.durationSeconds,
    fps: artifact.fps,
    created_at: artifact.createdAt,
  };
}
