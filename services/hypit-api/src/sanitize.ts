import { dirname } from "node:path";

import { redact, relativizePaths } from "@hypit/job-core";
import type { Job, PathRoot } from "@hypit/job-core";

import type { ApiConfig } from "./config.js";

/**
 * Nothing leaves this process without passing through here.
 *
 * Two different leaks are closed by two different tools. `redact` removes credentials — the repo has
 * already lost an `sk-` key and a cloudflared token this way. `relativizePaths` removes the host's
 * directory layout, which Hypit's own execution-log records embed as URL-encoded absolute paths
 * (contract §15 TRAP 3), and which would otherwise hand every MCP caller the operator's user name.
 *
 * Redaction runs first. Its rules are line-anchored — a header rule matches to the end of the line —
 * so they should see the text as it was written, before a root is collapsed into a short label.
 */
export function sanitizeText(text: string, roots: readonly PathRoot[]): string {
  return relativizePaths(redact(text), roots);
}

/**
 * The roots worth hiding, most specific first — though `relativizePaths` sorts by length itself, so
 * a job workspace nested under the workspace root is labelled as the workspace either way.
 *
 * The project registry is included because a `prepared_run` job's paths live under a registered
 * project, and the registry's values are absolute paths on the production host.
 */
export function pathRoots(config: ApiConfig, job?: Job): readonly PathRoot[] {
  const roots: PathRoot[] = [];
  if (job?.workspacePath !== undefined && job.workspacePath !== null) {
    roots.push({ path: job.workspacePath, as: "<workspace>" });
  }
  if (config.workspaceRoot !== null) roots.push({ path: config.workspaceRoot, as: "<workspaces>" });
  for (const [key, path] of config.projectRegistry) roots.push({ path, as: `<project:${key}>` });
  roots.push({ path: dirname(config.stateDatabasePath), as: "<state>" });
  return roots;
}
