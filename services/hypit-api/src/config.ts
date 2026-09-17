import { isAbsolute } from "node:path";

import { classifyAddress, isProjectKey } from "@hypit/job-core";

/**
 * Every setting the API has, read from an environment object that the caller passes in rather than
 * from `process.env`. The indirection is what lets a test build a complete, hostile configuration
 * without touching the process it runs in, and it is why no default in this file is a real path on
 * anybody's machine: a home directory, a port or a database location is deployment data, not code.
 *
 * One rule here is load-bearing rather than cosmetic. The control plane drives a host that can
 * spend money and holds live credentials, so the listener must never be reachable from the network:
 * a non-loopback host is refused at load time, before anything can bind it.
 */
export type Environment = Readonly<Record<string, string | undefined>>;

export type ApiConfig = {
  readonly host: string;
  readonly port: number;
  /** Absolute path of the control-plane SQLite file. The store resolves and creates its directory. */
  readonly stateDatabasePath: string;
  /** Project KEY to absolute path. The API resolves nothing: it only checks that a key is known. */
  readonly projectRegistry: ReadonlyMap<string, string>;
  /** Exact host names a clone reference URL may name. */
  readonly referenceAllowlist: readonly string[];
  /** Contract non-negotiable 7: defaults to true and stays true until the exposed keys are rotated. */
  readonly blockedExternalIngress: boolean;
  /** Root under which the worker creates per-job workspaces, hidden from callers when it appears. */
  readonly workspaceRoot: string | null;
  readonly maxBodyBytes: number;
  /** How old a worker heartbeat may be before `/ready` reports the control plane as not ready. */
  readonly workerStaleAfterMs: number;
};

export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 8787;
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;
export const DEFAULT_WORKER_STALE_AFTER_MS = 120_000;

/**
 * The reference hosts this deployment clones from. Held here rather than in `@hypit/job-core` so the
 * guard stays policy-free and a deployment can narrow the list without a code change.
 */
export const DEFAULT_REFERENCE_ALLOWLIST: readonly string[] = [
  "tiktok.com",
  "www.tiktok.com",
  "vt.tiktok.com",
  "vm.tiktok.com",
];

export type ApiConfigErrorCode = "API_CONFIG_INVALID" | "API_HOST_NOT_LOOPBACK";

export class ApiConfigError extends Error {
  readonly code: ApiConfigErrorCode;
  /** The environment variable at fault, so an operator is told what to fix without a stack trace. */
  readonly variable: string;

  constructor(code: ApiConfigErrorCode, variable: string, message: string) {
    super(message);
    this.name = "ApiConfigError";
    this.code = code;
    this.variable = variable;
  }
}

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

/**
 * Loopback means the literal loopback addresses and the name that always maps to them. The address
 * classifier from `@hypit/job-core` decides, so "is this 127.0.0.1" is answered by the same table
 * that answers it for an SSRF check — one definition of loopback, not two that can drift.
 */
export function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  if (host === "localhost") return true;
  const verdict = classifyAddress(host);
  return !verdict.ok && verdict.code === "ADDRESS_LOOPBACK";
}

function invalid(variable: string, message: string): ApiConfigError {
  return new ApiConfigError("API_CONFIG_INVALID", variable, `${variable} ${message}`);
}

function readInteger(env: Environment, variable: string, fallback: number, min: number, max: number): number {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(variable, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readAbsolutePath(env: Environment, variable: string, required: boolean): string | null {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === "") {
    if (required) throw invalid(variable, "is required");
    return null;
  }
  const value = raw.trim();
  if (!isAbsolute(value)) throw invalid(variable, "must be an absolute path");
  return value;
}

/**
 * A JSON map of project key to absolute path. Keys are validated against the same predicate the
 * request validator uses, so a key that could never arrive in a request can never sit in the
 * registry either — the registry is the whole reason the API accepts no filesystem path.
 */
function readProjectRegistry(env: Environment): ReadonlyMap<string, string> {
  const variable = "HYPIT_PROJECT_REGISTRY";
  const raw = env[variable];
  if (raw === undefined || raw.trim() === "") return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid(variable, "must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid(variable, "must be a JSON object mapping a project key to an absolute path");
  }
  const registry = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isProjectKey(key)) throw invalid(variable, `key ${key} is not a project key`);
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw invalid(variable, `the path for ${key} must be an absolute path`);
    }
    registry.set(key, value);
  }
  return registry;
}

function readAllowlist(env: Environment): readonly string[] {
  const variable = "HYPIT_REFERENCE_ALLOWLIST";
  const raw = env[variable];
  if (raw === undefined || raw.trim() === "") return DEFAULT_REFERENCE_ALLOWLIST;
  const hosts = raw.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
  if (hosts.length === 0) throw invalid(variable, "must list at least one host");
  for (const host of hosts) {
    if (!HOSTNAME.test(host)) throw invalid(variable, `entry ${host} is not a host name`);
  }
  return hosts;
}

/**
 * Anything but an explicit `false` leaves ingress blocked. The flag exists to stay on until two
 * leaked credentials are rotated, so a typo must fail closed rather than quietly open the door.
 */
function readIngressFlag(env: Environment): boolean {
  const variable = "SECURITY_BLOCKED_EXTERNAL_INGRESS";
  const raw = env[variable];
  if (raw === undefined || raw.trim() === "") return true;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid(variable, "must be exactly true or false");
}

export function loadApiConfig(env: Environment): ApiConfig {
  const host = (env.HYPIT_API_HOST ?? DEFAULT_API_HOST).trim();
  if (!isLoopbackHost(host)) {
    throw new ApiConfigError("API_HOST_NOT_LOOPBACK", "HYPIT_API_HOST",
      `HYPIT_API_HOST must be a loopback address; ${host} is reachable from the network`);
  }
  const stateDatabasePath = readAbsolutePath(env, "HYPIT_STATE_DB", true);
  if (stateDatabasePath === null) throw invalid("HYPIT_STATE_DB", "is required");
  return {
    host,
    port: readInteger(env, "HYPIT_API_PORT", DEFAULT_API_PORT, 0, 65_535),
    stateDatabasePath,
    projectRegistry: readProjectRegistry(env),
    referenceAllowlist: readAllowlist(env),
    blockedExternalIngress: readIngressFlag(env),
    workspaceRoot: readAbsolutePath(env, "HYPIT_WORKSPACE_ROOT", false),
    maxBodyBytes: MAX_REQUEST_BODY_BYTES,
    workerStaleAfterMs: readInteger(env, "HYPIT_WORKER_STALE_AFTER_MS", DEFAULT_WORKER_STALE_AFTER_MS, 1, 3_600_000),
  };
}
