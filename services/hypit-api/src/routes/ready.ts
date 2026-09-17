import { latestMigrationVersion } from "@hypit/job-store-sqlite";

import type { RequestContext, ResolvedDependencies } from "../context.js";
import { writeJson } from "../respond.js";

/**
 * `GET /ready`: may this control plane be given work.
 *
 * Three questions, and the answer is no if any of them is: the database answers, its schema is the
 * one this build expects, and a worker has reported recently enough to still be believed. A fourth,
 * the adapter executable, is checked only where the deployment supplies a probe — the worker owns
 * the Hypit distribution and is the process that should refuse to start without it.
 *
 * The body is a status report rather than an error envelope even when it answers 503: "not ready" is
 * this endpoint's normal answer during a restart, and a probe needs to read which check failed.
 */
type ReadyChecks = {
  readonly database: boolean;
  readonly migrations: boolean;
  readonly worker: boolean;
  readonly adapter: boolean | null;
};

function workerIsFresh(at: string | null, nowMs: number, staleAfterMs: number): boolean {
  if (at === null) return false;
  const heartbeat = Date.parse(at);
  if (!Number.isFinite(heartbeat)) return false;
  // A heartbeat from the future is a clock disagreement, not freshness; only the past is evidence.
  return heartbeat <= nowMs && nowMs - heartbeat <= staleAfterMs;
}

async function probeAdapter(deps: ResolvedDependencies): Promise<boolean | null> {
  if (deps.adapterReady === undefined) return null;
  try {
    return await deps.adapterReady();
  } catch {
    return false;
  }
}

export async function ready(context: RequestContext): Promise<void> {
  const { deps } = context;
  let database = true;
  let migrations = false;
  try {
    const applied = deps.store.migrationVersions();
    migrations = applied.includes(latestMigrationVersion());
  } catch {
    database = false;
  }
  let heartbeatAt: string | null = null;
  try {
    heartbeatAt = await deps.workerHeartbeatAt();
  } catch {
    heartbeatAt = null;
  }
  const checks: ReadyChecks = {
    database,
    migrations,
    worker: workerIsFresh(heartbeatAt, deps.now(), deps.config.workerStaleAfterMs),
    adapter: await probeAdapter(deps),
  };
  const ok = checks.database && checks.migrations && checks.worker && checks.adapter !== false;
  writeJson(context.response, ok ? 200 : 503, {
    status: ok ? "ready" : "not_ready",
    checks,
  });
}
