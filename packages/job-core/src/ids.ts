import { randomBytes } from "node:crypto";

import { assertOrderedBuildId } from "@hypit/protocol";

/**
 * Hypit already owns Build identity. Re-export its helpers so no second Build id regex is ever
 * written in the control plane: a divergent copy would drift the moment the CLI changes.
 */
export { assertBuildId, assertOrderedBuildId, buildIdCreatedAt, orderedBuildId } from "@hypit/protocol";

/** Identities the control plane mints itself. Build ids come from Hypit, never from here. */
export type ControlPlaneIdKind = "job" | "revision" | "artifact";

/**
 * Every control-plane id carries its own UTC creation time plus a nonce, mirroring the Build id
 * shape (`bld_20260917T111333092Z_9775AB9482`). The timestamp makes ids sort chronologically in a
 * plain TEXT column and lets an operator read a job's age off the id alone; the nonce only keeps
 * two ids minted in the same millisecond distinct.
 */
const ID_PREFIXES: ReadonlyMap<ControlPlaneIdKind, string> = new Map([
  ["job", "vid"],
  ["revision", "rev"],
  ["artifact", "art"],
]);

/**
 * Maps rather than object literals: these are indexed by a value that reaches here from an
 * untyped caller (an HTTP handler, a JSON payload), and a plain lookup of `toString` would hand
 * back an inherited member instead of a miss.
 */
const ID_PATTERNS: ReadonlyMap<ControlPlaneIdKind, RegExp> = new Map([
  ["job", /^vid_(\d{8}T\d{9}Z)_([0-9A-F]{8})$/u],
  ["revision", /^rev_(\d{8}T\d{9}Z)_([0-9A-F]{8})$/u],
  ["artifact", /^art_(\d{8}T\d{9}Z)_([0-9A-F]{8})$/u],
]);

/** `wkr_<hostname>_<pid>_<8 hex>`; the hostname label is sanitised, never the raw string. */
const WORKER_ID_PATTERN = /^wkr_([a-z0-9][a-z0-9-]{0,47})_([0-9]{1,10})_([0-9A-F]{8})$/u;

const NONCE_BYTES = 4;
const MAX_HOSTNAME_LABEL = 48;

/**
 * The last instant whose ISO form still carries a four-digit year. Beyond it `toISOString` emits
 * the expanded `+275760-09-13T...` form, which would silently mint an id that no validator accepts.
 * Refusing the clock value is better than emitting an id the store would later reject.
 */
const MAX_ID_TIME = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export class IdFormatError extends Error {
  readonly code = "ID_FORMAT_INVALID";
  readonly subject: string;

  constructor(subject: string, message: string) {
    super(message);
    this.name = "IdFormatError";
    this.subject = subject;
  }
}

/** The clock is injected so tests can mint an exact id instead of asserting on "roughly now". */
export type IdClock = () => number;

export type IdOptions = {
  readonly now?: IdClock;
  readonly nonce?: () => string;
};

function assert(condition: unknown, subject: string, message: string): asserts condition {
  if (!condition) throw new IdFormatError(subject, message);
}

function randomNonce(): string {
  return randomBytes(NONCE_BYTES).toString("hex").toUpperCase();
}

/** `2026-09-17T11:13:33.092Z` becomes `20260917T111333092Z` — the Build id's own timestamp form. */
function timestampText(value: number): string {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= MAX_ID_TIME, "time",
    "id time must be a non-negative safe integer within the four-digit year range");
  return new Date(value).toISOString().replace(/[-:.]/gu, "");
}

function timestampValue(text: string): number | undefined {
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
    + `T${text.slice(9, 11)}:${text.slice(11, 13)}:${text.slice(13, 15)}.${text.slice(15, 18)}Z`;
  const value = Date.parse(iso);
  // A digit run is not a date: reject 20261399T... instead of silently accepting a rolled-over one.
  return Number.isFinite(value) && timestampText(value) === text ? value : undefined;
}

export function createControlPlaneId(kind: ControlPlaneIdKind, options: IdOptions = {}): string {
  const prefix = ID_PREFIXES.get(kind);
  assert(prefix !== undefined, String(kind), `${String(kind)} is not a control-plane id kind`);
  const now = options.now ?? Date.now;
  const nonce = (options.nonce ?? randomNonce)();
  assert(/^[0-9A-F]{8}$/u.test(nonce), kind, "id nonce must be eight upper-case hex characters");
  return `${prefix}_${timestampText(now())}_${nonce}`;
}

export function createJobId(options: IdOptions = {}): string {
  return createControlPlaneId("job", options);
}

export function createRevisionId(options: IdOptions = {}): string {
  return createControlPlaneId("revision", options);
}

export function createArtifactId(options: IdOptions = {}): string {
  return createControlPlaneId("artifact", options);
}

export function isControlPlaneId(kind: ControlPlaneIdKind, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ID_PATTERNS.get(kind)?.exec(value);
  return match !== null && match !== undefined && timestampValue(match[1]!) !== undefined;
}

export function isJobId(value: unknown): value is string {
  return isControlPlaneId("job", value);
}

export function isRevisionId(value: unknown): value is string {
  return isControlPlaneId("revision", value);
}

export function isArtifactId(value: unknown): value is string {
  return isControlPlaneId("artifact", value);
}

export function assertControlPlaneId(kind: ControlPlaneIdKind, value: unknown): void {
  assert(isControlPlaneId(kind, value), String(kind),
    `${String(kind)} id must look like ${ID_PREFIXES.get(kind) ?? "?"}_<YYYYMMDDTHHMMSSmmmZ>_<8 upper-case hex>`);
}

export function assertJobId(value: unknown): void {
  assertControlPlaneId("job", value);
}

export function assertRevisionId(value: unknown): void {
  assertControlPlaneId("revision", value);
}

export function assertArtifactId(value: unknown): void {
  assertControlPlaneId("artifact", value);
}

/** Creation time carried by a job/revision/artifact id, or undefined when the id is not one of ours. */
export function controlPlaneIdCreatedAt(value: string): number | undefined {
  for (const pattern of ID_PATTERNS.values()) {
    const match = pattern.exec(value);
    if (match !== null) return timestampValue(match[1]!);
  }
  return undefined;
}

/**
 * A worker id is an operator-facing label, so it keeps the host name — but only after sanitising,
 * because the raw value reaches log lines and a DB column and must stay one path-free token.
 */
export function workerHostLabel(hostname: string): string {
  const label = hostname.toLowerCase().replace(/[^a-z0-9-]/gu, "-").replace(/^-+|-+$/gu, "")
    .slice(0, MAX_HOSTNAME_LABEL).replace(/-+$/gu, "");
  return label === "" ? "host" : label;
}

export function createWorkerId(hostname: string, pid: number, options: IdOptions = {}): string {
  assert(Number.isSafeInteger(pid) && pid > 0 && pid <= 9_999_999_999, "pid",
    "worker pid must be a positive safe integer of at most ten digits");
  const nonce = (options.nonce ?? randomNonce)();
  assert(/^[0-9A-F]{8}$/u.test(nonce), "worker", "id nonce must be eight upper-case hex characters");
  return `wkr_${workerHostLabel(hostname)}_${pid}_${nonce}`;
}

export function isWorkerId(value: unknown): value is string {
  return typeof value === "string" && WORKER_ID_PATTERN.test(value);
}

export function assertWorkerId(value: unknown): void {
  assert(isWorkerId(value), "worker", "worker id must look like wkr_<host>_<pid>_<8 upper-case hex>");
}

/** Predicate form of Hypit's own `assertOrderedBuildId`, for call sites that branch rather than throw. */
export function isHypitBuildId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertOrderedBuildId(value);
    return true;
  } catch {
    return false;
  }
}
