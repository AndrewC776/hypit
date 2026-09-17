/**
 * Failure classification. `retryable` is a property of the class, never of the caller's opinion:
 * the one place that decides is `retryable()`, so no stage handler can talk itself into retrying a
 * paid remote submission.
 */
export type ErrorClass =
  | "RETRYABLE_TRANSPORT"
  | "PROVIDER_SUBMISSION_UNKNOWN"
  | "HYPIT_BUILD_FAILED"
  | "LOCAL_RENDER_FAILED"
  | "AUTHORING_FAILED"
  | "VALIDATION_FAILED"
  | "QC_FAILED"
  | "CANCELLED"
  | "INTERNAL";

export const ERROR_CLASSES: readonly ErrorClass[] = [
  "RETRYABLE_TRANSPORT",
  "PROVIDER_SUBMISSION_UNKNOWN",
  "HYPIT_BUILD_FAILED",
  "LOCAL_RENDER_FAILED",
  "AUTHORING_FAILED",
  "VALIDATION_FAILED",
  "QC_FAILED",
  "CANCELLED",
  "INTERNAL",
];

/**
 * Only a transport hiccup and a local render failure may be retried automatically, and both are
 * bounded by `DEFAULT_MAX_ATTEMPTS`. PROVIDER_SUBMISSION_UNKNOWN is the load-bearing exclusion:
 * the operation may already have been accepted and charged, so a retry can double-charge. It
 * records a receipt and fails the job for a human instead.
 */
const RETRYABLE_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
  "RETRYABLE_TRANSPORT",
  "LOCAL_RENDER_FAILED",
]);

export const DEFAULT_MAX_ATTEMPTS = 3;

export function isErrorClass(value: unknown): value is ErrorClass {
  return typeof value === "string" && (ERROR_CLASSES as readonly string[]).includes(value);
}

export function retryable(errorClass: ErrorClass): boolean {
  return RETRYABLE_CLASSES.has(errorClass);
}

export type JobError = {
  readonly class: ErrorClass;
  /** The originating machine code, e.g. a CLI envelope code or a control-plane code. */
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  /**
   * An opaque reference a human can take to the provider or to `hypit inspect` when an outcome is
   * unknown. Never a secret and never a full filesystem path.
   */
  readonly receipt?: string;
};

export type JobErrorInput = {
  readonly class: ErrorClass;
  readonly code: string;
  readonly message: string;
  readonly receipt?: string;
};

/** The only constructor for a JobError, so `retryable` can never disagree with the class. */
export function jobError(input: JobErrorInput): JobError {
  return {
    class: input.class,
    code: input.code,
    message: input.message,
    retryable: retryable(input.class),
    ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
  };
}

/**
 * Hypit CLI codes, mapped to classes. Two sources feed this: the `hypit.cli-error@1` envelope
 * (`CLI_USAGE`, `CLI_ERROR`, `PACKAGE_SELECTION_MISSING`, or a raw Node errno) and the operational
 * codes that appear inside doctor/plan diagnostics and build failures.
 */
const CLI_ERROR_CLASSES: ReadonlyMap<string, ErrorClass> = new Map<string, ErrorClass>(Object.entries({
  // Submitted, outcome unknown. Never auto-retried: a retry may double-charge a paid provider.
  EXECUTION_UNKNOWN: "PROVIDER_SUBMISSION_UNKNOWN",
  SUBMISSION_INTERRUPTED: "PROVIDER_SUBMISSION_UNKNOWN",
  // The Build ran and failed; its Result survives, so a revision can reuse what did succeed.
  EXECUTION_FAILED: "HYPIT_BUILD_FAILED",
  BUILD_DEADLOCK: "HYPIT_BUILD_FAILED",
  CANCELLED: "CANCELLED",
  // A bad request or an unusable project, not a transient condition.
  PACKAGE_SELECTION_MISSING: "VALIDATION_FAILED",
  // We build the argv, so a usage error is our bug, not the caller's.
  CLI_USAGE: "INTERNAL",
  CLI_ERROR: "INTERNAL",
  // Host or runtime provisioning problems; `programs up` fixes them, a retry does not.
  RUNTIME_CREDENTIAL_MISSING: "INTERNAL",
  RUNTIME_EXECUTABLE_MISSING: "INTERNAL",
  ADAPTER_DISTRIBUTION_BROKEN: "INTERNAL",
  // `hypit.cli-status@1` with `build: null`: the Build we recorded cannot be observed any more.
  BUILD_NOT_FOUND: "INTERNAL",
  ENOENT: "INTERNAL",
  EACCES: "INTERNAL",
  EPERM: "INTERNAL",
  // Transient network conditions while fetching a reference.
  ETIMEDOUT: "RETRYABLE_TRANSPORT",
  ECONNRESET: "RETRYABLE_TRANSPORT",
  EAI_AGAIN: "RETRYABLE_TRANSPORT",
} as const));

/**
 * Classify a Hypit CLI code. Exit codes carry almost no information (a cancelled build exits 0, a
 * healthy in-progress status can exit 1), so classification reads the JSON envelope code only.
 * An unrecognised code falls back to `fallback`, which the caller sets from the stage it is in.
 */
export function classifyHypitErrorCode(code: string, fallback: ErrorClass = "INTERNAL"): ErrorClass {
  // A Map, not an object literal: a plain lookup of `toString` or `__proto__` would otherwise
  // return an inherited member and pass it off as an error class.
  return CLI_ERROR_CLASSES.get(code) ?? fallback;
}

export function hypitErrorCodes(): readonly string[] {
  return [...CLI_ERROR_CLASSES.keys()];
}
