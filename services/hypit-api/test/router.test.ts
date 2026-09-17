import assert from "node:assert/strict";
import test from "node:test";

import { createRouter } from "../src/index.js";
import type { Route, RouteParams } from "../src/index.js";

/** The handlers are identities: this file tests matching, and matching alone. */
type Seen = { params: RouteParams | undefined; name: string | undefined };

function routerOf(seen: Seen): ReturnType<typeof createRouter<Seen>> {
  const handler = (name: string) => async (context: Seen, params: RouteParams): Promise<void> => {
    context.name = name;
    context.params = params;
  };
  const routes: readonly Route<Seen>[] = [
    { method: "POST", path: "/v1/jobs", handler: handler("create") },
    { method: "GET", path: "/v1/jobs/:id", handler: handler("read") },
    { method: "GET", path: "/v1/jobs/:id/logs", handler: handler("logs") },
    { method: "POST", path: "/v1/jobs/:id/cancel", handler: handler("cancel") },
    { method: "GET", path: "/health", handler: handler("health") },
  ];
  return createRouter(routes);
}

async function resolve(method: string, path: string): Promise<Seen> {
  const seen: Seen = { params: undefined, name: undefined };
  const match = routerOf(seen).match(method, path);
  assert.equal(match.kind, "matched", `${method} ${path}`);
  if (match.kind !== "matched") return seen;
  await match.handler(seen, match.params);
  return seen;
}

test("a path segment is captured and handed to its handler", async () => {
  const read = await resolve("GET", "/v1/jobs/vid_20260917T110000000Z_0000BEEF");
  assert.equal(read.name, "read");
  assert.deepEqual(read.params, { id: "vid_20260917T110000000Z_0000BEEF" });

  const logs = await resolve("GET", "/v1/jobs/vid_20260917T110000000Z_0000BEEF/logs");
  assert.equal(logs.name, "logs");

  const cancel = await resolve("POST", "/v1/jobs/vid_20260917T110000000Z_0000BEEF/cancel");
  assert.equal(cancel.name, "cancel");
});

test("a captured segment is percent-decoded once", async () => {
  const seen = await resolve("GET", "/v1/jobs/vid%5F1");
  assert.deepEqual(seen.params, { id: "vid_1" });
});

test("a method is matched case-insensitively and empty segments are ignored", async () => {
  const seen: Seen = { params: undefined, name: undefined };
  const router = routerOf(seen);
  assert.equal(router.match("get", "/health").kind, "matched");
  assert.equal(router.match("GET", "//health/").kind, "matched");
});

test("a known path with the wrong method reports the methods that work", () => {
  const seen: Seen = { params: undefined, name: undefined };
  const router = routerOf(seen);
  const match = router.match("DELETE", "/v1/jobs/vid_1");
  assert.equal(match.kind, "method-not-allowed");
  if (match.kind !== "method-not-allowed") return;
  assert.deepEqual([...match.allowed], ["GET"]);
});

test("an unknown path and an undecodable segment match nothing", () => {
  const seen: Seen = { params: undefined, name: undefined };
  const router = routerOf(seen);
  assert.equal(router.match("GET", "/v2/jobs/vid_1").kind, "not-found");
  assert.equal(router.match("GET", "/v1/jobs/vid_1/logs/extra").kind, "not-found");
  // `%zz` is not a valid escape; an id we cannot decode addresses nothing.
  assert.equal(router.match("GET", "/v1/jobs/%zz").kind, "not-found");
});
