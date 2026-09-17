import assert from "node:assert/strict";
import test from "node:test";

import { CLOCK_BASE, errorOf, postJson, preparedRunBody, withHarness } from "./harness.js";
import { ingressAllowed, listen } from "../src/index.js";

test("every response carries a request id, including the ones nothing handled", async () => {
  await withHarness({}, async (harness) => {
    const routes = ["/health", "/ready", "/v1/jobs/vid_20260917T110000000Z_0000BEEF", "/nope"];
    for (const path of routes) {
      const response = await harness.request(path);
      assert.match(String(response.requestId), /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, path);
    }
  });
});

test("a caller's own request id is echoed back and reported in the error body", async () => {
  await withHarness({}, async (harness) => {
    const response = await harness.request("/nope", { headers: { "x-request-id": "mcp-7f3a-0001" } });
    assert.equal(response.requestId, "mcp-7f3a-0001");
    assert.equal(errorOf(response).request_id, "mcp-7f3a-0001");
    // A header we cannot vouch for is replaced rather than refused: correlation is a convenience.
    const hostile = await harness.request("/nope", { headers: { "x-request-id": "a b\tc" } });
    assert.notEqual(hostile.requestId, "a b\tc");
  });
});

test("an unknown path is a structured 404 and a wrong method is a 405 that says what works", async () => {
  await withHarness({}, async (harness) => {
    const missing = await harness.request("/v1/nope");
    assert.equal(missing.status, 404);
    assert.equal(errorOf(missing).code, "ROUTE_NOT_FOUND");

    const wrongMethod = await harness.request("/v1/jobs", { method: "GET" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(errorOf(wrongMethod).code, "METHOD_NOT_ALLOWED");
    assert.equal(wrongMethod.headers.get("allow"), "POST");

    const health = await harness.request("/health", postJson("{}"));
    assert.equal(health.status, 405);
    assert.equal(health.headers.get("allow"), "GET");
  });
});

test("health answers while the database is closed; ready does not", async () => {
  await withHarness({}, async (harness) => {
    harness.closeStore();
    const health = await harness.request("/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(typeof health.body.uptime_seconds, "number");

    const ready = await harness.request("/ready");
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, "not_ready");
  });
});

test("ready reports migrations, the database and the worker heartbeat separately", async () => {
  const fresh = new Date(CLOCK_BASE - 30_000).toISOString();
  await withHarness({ dependencies: { workerHeartbeatAt: () => fresh } }, async (harness) => {
    const response = await harness.request("/ready");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.checks, { database: true, migrations: true, worker: true, adapter: null });
  });

  const stale = new Date(CLOCK_BASE - 600_000).toISOString();
  await withHarness({ dependencies: { workerHeartbeatAt: () => stale } }, async (harness) => {
    const response = await harness.request("/ready");
    assert.equal(response.status, 503);
    assert.deepEqual(response.body.checks, { database: true, migrations: true, worker: false, adapter: null });
  });

  // No worker has ever reported: silence is not freshness.
  await withHarness({}, async (harness) => {
    const response = await harness.request("/ready");
    assert.equal(response.status, 503);
  });

  // A supplied adapter probe is consulted, and its answer can hold readiness back on its own.
  await withHarness({
    dependencies: { workerHeartbeatAt: () => fresh, adapterReady: () => false },
  }, async (harness) => {
    const response = await harness.request("/ready");
    assert.equal(response.status, 503);
  });
});

test("the ingress gate admits loopback peers and nobody else while it is armed", () => {
  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(ingressAllowed(peer, true), true, peer);
  }
  for (const peer of ["10.0.0.5", "192.168.1.9", "8.8.8.8", "2606:4700::1111", undefined]) {
    assert.equal(ingressAllowed(peer, true), false, String(peer));
    // Disarmed, the same peer is admitted: the flag is the only thing standing between them.
    assert.equal(ingressAllowed(peer, false), true, String(peer));
  }
});

test("the server refuses to bind anything but loopback", async () => {
  await withHarness({}, async (harness) => {
    for (const host of ["0.0.0.0", "10.0.0.5", "::"]) {
      await assert.rejects(() => listen(harness.server, host, 0), /loopback/u, host);
    }
  });
});

test("a malformed body and a wrong media type are refused before validation", async () => {
  await withHarness({}, async (harness) => {
    const broken = await harness.request("/v1/jobs", postJson("{not json"));
    assert.equal(broken.status, 400);
    assert.equal(errorOf(broken).code, "INVALID_JSON");

    const empty = await harness.request("/v1/jobs", postJson(""));
    assert.equal(empty.status, 400);
    assert.equal(errorOf(empty).code, "INVALID_JSON");

    const wrongType = await harness.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: preparedRunBody(),
    });
    assert.equal(wrongType.status, 415);
    assert.equal(errorOf(wrongType).code, "UNSUPPORTED_MEDIA_TYPE");
  });
});

test("a caller id or idempotency key that could not be stored safely is refused", async () => {
  await withHarness({}, async (harness) => {
    const caller = await harness.request("/v1/jobs", postJson(preparedRunBody(), { "x-caller-id": "a/../b" }));
    assert.equal(caller.status, 400);
    assert.equal(errorOf(caller).code, "CALLER_ID_INVALID");

    const key = await harness.request("/v1/jobs", postJson(preparedRunBody(), { "idempotency-key": "k".repeat(129) }));
    assert.equal(key.status, 400);
    assert.equal(errorOf(key).code, "IDEMPOTENCY_KEY_INVALID");
  });
});
