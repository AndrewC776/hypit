import {
  MAX_INSTRUCTION_LENGTH,
  failed,
  isArtifactId,
  issue,
  plainObject,
  readString,
  rejectUnknownFields,
} from "@hypit/job-core";
import type { RequestIssue, RequestValidation } from "@hypit/job-core";

/**
 * The body of `POST /v1/jobs/:id/revisions`, validated with the same primitives the job request uses
 * so that "unknown fields are rejected" has one implementation for the whole API rather than one per
 * endpoint.
 *
 * `reuse` names artifacts of the parent job that the child may start from. Artifact ids, never paths
 * or names: the child's workspace is derived server-side from its own job id, and nothing a caller
 * writes ever becomes part of a filesystem path.
 */
export type RevisionRequest = {
  readonly instruction: string;
  readonly reuse: readonly string[];
};

const MAX_REUSED_ARTIFACTS = 32;

function readReuse(body: Record<string, unknown>, issues: RequestIssue[]): readonly string[] | undefined {
  const raw = body.reuse;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push(issue("reuse", "INVALID_TYPE", "reuse must be an array of artifact ids"));
    return undefined;
  }
  if (raw.length > MAX_REUSED_ARTIFACTS) {
    issues.push(issue("reuse", "TOO_MANY", `reuse must hold at most ${MAX_REUSED_ARTIFACTS} entries`));
    return undefined;
  }
  const before = issues.length;
  const reuse: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isArtifactId(entry)) {
      issues.push(issue(`reuse[${index}]`, "INVALID_VALUE", "reuse entries must be artifact ids"));
      continue;
    }
    reuse.push(entry);
  }
  return issues.length === before ? reuse : undefined;
}

export function validateRevisionRequest(input: unknown): RequestValidation<RevisionRequest> {
  const body = plainObject(input);
  if (body === undefined) {
    return failed([issue("", "INVALID_TYPE", "request body must be a JSON object")]);
  }
  const issues: RequestIssue[] = [];
  rejectUnknownFields(body, ["instruction", "reuse"], "", issues);
  const instruction = readString(body, "instruction", "", issues, { maxLength: MAX_INSTRUCTION_LENGTH });
  const reuse = readReuse(body, issues);
  if (issues.length > 0 || instruction === undefined || reuse === undefined) return failed(issues);
  return { ok: true, value: { instruction, reuse } };
}
