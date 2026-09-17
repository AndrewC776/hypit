/**
 * The worker's own failures, carrying the same classified `JobError` the adapter raises.
 *
 * Every catch block in this service funnels through `toJobError`, because the retry decision is
 * made from the failure class and from nothing else. A bare `Error` reaching the loop would push
 * that decision onto whichever handler saw it first, and the one class that must never be retried —
 * a paid submission with an unknown outcome — is exactly the one a hopeful retry would repeat.
 */
import { AdapterError } from "@hypit/hypit-adapter";
import { jobError, redact } from "@hypit/job-core";
import type { ErrorClass, JobError } from "@hypit/job-core";

/** Codes the worker mints itself, distinct from anything the CLI or the adapter reports. */
export const WORKER_CODES = {
  configInvalid: "WORKER_CONFIG_INVALID",
  /** Contract 17.8: the worker observes provisioning, it never performs it. */
  programsNotReady: "PROGRAMS_NOT_READY",
  projectNotRegistered: "PROJECT_NOT_REGISTERED",
  modeNotImplemented: "MODE_NOT_IMPLEMENTED",
  requestUnusable: "REQUEST_UNUSABLE",
  /** Contract 16.4: a plan that would spend money without an explicit grant. */
  spendingNotAuthorized: "SPENDING_NOT_AUTHORIZED",
  /** Contract 17.5: more than one Build in the job's project directory, so adoption is a guess. */
  buildAdoptionAmbiguous: "BUILD_ADOPTION_AMBIGUOUS",
  buildNotFound: "BUILD_NOT_FOUND",
  buildFailed: "EXECUTION_FAILED",
  buildObservationTimeout: "BUILD_OBSERVATION_TIMEOUT",
  exportComposite: "EXPORT_OUTPUT_IS_COMPOSITE",
  qcFailed: "QC_FAILED",
  jobLost: "JOB_LOST",
  cancelled: "CANCELLED",
  internal: "INTERNAL",
} as const;

export type WorkerErrorInput = {
  readonly class: ErrorClass;
  readonly code: string;
  readonly message: string;
  /** An opaque reference — a Build id, never a path or a secret — for a human to follow up with. */
  readonly receipt?: string;
};

export class WorkerError extends Error {
  readonly error: JobError;

  constructor(input: WorkerErrorInput) {
    // Redacted at construction, so no window exists in which an unredacted message is a value a
    // caller could print.
    const error = jobError({
      class: input.class,
      code: input.code,
      message: redact(input.message),
      ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
    });
    super(error.message);
    this.name = "WorkerError";
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
 * Classify whatever a stage threw. An adapter or worker error already carries its class; anything
 * else is an unexpected fault and takes the stage's own fallback, which is `INTERNAL` unless the
 * stage knows better (a failed local render is reusable and retryable, a bad project is not).
 */
export function toJobError(cause: unknown, fallback: ErrorClass = "INTERNAL"): JobError {
  if (cause instanceof WorkerError || cause instanceof AdapterError) return cause.error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return jobError({ class: fallback, code: WORKER_CODES.internal, message: redact(message) });
}

/**
 * Re-raise an already classified failure without re-deciding what it is. The retry loop needs this:
 * it catches a stage's throw to record the attempt, and must then rethrow the SAME class, or a
 * `PROVIDER_SUBMISSION_UNKNOWN` would reach the outer handler as an ordinary internal fault and be
 * classified as retryable by a handler that never saw the original.
 */
export function carry(error: JobError): WorkerError {
  return new WorkerError({
    class: error.class,
    code: error.code,
    message: error.message,
    ...(error.receipt === undefined ? {} : { receipt: error.receipt }),
  });
}
