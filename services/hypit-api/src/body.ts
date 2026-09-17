import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { apiError } from "./errors.js";

/**
 * Reading a request body under a hard cap.
 *
 * The cap is enforced while the stream is consumed, not after it has been collected: a 512 MiB body
 * that is measured only once it has been buffered has already done its damage. Two gates, in order —
 * a declared `content-length` over the cap is refused before a single byte is read, and the running
 * total is checked after every chunk, at which point reading simply stops.
 *
 * Stopping is deliberately not destroying. A Node request stream abandoned mid-iteration destroys its
 * socket by default, which would tear down the connection before the 413 explaining the refusal could
 * travel over it — so the body arrives through an iterator that survives being abandoned, and the
 * server decides separately what to do with the remainder.
 *
 * The source is structural rather than `IncomingMessage` so the reader can be driven by a plain async
 * generator in a test, which is the only way to prove that it stops pulling chunks early.
 */
export type RequestBodySource = {
  readonly headers: IncomingHttpHeaders;
  chunks(): AsyncIterable<Uint8Array>;
};

export type BodyLimits = {
  readonly maxBytes: number;
};

export function httpBodySource(request: IncomingMessage): RequestBodySource {
  return {
    headers: request.headers,
    chunks: () => request.iterator({ destroyOnReturn: false }),
  };
}

function readDeclaredLength(headers: IncomingHttpHeaders, maxBytes: number): void {
  const raw = headers["content-length"];
  const value = typeof raw === "string" ? raw : raw?.[0];
  if (value === undefined) return;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw apiError(400, "CONTENT_LENGTH_INVALID", "content-length must be a non-negative integer");
  }
  if (length > maxBytes) {
    throw apiError(413, "BODY_TOO_LARGE", `request body must be at most ${maxBytes} bytes`);
  }
}

function assertJsonMediaType(headers: IncomingHttpHeaders): void {
  const raw = headers["content-type"];
  const value = typeof raw === "string" ? raw : raw?.[0];
  if (value === undefined || value.trim() === "") return;
  const mediaType = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json") {
    throw apiError(415, "UNSUPPORTED_MEDIA_TYPE", "request body must be application/json");
  }
}

/** Collected chunks, joined without Buffer so the reader stays independent of the chunk's class. */
function join(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function readBodyBytes(source: RequestBodySource, limits: BodyLimits): Promise<Uint8Array> {
  assertJsonMediaType(source.headers);
  readDeclaredLength(source.headers, limits.maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source.chunks()) {
    total += chunk.byteLength;
    if (total > limits.maxBytes) {
      // Throwing out of the loop releases the iterator; the remainder of a body we have already
      // decided never to look at is the server's to discard, not this reader's to collect.
      throw apiError(413, "BODY_TOO_LARGE", `request body must be at most ${limits.maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return join(chunks, total);
}

/**
 * The body as parsed JSON. Invalid UTF-8 is refused by the decoder rather than replaced with U+FFFD,
 * because a body that is not the text it claims to be is not a body we should be guessing at.
 */
export async function readJsonBody(source: RequestBodySource, limits: BodyLimits): Promise<unknown> {
  const bytes = await readBodyBytes(source, limits);
  if (bytes.byteLength === 0) {
    throw apiError(400, "INVALID_JSON", "request body is required");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw apiError(400, "INVALID_JSON", "request body must be valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw apiError(400, "INVALID_JSON", "request body must be valid JSON");
  }
}
