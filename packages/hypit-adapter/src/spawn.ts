/**
 * The one place in the control plane that starts an external process.
 *
 * Three properties matter here and each is load-bearing:
 *
 * - `shell: false` with an argv array. No string is ever interpolated into a command line, so the
 *   shell metacharacters that the injection tests throw at the adapter have no interpreter to
 *   reach even if validation were to miss one.
 * - stdout and stderr are captured separately and capped. A Build that logs a gigabyte must not
 *   take the worker down with it, and stdout must stay parseable on its own because under `--json`
 *   the CLI prints its error envelope to stdout and leaves stderr empty (contract 16).
 * - The timeout bounds THIS process only. A `status` or `logs` observer is not the Build: killing
 *   it must never cancel durable work, and the CLI's own behaviour makes that true (contract
 *   16.3 — a killed `build` process leaves a real Build running).
 */
import { spawn } from "node:child_process";

import { redact } from "@hypit/job-core";

import { ADAPTER_CODES, AdapterError } from "./errors.js";

/** 8 MiB per stream. Injectable, because a test proves the cap by setting a small one. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 300_000;

export type ProcessResult = {
  /** Null when the process was killed by a signal rather than exiting on its own. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when either stream hit the cap, so a parse failure can be explained honestly. */
  readonly truncated: boolean;
};

export type ProcessOptions = {
  readonly cwd?: string;
  /** Explicit and complete. The adapter never hands a child `process.env` wholesale. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
};

/**
 * The seam every caller takes, so a test can drive the parsers with a captured payload and prove
 * that a rejected argument reached no process at all.
 */
export type ProcessRunner = (
  executable: string,
  argv: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

/**
 * A byte-bounded collector. Past the cap the chunks are dropped rather than buffered, but the
 * stream is still read: a child whose pipe is never drained blocks forever instead of exiting.
 */
class CappedOutput {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    const room = this.#limit - this.#bytes;
    if (room <= 0) {
      this.#truncated = true;
      return;
    }
    if (chunk.length <= room) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.length;
      return;
    }
    this.#chunks.push(chunk.subarray(0, room));
    this.#bytes = this.#limit;
    this.#truncated = true;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  /** A cut at the cap can split a multi-byte character; one replacement char is the cost. */
  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

function aborted(executable: string): AdapterError {
  return new AdapterError({
    class: "CANCELLED",
    code: ADAPTER_CODES.aborted,
    message: `${executable} was aborted by its caller`,
  });
}

function startFailure(executable: string, error: NodeJS.ErrnoException): AdapterError {
  const missing = error.code === "ENOENT" || error.code === "EACCES";
  return new AdapterError({
    class: "INTERNAL",
    code: missing ? ADAPTER_CODES.executableMissing : ADAPTER_CODES.spawnFailed,
    message: `${executable} could not start: ${error.message}`,
  });
}

/**
 * Run one program to completion and return both streams. Resolves for any exit code: exit codes
 * carry almost no information in this CLI (contract 17.1), so classification is the caller's job
 * and happens on the JSON envelope, not here.
 */
export function runProcess(
  executable: string,
  argv: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (options.signal?.aborted === true) return Promise.reject(aborted(executable));
  return new Promise<ProcessResult>((settle, reject) => {
    const child = spawn(executable, [...argv], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...options.env },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const stdout = new CappedOutput(limit);
    const stderr = new CappedOutput(limit);
    let done = false;
    const succeed = (result: ProcessResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(result);
    };
    const fail = (error: AdapterError): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      // SIGKILL, not SIGTERM: an observer has no cleanup worth waiting for, and the durable work
      // it observes lives in the Hypit Worker rather than in this process.
      child.kill("SIGKILL");
      fail(new AdapterError({
        class: "INTERNAL",
        code: ADAPTER_CODES.timeout,
        message: `${executable} did not finish within ${timeoutMs} ms`,
      }));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(error.name === "AbortError" ? aborted(executable) : startFailure(executable, error));
    });
    // `close` rather than `exit`: the streams are complete only once they have closed, and a
    // truncated final chunk of JSON would otherwise look like a broken distribution.
    child.on("close", (code) => {
      succeed({
        code,
        stdout: stdout.text(),
        // stderr is never parsed, so it is redacted here: it is the stream most likely to carry a
        // credential from a stack trace or a tool's own diagnostic echo.
        stderr: redact(stderr.text()),
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}
