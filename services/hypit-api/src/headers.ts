import type { IncomingHttpHeaders } from "node:http";

import { apiError } from "./errors.js";

/**
 * The two request headers that change what the API does, and the rules that keep them from becoming
 * an injection surface. Both end up in an indexed database column and in log lines, so both are
 * narrow ASCII tokens with a length bound, refused rather than trimmed when they do not fit.
 */
export const CALLER_ID_HEADER = "x-caller-id";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * The caller identity half of the idempotency key. It is a correlation label the MCP edge supplies,
 * not an authentication claim — the API is loopback-only and authenticates nobody.
 */
const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const DEFAULT_CALLER_ID = "local";

function single(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  const value = typeof raw === "string" ? raw : raw?.[0];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

export function readCallerId(headers: IncomingHttpHeaders): string {
  const value = single(headers, CALLER_ID_HEADER);
  if (value === undefined) return DEFAULT_CALLER_ID;
  if (!CALLER_ID.test(value)) {
    throw apiError(400, "CALLER_ID_INVALID",
      `${CALLER_ID_HEADER} must be at most 64 characters of letters, digits, dot, underscore, colon or dash`);
  }
  return value;
}

/**
 * Null means "no key": the store then writes NULL, which the partial unique index ignores, so an
 * unkeyed create is always a new job. That is the caller's choice to make, and the MCP edge always
 * makes the other one.
 */
export function readIdempotencyKey(headers: IncomingHttpHeaders): string | null {
  const value = single(headers, IDEMPOTENCY_KEY_HEADER);
  if (value === undefined) return null;
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw apiError(400, "IDEMPOTENCY_KEY_INVALID",
      `${IDEMPOTENCY_KEY_HEADER} must be at most 128 characters of letters, digits, dot, underscore, colon or dash`);
  }
  return value;
}
