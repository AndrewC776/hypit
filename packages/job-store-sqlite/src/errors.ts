/**
 * The store's own failure vocabulary. It is deliberately tiny: a store answers "no such job", "this
 * row is not what the schema promised" or "that argument cannot be persisted", and everything about
 * the domain — which transition is legal, which failure class may be retried — belongs to
 * `@hypit/job-core` and is raised by its errors instead. Keeping the two vocabularies apart is what
 * lets the API map a refused transition to 409 and a missing job to 404 without reading messages.
 */
export type JobStoreErrorCode =
  | "JOB_NOT_FOUND"
  | "JOB_STORE_ROW_INVALID"
  | "JOB_STORE_ARGUMENT_INVALID";

export class JobStoreError extends Error {
  readonly code: JobStoreErrorCode;

  constructor(code: JobStoreErrorCode, message: string) {
    super(message);
    this.name = "JobStoreError";
    this.code = code;
  }
}

export function assertArgument(condition: unknown, message: string): asserts condition {
  if (!condition) throw new JobStoreError("JOB_STORE_ARGUMENT_INVALID", message);
}

/**
 * A row that fails this check means the file on disk is not the schema this build expects — a
 * half-applied migration, or another program's database at the injected path. Failing loudly beats
 * handing the worker a half-populated Job it would then act on.
 */
export function assertRow(condition: unknown, message: string): asserts condition {
  if (!condition) throw new JobStoreError("JOB_STORE_ROW_INVALID", message);
}
