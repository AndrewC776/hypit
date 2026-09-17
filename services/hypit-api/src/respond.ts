import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { ApiError } from "./errors.js";

/**
 * Response writing, in one place, so that two rules hold for every route without any route having to
 * remember them: the request id travels on every response, and an error body always has the same
 * shape. A caller correlating a failure in its own log with a line in ours has only that id to go on.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/** Deliberately narrow: a correlation id reaches log lines, so it stays plain ASCII and bounded. */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function mintRequestId(): string {
  return `req_${randomBytes(8).toString("hex")}`;
}

/**
 * Honours a caller-supplied `x-request-id` when it is safe, mints one otherwise. A malformed value
 * is replaced rather than refused: correlation is a convenience, and failing a job creation over a
 * header the caller can regenerate would be the worse outcome.
 */
export function resolveRequestId(header: string | readonly string[] | undefined, mint: () => string): string {
  const value = typeof header === "string" ? header : header?.[0];
  return value !== undefined && REQUEST_ID.test(value) ? value : mint();
}

export function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    // The control plane's answers are per-request state; a cached job status is a wrong job status.
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

export type ErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
  };
};

export function errorBody(error: ApiError, requestId: string): ErrorBody {
  return { error: { code: error.code, message: error.message, request_id: requestId } };
}

export function writeApiError(
  response: ServerResponse,
  error: ApiError,
  requestId: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  writeJson(response, error.status, errorBody(error, requestId), headers);
}
