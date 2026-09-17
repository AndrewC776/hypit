import type { IncomingMessage, ServerResponse } from "node:http";

import { createJobId, createRevisionId } from "@hypit/job-core";
import type { AddressLookup, Job } from "@hypit/job-core";
import type { JobStore } from "@hypit/job-store-sqlite";

import type { ApiConfig } from "./config.js";
import { eventLogReader } from "./logs.js";
import { mintRequestId } from "./respond.js";

/**
 * Everything the server needs that is not the configuration, and every one of them injectable.
 *
 * The list reads like a list of things a test would otherwise have to fake by other means: the
 * clock, the id minter, the DNS resolver, the log source, the worker's liveness. Injecting them is
 * what lets the test suite drive a real server over a real socket against a real database while
 * still resolving no name and reaching no network.
 */
export type WorkerHeartbeatProbe = () => string | null | Promise<string | null>;

/** The log source for `GET /v1/jobs/:id/logs`. The default reads the job's own durable history. */
export type JobLogReader = (job: Job, tail: number) => readonly string[] | Promise<readonly string[]>;

export type ApiDependencies = {
  readonly config: ApiConfig;
  readonly store: JobStore;
  readonly now?: () => number;
  readonly newJobId?: () => string;
  readonly newRevisionId?: () => string;
  readonly newRequestId?: () => string;
  /** Injected in tests so no SSRF check resolves a real name; production uses the guard's own DNS. */
  readonly lookup?: AddressLookup;
  readonly readLogs?: JobLogReader;
  /**
   * The most recent worker heartbeat, ISO-8601, or null when no worker has reported. The store keeps
   * heartbeats per claimed job rather than per worker, so readiness takes this as a dependency
   * instead of inventing a query the schema does not have.
   */
  readonly workerHeartbeatAt?: WorkerHeartbeatProbe;
  /** Optional: the deployment's adapter-executable probe, consulted by `/ready` when supplied. */
  readonly adapterReady?: () => boolean | Promise<boolean>;
  /** One line per request, already redacted. Defaults to discarding: a library logs nowhere by default. */
  readonly log?: (line: string) => void;
};

export type ResolvedDependencies = {
  readonly config: ApiConfig;
  readonly store: JobStore;
  readonly now: () => number;
  readonly newJobId: () => string;
  readonly newRevisionId: () => string;
  readonly newRequestId: () => string;
  readonly lookup: AddressLookup | undefined;
  readonly readLogs: JobLogReader;
  readonly workerHeartbeatAt: WorkerHeartbeatProbe;
  readonly adapterReady: (() => boolean | Promise<boolean>) | undefined;
  readonly log: (line: string) => void;
};

export function resolveDependencies(dependencies: ApiDependencies): ResolvedDependencies {
  const now = dependencies.now ?? Date.now;
  return {
    config: dependencies.config,
    store: dependencies.store,
    now,
    newJobId: dependencies.newJobId ?? (() => createJobId({ now })),
    newRevisionId: dependencies.newRevisionId ?? (() => createRevisionId({ now })),
    newRequestId: dependencies.newRequestId ?? mintRequestId,
    lookup: dependencies.lookup,
    readLogs: dependencies.readLogs ?? eventLogReader(dependencies.store),
    // No probe means no evidence of a live worker, and `/ready` says so. Silence is not freshness.
    workerHeartbeatAt: dependencies.workerHeartbeatAt ?? (() => null),
    adapterReady: dependencies.adapterReady,
    log: dependencies.log ?? (() => undefined),
  };
}

export type RequestContext = {
  readonly deps: ResolvedDependencies;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly url: URL;
};

/** ISO-8601 UTC from the injected clock. The API mints every timestamp it writes; the store none. */
export function nowIso(deps: ResolvedDependencies): string {
  return new Date(deps.now()).toISOString();
}
