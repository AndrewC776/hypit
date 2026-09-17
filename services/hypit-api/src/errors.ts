import type { RequestIssue } from "@hypit/job-core";

/**
 * The API's failure vocabulary. Codes are stable and machine-readable because the MCP edge branches
 * on them, and messages are written here rather than forwarded from a lower layer: a message that
 * reaches a caller must never carry a filesystem path, a host name or a credential, and the only way
 * to guarantee that is to author every one of them.
 */
export type ApiErrorCode =
  | "ROUTE_NOT_FOUND"
  | "REQUEST_TARGET_INVALID"
  | "METHOD_NOT_ALLOWED"
  | "EXTERNAL_INGRESS_BLOCKED"
  | "BODY_TOO_LARGE"
  | "CONTENT_LENGTH_INVALID"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_JSON"
  | "VALIDATION_FAILED"
  | "CALLER_ID_INVALID"
  | "IDEMPOTENCY_KEY_INVALID"
  | "JOB_ID_INVALID"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_REVISABLE"
  | "PROJECT_NOT_REGISTERED"
  | "REFERENCE_URL_BLOCKED"
  | "TAIL_INVALID"
  | "ARTIFACT_NOT_FOUND"
  | "INTERNAL";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function apiError(status: number, code: ApiErrorCode, message: string): ApiError {
  return new ApiError(status, code, message);
}

const MAX_REPORTED_ISSUES = 3;

/**
 * Turns validator issues into one message. Only the first few are reported: a caller fixing a body
 * needs the first thing wrong with it, and an unbounded list is a way to make a response echo an
 * arbitrary amount of attacker-chosen text back out.
 */
export function validationFailed(issues: readonly RequestIssue[]): ApiError {
  const reported = issues.slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`));
  const extra = issues.length - reported.length;
  const suffix = extra > 0 ? ` (and ${extra} more)` : "";
  return apiError(400, "VALIDATION_FAILED", `${reported.join("; ")}${suffix}`);
}
