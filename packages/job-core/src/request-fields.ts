/**
 * The primitives request validation is built from: the issue vocabulary, and one reader per field
 * kind. They are separate from the request shapes so that adding a shape does not mean re-reading
 * the rules that every shape shares, and so that "unknown fields are rejected" has exactly one
 * implementation rather than one per endpoint.
 *
 * Every reader appends to an issue list and returns `undefined` rather than throwing: a malformed
 * request is ordinary traffic. Collecting the issues means a caller learns everything wrong with a
 * body at once instead of fixing one field per round trip.
 */

/** Machine codes stay stable: the API turns them into `{error:{code}}` and clients branch on them. */
export type RequestIssueCode =
  | "INVALID_TYPE"
  | "INVALID_VALUE"
  | "REQUIRED"
  | "TOO_LONG"
  | "TOO_MANY"
  | "UNKNOWN_FIELD";

export type RequestIssue = {
  /** Dotted path of the offending field, empty for the request body itself. */
  readonly path: string;
  readonly code: RequestIssueCode;
  readonly message: string;
};

export type RequestValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly RequestIssue[] };

export function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function issue(path: string, code: RequestIssueCode, message: string): RequestIssue {
  return { path, code, message };
}

export function joinPath(parent: string, child: string): string {
  return parent === "" ? child : `${parent}.${child}`;
}

/**
 * Unknown fields are rejected rather than ignored: a caller who misspells `instruction` must learn
 * it now, not discover a silently empty video later.
 */
export function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: RequestIssue[],
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      issues.push(issue(joinPath(path, key), "UNKNOWN_FIELD", `unknown field ${key}`));
    }
  }
}

export function readString(
  body: Record<string, unknown>,
  key: string,
  path: string,
  issues: RequestIssue[],
  limits: { readonly maxLength: number; readonly allowBlank?: boolean },
): string | undefined {
  const value = body[key];
  const at = joinPath(path, key);
  if (value === undefined) {
    issues.push(issue(at, "REQUIRED", `${key} is required`));
    return undefined;
  }
  if (typeof value !== "string") {
    issues.push(issue(at, "INVALID_TYPE", `${key} must be a string`));
    return undefined;
  }
  if (value.length > limits.maxLength) {
    issues.push(issue(at, "TOO_LONG", `${key} must be at most ${limits.maxLength} characters`));
    return undefined;
  }
  if (limits.allowBlank !== true && value.trim() === "") {
    issues.push(issue(at, "INVALID_VALUE", `${key} must not be blank`));
    return undefined;
  }
  return value;
}

export function readEnumeratedNumber<T extends number>(
  body: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
  issues: RequestIssue[],
): T | undefined {
  const value = body[key];
  const at = joinPath(path, key);
  if (value === undefined) {
    issues.push(issue(at, "REQUIRED", `${key} is required`));
    return undefined;
  }
  if (typeof value !== "number") {
    issues.push(issue(at, "INVALID_TYPE", `${key} must be a number`));
    return undefined;
  }
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    issues.push(issue(at, "INVALID_VALUE", `${key} must be one of ${allowed.join(", ")}`));
    return undefined;
  }
  return match;
}

export function failed(issues: readonly RequestIssue[]): RequestValidation<never> {
  return { ok: false, issues };
}
