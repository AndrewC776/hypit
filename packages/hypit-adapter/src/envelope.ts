/**
 * Envelope parsing. Every `--json` payload is a versioned envelope with a `format` field, and the
 * order of checks here is the contract's, not a convenience:
 *
 * 1. stdout, always — under `--json` the CLI prints its error envelope to STDOUT and leaves stderr
 *    empty (contract 16). Building an error message out of stderr would produce an empty message,
 *    and treating "stderr is empty" as success would report a usage error as a healthy build.
 * 2. `format` first. `hypit.cli-error@1` is read as an error whatever command asked for it;
 *    anything else must equal the format that command is documented to print, so an upstream
 *    change fails loudly here rather than silently misparsing into a plausible-looking result.
 * 3. The exit code never classifies anything (contract 17.1): it is only ever 0 or 1, a cancelled
 *    build exits 0, and a healthy in-progress status can exit 1.
 */
import { classifyHypitErrorCode } from "@hypit/job-core";

import { ADAPTER_CODES, AdapterError } from "./errors.js";
import type { ProcessResult } from "./spawn.js";

export const CLI_FORMATS = {
  build: "hypit.cli-build@1",
  builds: "hypit.cli-builds@1",
  cancel: "hypit.cli-cancel@1",
  check: "hypit.cli-check@1",
  error: "hypit.cli-error@1",
  get: "hypit.cli-get@1",
  inspect: "hypit.cli-inspect@1",
  logs: "hypit.cli-logs@1",
  plan: "hypit.cli-plan@1",
  programs: "hypit.cli-programs@1",
  status: "hypit.cli-status@1",
} as const;

export type Envelope = Readonly<Record<string, unknown>>;

export function plainObject(value: unknown): Envelope | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Envelope : undefined;
}

export function readString(source: Envelope | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

export function readNumber(source: Envelope | undefined, key: string): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readArray(source: Envelope | undefined, key: string): readonly unknown[] {
  const value = source?.[key];
  return Array.isArray(value) ? value : [];
}

/** A counter the CLI adds beside an array it truncated, e.g. `omittedRecords`. */
export type OmittedCount = {
  readonly field: string;
  readonly count: number;
};

/**
 * Contract 17.9: `--limit` and `--lines` bound arrays silently and record what they dropped in a
 * paired `omitted*` counter. Reading them generically means a counter added by a later CLI version
 * is surfaced too, instead of being under-reported by an adapter that only knew the old names.
 */
export function omittedCounts(payload: Envelope): readonly OmittedCount[] {
  const counts: OmittedCount[] = [];
  for (const [field, value] of Object.entries(payload)) {
    if (!/^omitted[A-Z]/u.test(field)) continue;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) counts.push({ field, count: value });
  }
  return counts;
}

function distributionBroken(command: string, result: ProcessResult, detail: string): AdapterError {
  // Contract 17.10: an uninstalled checkout dies on stderr with no envelope at all. Reporting that
  // as a Hypit failure would send a human looking at a Build that was never submitted.
  const stderr = result.stderr.trim().slice(0, 500);
  const truncated = result.truncated ? " (output hit the capture cap)" : "";
  return new AdapterError({
    class: "INTERNAL",
    code: ADAPTER_CODES.distributionBroken,
    message: `hypit ${command} produced no usable JSON on stdout${truncated}: ${detail}`
      + (stderr === "" ? "" : `; stderr: ${stderr}`),
  });
}

/** Parse stdout on both success and failure. Exit code is a hint that is deliberately ignored. */
export function parseEnvelope(command: string, result: ProcessResult): Envelope {
  const text = result.stdout.trim();
  if (text === "") throw distributionBroken(command, result, `stdout was empty (exit ${String(result.code)})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw distributionBroken(command, result, error instanceof Error ? error.message : String(error));
  }
  const envelope = plainObject(parsed);
  if (envelope === undefined) throw distributionBroken(command, result, "stdout was not a JSON object");
  return envelope;
}

/**
 * Contract 17.4. `code` is whatever string the thrown error carried, which includes raw Node
 * errnos, so classification goes through `@hypit/job-core` rather than a local switch.
 */
export function errorFromEnvelope(command: string, payload: Envelope): AdapterError {
  const error = plainObject(payload.error);
  const code = readString(error, "code") ?? "CLI_ERROR";
  const message = readString(error, "message") ?? "no message";
  const help = readString(error, "help");
  return new AdapterError({
    class: classifyHypitErrorCode(code),
    code,
    message: `hypit ${command}: ${message}${help === null ? "" : ` (${help})`}`,
  });
}

/**
 * Branch on `format` first, then assert it. A mismatch is raised as this adapter's own error,
 * because an envelope we do not recognise is our problem to fix, not a Build failure to report.
 */
export function expectFormat(command: string, expected: string, payload: Envelope): Envelope {
  const format = readString(payload, "format");
  if (format === CLI_FORMATS.error) throw errorFromEnvelope(command, payload);
  if (format !== expected) {
    throw new AdapterError({
      class: "INTERNAL",
      code: ADAPTER_CODES.formatUnexpected,
      message: `hypit ${command} returned format ${format === null ? "none" : format}, expected ${expected}`,
    });
  }
  return payload;
}
