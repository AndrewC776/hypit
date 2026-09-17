/**
 * Every failure this package raises carries a classified `JobError`, because the worker's retry
 * decision is made from the class and from nothing else. An adapter that threw a bare `Error`
 * would push that decision onto whichever `catch` block happened to see it first, and the one
 * class that must never be retried — a paid submission with an unknown outcome — is exactly the
 * one a hopeful `catch` block would retry.
 *
 * Messages are redacted at construction rather than at the log line, so there is no window in
 * which an unredacted message exists as a value the caller might print.
 */
import { jobError, redact } from "@hypit/job-core";
import type { ErrorClass, JobError } from "@hypit/job-core";

export type AdapterErrorInput = {
  readonly class: ErrorClass;
  readonly code: string;
  readonly message: string;
  /** An opaque reference a human can take to `hypit inspect` when an outcome is unknown. */
  readonly receipt?: string;
};

export class AdapterError extends Error {
  readonly error: JobError;

  constructor(input: AdapterErrorInput) {
    const error = jobError({
      class: input.class,
      code: input.code,
      message: redact(input.message),
      ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
    });
    super(error.message);
    this.name = "AdapterError";
    this.error = error;
  }

  get code(): string {
    return this.error.code;
  }

  /** Named `errorClass` rather than `class`, which cannot be an accessor name. */
  get errorClass(): ErrorClass {
    return this.error.class;
  }

  get retryable(): boolean {
    return this.error.retryable;
  }
}

/**
 * A rejected argument. Thrown before any process exists, which is the property the injection
 * tests assert: the recording runner must record nothing.
 */
export class AdapterArgumentError extends AdapterError {
  /** Which argument was rejected, e.g. `output`, `buildId`, `to`. Never the offending value. */
  readonly argument: string;

  constructor(argument: string, message: string, code = "ADAPTER_ARGUMENT") {
    super({ class: "VALIDATION_FAILED", code, message: `${argument}: ${message}` });
    this.name = "AdapterArgumentError";
    this.argument = argument;
  }
}

/** Codes this package mints itself, distinct from anything the CLI can report. */
export const ADAPTER_CODES = {
  argument: "ADAPTER_ARGUMENT",
  destinationExists: "ADAPTER_DESTINATION_EXISTS",
  /** Contract 17.10: an uninstalled checkout dies on stderr with no envelope at all. */
  distributionBroken: "ADAPTER_DISTRIBUTION_BROKEN",
  executableMissing: "ADAPTER_EXECUTABLE_MISSING",
  /** An upstream envelope change. Loud on purpose: silent misparsing is the worse failure. */
  formatUnexpected: "ADAPTER_FORMAT_UNEXPECTED",
  spawnFailed: "ADAPTER_SPAWN_FAILED",
  timeout: "ADAPTER_TIMEOUT",
  aborted: "ADAPTER_ABORTED",
} as const;
