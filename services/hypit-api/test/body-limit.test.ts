import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { ClientRequest, OutgoingHttpHeaders } from "node:http";
import test from "node:test";

import { ApiError, MAX_REQUEST_BODY_BYTES, readJsonBody } from "../src/index.js";
import type { RequestBodySource } from "../src/index.js";
import { object, postJson, withHarness } from "./harness.js";

const CHUNK_BYTES = 64 * 1024;

/**
 * A body source that yields on demand and counts what it was asked for. A `Readable` would read
 * ahead to fill its own buffer and so could not show whether the reader stopped early; a bare async
 * iterable is pulled exactly once per loop iteration, which is the whole point of this test.
 */
function countingSource(chunks: number): {
  readonly source: RequestBodySource;
  readonly pulled: () => number;
  readonly released: () => boolean;
} {
  let pulled = 0;
  let released = false;
  async function* body(): AsyncGenerator<Uint8Array> {
    try {
      for (let index = 0; index < chunks; index += 1) {
        pulled += 1;
        yield new Uint8Array(CHUNK_BYTES).fill(0x61);
      }
    } finally {
      // Runs when the reader abandons the iterator, which is how "it stopped early" is observed.
      released = true;
    }
  }
  const source: RequestBodySource = {
    headers: { "content-type": "application/json" },
    chunks: body,
  };
  return { source, pulled: () => pulled, released: () => released };
}

type RawResponse = {
  readonly status: number;
  readonly body: Record<string, unknown>;
};

/**
 * A raw client, because `fetch` will not let a test declare a `content-length` it does not intend to
 * satisfy — which is exactly the shape of the request the header gate exists to refuse.
 */
function rawPost(
  origin: string,
  path: string,
  headers: OutgoingHttpHeaders,
  send: (request: ClientRequest, responded: () => boolean) => void | Promise<void>,
): Promise<RawResponse> {
  const url = new URL(path, origin);
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    let responded = false;
    let status = 0;
    let text = "";
    const finish = (): void => {
      if (settled) return;
      settled = true;
      request.destroy();
      resolve({ status, body: text === "" ? {} : object(JSON.parse(text)) });
    };
    const request = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers },
      (response) => {
        responded = true;
        status = response.statusCode ?? 0;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", finish);
      },
    );
    // RFC 9110 asks a server that refuses a body to close the connection rather than keep reading
    // one it has already rejected. So a reset on the write side after the answer is part of the
    // behaviour under test, not a failure of it; the answer itself still has to arrive and is what
    // the assertions read.
    request.on("error", (error: Error & { readonly code?: string }) => {
      if (error.code === "ECONNRESET" || error.code === "EPIPE") return;
      if (!settled) reject(error);
    });
    request.on("close", () => {
      if (settled) return;
      if (responded) finish();
      else reject(new Error("the connection closed before any response arrived"));
    });
    void send(request, () => responded);
  });
}

test("the body reader stops pulling chunks once the cap is passed", async () => {
  const counting = countingSource(64);
  const failure = await readJsonBody(counting.source, { maxBytes: MAX_REQUEST_BODY_BYTES })
    .then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof ApiError, `expected an ApiError, got ${String(failure)}`);
  assert.equal(failure.status, 413);
  assert.equal(failure.code, "BODY_TOO_LARGE");
  // 256 KiB of cap, 64 KiB per chunk: the fifth chunk crosses it and nothing after it is requested,
  // so a 4 MiB body costs 320 KiB of memory rather than 4 MiB.
  assert.equal(counting.pulled(), 5);
  assert.equal(counting.released(), true);
});

test("a declared content-length over the cap is refused before a byte of body is read", async () => {
  await withHarness({}, async (harness) => {
    const response = await rawPost(
      harness.origin,
      "/v1/jobs",
      { "content-type": "application/json", "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
      (request) => {
        // Deliberately far less than the declared length: the gate must not be waiting for it.
        request.write("{");
      },
    );
    assert.equal(response.status, 413);
    assert.equal(object(response.body.error).code, "BODY_TOO_LARGE");
  });
});

test("a chunked body over the cap is refused while it streams", async () => {
  await withHarness({}, async (harness) => {
    const response = await rawPost(
      harness.origin,
      "/v1/jobs",
      { "content-type": "application/json" },
      async (request, responded) => {
        // One chunk at a time, respecting backpressure and stopping the moment the answer lands.
        // That is the claim being made: the refusal arrives mid-upload, without the client having
        // to push the whole oversized body first.
        for (let index = 0; index < 16 && !responded(); index += 1) {
          if (!request.write(Buffer.alloc(CHUNK_BYTES, "a"))) {
            await once(request, "drain").catch(() => undefined);
          }
        }
        request.end();
      },
    );
    assert.equal(response.status, 413);
    assert.equal(object(response.body.error).code, "BODY_TOO_LARGE");
  });
});

test("a body just under the cap is read and reaches validation", async () => {
  await withHarness({}, async (harness) => {
    const padding = "p".repeat(MAX_REQUEST_BODY_BYTES - 1_024);
    const body = JSON.stringify({ mode: "prepared_run", padding });
    assert.ok(body.length < MAX_REQUEST_BODY_BYTES, "the fixture must stay under the transport cap");
    const response = await harness.request("/v1/jobs", postJson(body));
    // Refused for what it says, not for how big it is: the cap is a transport rule only.
    assert.equal(response.status, 400);
    assert.equal(object(response.body.error).code, "VALIDATION_FAILED");
  });
});
