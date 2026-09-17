import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ApiConfigError,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  DEFAULT_REFERENCE_ALLOWLIST,
  MAX_REQUEST_BODY_BYTES,
  isLoopbackHost,
  loadApiConfig,
} from "../src/index.js";
import type { Environment } from "../src/index.js";

/** Absolute, platform-correct, and never created: the configuration reader only inspects the path. */
const STATE_DB = join(tmpdir(), "hypit-api-config", "jobs.sqlite3");
const PROJECT = join(tmpdir(), "hypit-api-config", "projects", "demo");

function env(overrides: Environment = {}): Environment {
  return { HYPIT_STATE_DB: STATE_DB, ...overrides };
}

function configErrorOf(overrides: Environment): ApiConfigError {
  let thrown: unknown;
  try {
    loadApiConfig(env(overrides));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ApiConfigError, `expected an ApiConfigError, got ${String(thrown)}`);
  return thrown;
}

test("the defaults bind loopback 8787 with a 256 KiB body cap", () => {
  const config = loadApiConfig(env());
  assert.equal(config.host, DEFAULT_API_HOST);
  assert.equal(config.port, DEFAULT_API_PORT);
  assert.equal(config.maxBodyBytes, MAX_REQUEST_BODY_BYTES);
  assert.equal(config.maxBodyBytes, 256 * 1024);
  assert.deepEqual([...config.referenceAllowlist], [...DEFAULT_REFERENCE_ALLOWLIST]);
  assert.equal(config.projectRegistry.size, 0);
  assert.equal(config.workspaceRoot, null);
});

test("binding a host that is not loopback is a startup error", () => {
  for (const host of ["0.0.0.0", "10.10.0.3", "192.168.1.10", "::", "8.8.8.8", "example.com", "", "0"]) {
    const error = configErrorOf({ HYPIT_API_HOST: host });
    assert.equal(error.code, "API_HOST_NOT_LOOPBACK", `${host} should be refused`);
    assert.equal(error.variable, "HYPIT_API_HOST");
  }
});

test("every loopback spelling is accepted", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.equal(loadApiConfig(env({ HYPIT_API_HOST: host })).host, host);
  }
});

test("the state database path is required and must be absolute", () => {
  assert.equal(configErrorOf({ HYPIT_STATE_DB: undefined }).variable, "HYPIT_STATE_DB");
  assert.equal(configErrorOf({ HYPIT_STATE_DB: "state/jobs.sqlite3" }).variable, "HYPIT_STATE_DB");
});

test("the project registry maps a project key to an absolute path", () => {
  const config = loadApiConfig(env({ HYPIT_PROJECT_REGISTRY: JSON.stringify({ demo: PROJECT }) }));
  assert.equal(config.projectRegistry.get("demo"), PROJECT);
  for (const registry of ["{", "[]", JSON.stringify({ demo: "projects/demo" }), JSON.stringify({ "../demo": PROJECT })]) {
    assert.equal(configErrorOf({ HYPIT_PROJECT_REGISTRY: registry }).variable, "HYPIT_PROJECT_REGISTRY");
  }
});

test("external ingress stays blocked unless it is explicitly disabled", () => {
  assert.equal(loadApiConfig(env()).blockedExternalIngress, true);
  assert.equal(loadApiConfig(env({ SECURITY_BLOCKED_EXTERNAL_INGRESS: "true" })).blockedExternalIngress, true);
  assert.equal(loadApiConfig(env({ SECURITY_BLOCKED_EXTERNAL_INGRESS: "false" })).blockedExternalIngress, false);
  // A typo must fail closed rather than read as "not true, therefore open".
  assert.equal(configErrorOf({ SECURITY_BLOCKED_EXTERNAL_INGRESS: "0" }).code, "API_CONFIG_INVALID");
});

test("the reference allow-list can be narrowed and rejects a non-host entry", () => {
  const config = loadApiConfig(env({ HYPIT_REFERENCE_ALLOWLIST: "vt.tiktok.com, www.tiktok.com" }));
  assert.deepEqual([...config.referenceAllowlist], ["vt.tiktok.com", "www.tiktok.com"]);
  assert.equal(configErrorOf({ HYPIT_REFERENCE_ALLOWLIST: "https://tiktok.com/x" }).variable,
    "HYPIT_REFERENCE_ALLOWLIST");
});

test("the port must be a valid TCP port", () => {
  assert.equal(loadApiConfig(env({ HYPIT_API_PORT: "0" })).port, 0);
  assert.equal(configErrorOf({ HYPIT_API_PORT: "70000" }).variable, "HYPIT_API_PORT");
  assert.equal(configErrorOf({ HYPIT_API_PORT: "8787.5" }).variable, "HYPIT_API_PORT");
});
