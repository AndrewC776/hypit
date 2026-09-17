/**
 * Hand-written request validation. The repo has no schema library (`@hypit/validation` validates
 * Hypit typed records against a module closure, not HTTP request shapes), so the control plane
 * follows the repo's own idiom: small local predicates, an explicit allow-list of fields, and a
 * result value instead of an exception — a malformed request is ordinary traffic, not a crash.
 */

import {
  failed,
  issue,
  joinPath,
  plainObject,
  readEnumeratedNumber,
  readString,
  rejectUnknownFields,
} from "./request-fields.js";
import type { RequestIssue, RequestValidation } from "./request-fields.js";

export type JobMode = "prepared_run" | "clone";

export const JOB_MODES: readonly JobMode[] = ["prepared_run", "clone"];

export type OutputSpec = {
  readonly width: 1080 | 720 | 540;
  readonly height: 1920 | 1280 | 960;
  readonly fps: 24 | 25 | 30 | 60;
};

export const OUTPUT_WIDTHS: readonly OutputSpec["width"][] = [1080, 720, 540];
export const OUTPUT_HEIGHTS: readonly OutputSpec["height"][] = [1920, 1280, 960];
export const OUTPUT_FPS: readonly OutputSpec["fps"][] = [24, 25, 30, 60];

/** An asset already held by the control plane. Never a caller-supplied filesystem path. */
export type AssetRef = {
  readonly assetId: string;
  readonly role?: string;
};

export type CloneConstraints = {
  readonly maxDurationSeconds?: number;
  readonly language?: string;
  /**
   * The spending gate of contract §16.4: without this grant the worker refuses any plan that
   * carries a paid provider request. Absent means "local providers only".
   */
  readonly spendingAuthorized?: boolean;
};

export type CloneReference =
  | { readonly type: "url"; readonly url: string }
  | { readonly type: "asset"; readonly assetId: string };

export type PreparedRunRequest = {
  readonly mode: "prepared_run";
  /** A registry KEY resolved by the worker's configuration, never a filesystem path. */
  readonly project: string;
  /** A run-source file name inside that project, e.g. `chat.svrun`. */
  readonly run: string;
  readonly output: OutputSpec;
};

export type CloneRequest = {
  readonly mode: "clone";
  readonly reference: CloneReference;
  readonly instruction: string;
  readonly assets: readonly AssetRef[];
  readonly output: OutputSpec;
  readonly constraints?: CloneConstraints;
};

export type JobRequest = PreparedRunRequest | CloneRequest;

export const MAX_INSTRUCTION_LENGTH = 20_000;
export const MAX_ASSETS = 32;
export const MAX_REFERENCE_URL_LENGTH = 2048;


const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** A plain file name: no separator, no dot-dot, no leading dash that the CLI would read as a flag. */
const RUN_SOURCE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ASSET_ROLE = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,4}$/u;

export function isProjectKey(value: unknown): value is string {
  return typeof value === "string" && PROJECT_KEY.test(value);
}

export function isRunSourceName(value: unknown): value is string {
  return typeof value === "string"
    && RUN_SOURCE_NAME.test(value)
    && !value.includes("..")
    && !value.includes("/")
    && !value.includes("\\")
    && value.endsWith(".svrun");
}


function readOutputSpec(
  body: Record<string, unknown>,
  path: string,
  issues: RequestIssue[],
): OutputSpec | undefined {
  const raw = body.output;
  const at = joinPath(path, "output");
  if (raw === undefined) {
    issues.push(issue(at, "REQUIRED", "output is required"));
    return undefined;
  }
  const spec = plainObject(raw);
  if (spec === undefined) {
    issues.push(issue(at, "INVALID_TYPE", "output must be an object"));
    return undefined;
  }
  rejectUnknownFields(spec, ["width", "height", "fps"], at, issues);
  const width = readEnumeratedNumber(spec, "width", at, OUTPUT_WIDTHS, issues);
  const height = readEnumeratedNumber(spec, "height", at, OUTPUT_HEIGHTS, issues);
  const fps = readEnumeratedNumber(spec, "fps", at, OUTPUT_FPS, issues);
  if (width === undefined || height === undefined || fps === undefined) return undefined;
  return { width, height, fps };
}

function readReference(
  body: Record<string, unknown>,
  issues: RequestIssue[],
): CloneReference | undefined {
  const raw = body.reference;
  if (raw === undefined) {
    issues.push(issue("reference", "REQUIRED", "reference is required"));
    return undefined;
  }
  const reference = plainObject(raw);
  if (reference === undefined) {
    issues.push(issue("reference", "INVALID_TYPE", "reference must be an object"));
    return undefined;
  }
  if (reference.type === "url") {
    rejectUnknownFields(reference, ["type", "url"], "reference", issues);
    const url = readString(reference, "url", "reference", issues, { maxLength: MAX_REFERENCE_URL_LENGTH });
    if (url === undefined) return undefined;
    // Structural check only. Host allow-listing and address classification live in url-guard.ts,
    // because they need the deployment's allow-list and a DNS resolver.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      issues.push(issue("reference.url", "INVALID_VALUE", "reference url must be an absolute URL"));
      return undefined;
    }
    if (parsed.protocol !== "https:") {
      issues.push(issue("reference.url", "INVALID_VALUE", "reference url must use https"));
      return undefined;
    }
    return { type: "url", url };
  }
  if (reference.type === "asset") {
    rejectUnknownFields(reference, ["type", "assetId"], "reference", issues);
    const assetId = readString(reference, "assetId", "reference", issues, { maxLength: 128 });
    if (assetId === undefined) return undefined;
    if (!ASSET_ID.test(assetId)) {
      issues.push(issue("reference.assetId", "INVALID_VALUE", "assetId must be a path-free identifier"));
      return undefined;
    }
    return { type: "asset", assetId };
  }
  issues.push(issue("reference.type", "INVALID_VALUE", "reference type must be url or asset"));
  return undefined;
}

function readAssets(body: Record<string, unknown>, issues: RequestIssue[]): readonly AssetRef[] | undefined {
  const raw = body.assets;
  if (raw === undefined) {
    issues.push(issue("assets", "REQUIRED", "assets is required"));
    return undefined;
  }
  if (!Array.isArray(raw)) {
    issues.push(issue("assets", "INVALID_TYPE", "assets must be an array"));
    return undefined;
  }
  if (raw.length > MAX_ASSETS) {
    issues.push(issue("assets", "TOO_MANY", `assets must hold at most ${MAX_ASSETS} entries`));
    return undefined;
  }
  // Only this field's own issues may void it; issues raised by a sibling field are not ours.
  const before = issues.length;
  const assets: AssetRef[] = [];
  for (const [index, entry] of raw.entries()) {
    const at = `assets[${index}]`;
    const asset = plainObject(entry);
    if (asset === undefined) {
      issues.push(issue(at, "INVALID_TYPE", "asset must be an object"));
      continue;
    }
    rejectUnknownFields(asset, ["assetId", "role"], at, issues);
    const assetId = readString(asset, "assetId", at, issues, { maxLength: 128 });
    if (assetId !== undefined && !ASSET_ID.test(assetId)) {
      issues.push(issue(joinPath(at, "assetId"), "INVALID_VALUE", "assetId must be a path-free identifier"));
      continue;
    }
    const role = asset.role;
    if (role !== undefined && (typeof role !== "string" || !ASSET_ROLE.test(role))) {
      issues.push(issue(joinPath(at, "role"), "INVALID_VALUE", "role must be a short lower-case label"));
      continue;
    }
    if (assetId === undefined) continue;
    assets.push(role === undefined ? { assetId } : { assetId, role });
  }
  return issues.length === before ? assets : undefined;
}

function readConstraints(
  body: Record<string, unknown>,
  issues: RequestIssue[],
): CloneConstraints | undefined {
  const raw = body.constraints;
  if (raw === undefined) return undefined;
  const constraints = plainObject(raw);
  if (constraints === undefined) {
    issues.push(issue("constraints", "INVALID_TYPE", "constraints must be an object"));
    return undefined;
  }
  const before = issues.length;
  rejectUnknownFields(constraints, ["maxDurationSeconds", "language", "spendingAuthorized"], "constraints", issues);
  const duration = constraints.maxDurationSeconds;
  if (duration !== undefined
    && (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 1 || duration > 600)) {
    issues.push(issue("constraints.maxDurationSeconds", "INVALID_VALUE",
      "maxDurationSeconds must be an integer between 1 and 600"));
  }
  const language = constraints.language;
  if (language !== undefined && (typeof language !== "string" || !LANGUAGE_TAG.test(language))) {
    issues.push(issue("constraints.language", "INVALID_VALUE", "language must be a BCP-47 style tag"));
  }
  const spending = constraints.spendingAuthorized;
  if (spending !== undefined && typeof spending !== "boolean") {
    issues.push(issue("constraints.spendingAuthorized", "INVALID_TYPE", "spendingAuthorized must be a boolean"));
  }
  if (issues.length !== before) return undefined;
  return {
    ...(typeof duration === "number" ? { maxDurationSeconds: duration } : {}),
    ...(typeof language === "string" ? { language } : {}),
    ...(typeof spending === "boolean" ? { spendingAuthorized: spending } : {}),
  };
}


function validatePreparedRun(body: Record<string, unknown>): RequestValidation<PreparedRunRequest> {
  const issues: RequestIssue[] = [];
  rejectUnknownFields(body, ["mode", "project", "run", "output"], "", issues);
  const project = readString(body, "project", "", issues, { maxLength: 64 });
  if (project !== undefined && !isProjectKey(project)) {
    issues.push(issue("project", "INVALID_VALUE",
      "project must be a registry key of lower-case letters, digits and dashes"));
  }
  const run = readString(body, "run", "", issues, { maxLength: 128 });
  if (run !== undefined && !isRunSourceName(run)) {
    issues.push(issue("run", "INVALID_VALUE", "run must be a plain .svrun file name inside the project"));
  }
  const output = readOutputSpec(body, "", issues);
  if (issues.length > 0 || project === undefined || run === undefined || output === undefined) {
    return failed(issues);
  }
  return { ok: true, value: { mode: "prepared_run", project, run, output } };
}

function validateClone(body: Record<string, unknown>): RequestValidation<CloneRequest> {
  const issues: RequestIssue[] = [];
  rejectUnknownFields(body, ["mode", "reference", "instruction", "assets", "output", "constraints"], "", issues);
  const reference = readReference(body, issues);
  const instruction = readString(body, "instruction", "", issues, { maxLength: MAX_INSTRUCTION_LENGTH });
  const assets = readAssets(body, issues);
  const output = readOutputSpec(body, "", issues);
  const constraints = readConstraints(body, issues);
  if (issues.length > 0
    || reference === undefined || instruction === undefined
    || assets === undefined || output === undefined) {
    return failed(issues);
  }
  return {
    ok: true,
    value: {
      mode: "clone",
      reference,
      instruction,
      assets,
      output,
      ...(constraints === undefined ? {} : { constraints }),
    },
  };
}

/**
 * Validate an untrusted request body. Returns a discriminated result and never throws, so a hostile
 * payload cannot turn into a 500 or a stack trace in a log line.
 */
export function validateJobRequest(input: unknown): RequestValidation<JobRequest> {
  const body = plainObject(input);
  if (body === undefined) {
    return failed([issue("", "INVALID_TYPE", "request body must be a JSON object")]);
  }
  if (body.mode === "prepared_run") return validatePreparedRun(body);
  if (body.mode === "clone") return validateClone(body);
  if (body.mode === undefined) {
    return failed([issue("mode", "REQUIRED", "mode is required")]);
  }
  return failed([issue("mode", "INVALID_VALUE", `mode must be one of ${JOB_MODES.join(", ")}`)]);
}
