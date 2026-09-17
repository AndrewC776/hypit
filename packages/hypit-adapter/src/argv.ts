/**
 * Argument validation and the per-command option allow-list, transcribed from the CLI's own
 * parser (contract 17.2). Everything in this file runs BEFORE a process exists: the adapter's
 * security property is that a rejected argument never reaches a spawn, so every check here is
 * synchronous, total, and throws `AdapterArgumentError` rather than returning a verdict a caller
 * could forget to read.
 *
 * Three rules of the CLI's parser shape the builder:
 *
 * - There is no `--opt=value` form. An option and its value are two argv elements.
 * - An option value may not begin with `--`; the parser reads it as a missing value and reports a
 *   confusing usage error. We reject such a value here, where the message can name the argument.
 * - Each command accepts a different option set. Passing a uniform flag block is a usage error,
 *   not a harmless no-op — `--runtime` on `check` or `get` is the case that actually bites.
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertOrderedBuildId } from "@hypit/protocol";

import { AdapterArgumentError } from "./errors.js";

/** Contract 6. One segment, no separators, no leading dash the CLI would read as a flag. */
export const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** A run source or check source: a plain file name inside the workspace, never a path. */
export const SOURCE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;

/**
 * A cancellation reason reaches the CLI as an option value and reaches an operator as prose.
 * The character set is deliberately narrower than "anything a shell cannot misread": the contract
 * requires every injection payload to be rejected wherever it is passed, and a reason worth
 * recording — `cancel requested by caller` — needs only letters, digits and a little punctuation.
 */
export const REASON_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._,:-]{0,199}$/u;

export const MAX_LOG_LINES = 1000;

export type HypitCommand =
  | "check"
  | "plan"
  | "build"
  | "status"
  | "logs"
  | "cancel"
  | "get"
  | "builds"
  | "inspect"
  | "paths"
  | "programs status";

/** Accepted by every command. */
const COMMON_OPTIONS: readonly string[] = ["--json", "--color", "--no-color", "--verbose", "--debug"];

/**
 * Contract 17.2, one row per command. A subcommand that has its own option set is its own row —
 * `programs status` accepts neither `--max-wait-ms` (which applies only to `programs up`) nor a
 * positional profile, so keying it separately states exactly that rather than approximating it with
 * one `programs` row covering three different subcommands.
 *
 * `doctor` remains absent: its Runtime Profile may be positional or `--runtime` but never both, a
 * rule a flat option row cannot express, and v1 does not invoke it through this builder.
 */
export const COMMAND_OPTIONS: ReadonlyMap<HypitCommand, readonly string[]> = new Map<HypitCommand, readonly string[]>([
  ["check", ["--package-root", "--workspace", "--asset-root", "--limit"]],
  ["plan", ["--runtime", "--package-root", "--workspace", "--asset-root", "--limit"]],
  ["build", [
    "--runtime", "--package-root", "--workspace", "--asset-root", "--follow", "--max-wait-ms", "--title", "--limit",
  ]],
  ["status", ["--runtime", "--workspace", "--watch", "--max-wait-ms", "--limit"]],
  ["logs", ["--runtime", "--workspace", "--lines"]],
  ["cancel", ["--runtime", "--workspace", "--reason"]],
  ["get", ["--workspace", "--output", "--to"]],
  ["builds", ["--workspace", "--limit", "--before"]],
  ["inspect", ["--workspace", "--output", "--limit"]],
  ["paths", ["--runtime", "--workspace"]],
  ["programs status", ["--runtime", "--workspace", "--limit", "--endpoint"]],
]);

/** Contract 17.2: everything else is a usage error when it appears twice. */
const REPEATABLE_OPTIONS: ReadonlySet<string> = new Set([
  "--endpoint", "--json", "--jsonl", "--watch", "--verbose", "--debug", "--no-color", "--follow",
  "--asset-root", "--highlight",
]);

function reject(argument: string, message: string, code?: string): never {
  if (code === undefined) throw new AdapterArgumentError(argument, message);
  throw new AdapterArgumentError(argument, message, code);
}

function assertPlainText(argument: string, value: unknown): asserts value is string {
  if (typeof value !== "string") reject(argument, "must be a string");
  if (value === "") reject(argument, "must not be empty");
  // A NUL truncates the argument inside libc; a newline splits a log line into two.
  if (/[\0\r\n]/u.test(value)) reject(argument, "must not contain a NUL or a line break");
}

/**
 * Contract 17.2: a value beginning with `--` is read as a missing value. We reject a leading `-`
 * outright — none of the values this adapter passes (an absolute path, an output name, a line
 * count, a reason) legitimately starts with one, and the stricter rule leaves no gap to reason
 * about.
 */
export function assertOptionValue(argument: string, value: unknown): asserts value is string {
  assertPlainText(argument, value);
  if (value.startsWith("-")) {
    reject(argument, "must not begin with a dash: the CLI reads such a value as a missing value");
  }
}

/** Reuses the repo's own Build identity helper. There is no second Build id regex in this package. */
export function assertBuildIdArgument(value: unknown, argument = "buildId"): asserts value is string {
  assertPlainText(argument, value);
  try {
    assertOrderedBuildId(value);
  } catch (error) {
    reject(argument, `is not an ordered Build id: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertOutputName(value: unknown, argument = "output"): asserts value is string {
  assertPlainText(argument, value);
  if (!OUTPUT_NAME.test(value)) {
    reject(argument, "must be 1-64 characters of letters, digits, dot, dash or underscore, starting with a letter or digit");
  }
}

export function assertSourceName(value: unknown, argument = "source"): asserts value is string {
  assertPlainText(argument, value);
  if (!SOURCE_NAME.test(value) || value.includes("..")) {
    reject(argument, "must be a plain file name inside the workspace, with no separator and no dot-dot");
  }
}

export function assertReason(value: unknown, argument = "reason"): asserts value is string {
  assertPlainText(argument, value);
  if (!REASON_TEXT.test(value)) {
    reject(argument, "must be short prose: letters, digits, spaces and `. _ , : -` only");
  }
}

export function assertLineCount(value: unknown, argument = "lines"): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LOG_LINES) {
    reject(argument, `must be an integer between 1 and ${MAX_LOG_LINES}`);
  }
}

/**
 * Absolute and already normalised. `resolve(value) === value` is the check, not `normalize`:
 * it also rejects a trailing separator and a `.` segment, and on Windows it rejects a POSIX-shaped
 * path like `/etc/passwd`, which `isAbsolute` alone accepts there.
 */
export function assertAbsolutePath(argument: string, value: unknown): asserts value is string {
  assertPlainText(argument, value);
  if (!isAbsolute(value)) reject(argument, "must be an absolute path");
  if (resolve(value) !== value) reject(argument, "must be an absolute path in normalised form");
}

function contains(root: string, target: string): boolean {
  const rest = relative(root, target);
  // `rest.startsWith("..")` alone would reject a legitimate sibling named `..foo`.
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
}

export function assertAllowedRoots(roots: readonly string[], argument = "allowedRoots"): void {
  if (roots.length === 0) reject(argument, "must name at least one allowed root");
  for (const root of roots) assertAbsolutePath(argument, root);
}

/**
 * The containment rule of contract 6 and 8: the worker hands the adapter an explicit allowed root
 * and the adapter enforces it, so a path argument can never address anything outside the job's own
 * area even if every other check were to pass.
 */
export function assertContainedPath(
  argument: string,
  value: unknown,
  allowedRoots: readonly string[],
): asserts value is string {
  assertAbsolutePath(argument, value);
  assertAllowedRoots(allowedRoots);
  if (!allowedRoots.some((root) => contains(root, value))) {
    reject(argument, "must be contained within an allowed root");
  }
}

/** A source file name resolved against the workspace, which is where the CLI expects to find it. */
export function sourcePath(name: unknown, workspace: string, allowedRoots: readonly string[], argument = "source"): string {
  assertSourceName(name, argument);
  assertContainedPath("workspace", workspace, allowedRoots);
  const resolved = join(workspace, name);
  assertContainedPath(argument, resolved, allowedRoots);
  return resolved;
}

/** A value-less flag carries no `value`; `--json` is the only one v1 uses. */
export type ArgvOption = {
  readonly name: string;
  readonly value?: string;
};

/**
 * Build one argv array. The allow-list check runs here rather than at each call site so that a
 * new command cannot quietly inherit another command's flags, and so that `--runtime` on `check`
 * or `get` fails as the usage error it is instead of reaching the CLI.
 */
export function buildArgv(
  command: HypitCommand,
  positionals: readonly string[],
  options: readonly ArgvOption[],
): string[] {
  const allowed = COMMAND_OPTIONS.get(command);
  if (allowed === undefined) reject("command", `is not a command this adapter builds: ${command}`);
  // A multi-word command is a subcommand: "programs status" has to reach the CLI as two argv
  // elements, never as one string containing a space.
  const argv: string[] = command.split(" ");
  for (const positional of positionals) {
    assertOptionValue(`${command} argument`, positional);
    argv.push(positional);
  }
  const seen = new Set<string>();
  for (const option of options) {
    const { name } = option;
    if (name.includes("=")) {
      reject(name, "must be passed as two argv elements: the CLI has no --opt=value form");
    }
    if (!COMMON_OPTIONS.includes(name) && !allowed.includes(name)) {
      reject(name, `does not apply to ${command}`, "ADAPTER_OPTION_NOT_ALLOWED");
    }
    if (seen.has(name) && !REPEATABLE_OPTIONS.has(name)) {
      reject(name, `may not be repeated on ${command}`);
    }
    seen.add(name);
    argv.push(name);
    if (option.value !== undefined) {
      assertOptionValue(name, option.value);
      argv.push(option.value);
    }
  }
  return argv;
}
