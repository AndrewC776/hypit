import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { plainObject } from "@hypit/job-core";
import type { AddressLookup } from "@hypit/job-core";
import { JobStore } from "@hypit/job-store-sqlite";

import { createServer, listen, loadApiConfig } from "../src/index.js";
import type { ApiConfig, ApiDependencies, Environment } from "../src/index.js";

/**
 * One real server, one real SQLite file, one temporary directory, torn down in a `finally`.
 *
 * Nothing here is a mock of the thing under test: the tests drive HTTP over a loopback socket on
 * port 0 against the store the production service uses. What is injected is the world outside the
 * control plane — the clock, the DNS resolver, the worker's heartbeat — so that a suite that never
 * resolves a name and never reaches the network can still exercise the code that would.
 */
export const CLOCK_BASE = Date.UTC(2026, 8, 17, 11, 0, 0);

export type JsonResponse = {
  readonly status: number;
  readonly requestId: string | null;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
};

export type Harness = {
  readonly origin: string;
  readonly directory: string;
  readonly config: ApiConfig;
  readonly store: JobStore;
  readonly server: Server;
  request(path: string, init?: RequestInit): Promise<JsonResponse>;
  /** Closes the database mid-test, which is how "this endpoint touches no database" is proven. */
  closeStore(): void;
};

export type HarnessOptions = {
  /** Merged over the defaults; an explicit `undefined` removes a variable the defaults set. */
  readonly env?: Environment;
  /** Everything but `config` and `store`, which the harness owns. */
  readonly dependencies?: Omit<ApiDependencies, "config" | "store">;
};

/** Reads a JSON object out of an unknown payload, failing the test rather than casting past it. */
export function object(value: unknown): Record<string, unknown> {
  const record = plainObject(value);
  assert.ok(record !== undefined, `expected a JSON object, got ${JSON.stringify(value)}`);
  return record;
}

export function errorOf(response: JsonResponse): Record<string, unknown> {
  return object(response.body.error);
}

/** A resolver that answers from a fixed table and records what it was asked. */
export function recordingLookup(addresses: readonly string[]): {
  readonly lookup: AddressLookup;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    lookup: async (hostname: string) => {
      calls.push(hostname);
      return addresses.map((address) => ({ address }));
    },
  };
}

export async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "hypit-api-"));
  let store: JobStore | undefined;
  let storeClosed = false;
  let server: Server | undefined;
  try {
    const config = loadApiConfig({
      HYPIT_STATE_DB: join(directory, "state", "jobs.sqlite3"),
      HYPIT_API_PORT: "0",
      ...options.env,
    });
    store = new JobStore(config.stateDatabasePath);
    const dependencies: ApiDependencies = {
      config,
      store,
      now: () => CLOCK_BASE,
      ...options.dependencies,
    };
    server = createServer(dependencies);
    const listening = await listen(server, config.host, 0);
    const origin = `http://${config.host}:${listening.port}`;
    const opened = store;
    const harness: Harness = {
      origin,
      directory,
      config,
      store: opened,
      server,
      closeStore(): void {
        opened.close();
        storeClosed = true;
      },
      async request(path: string, init: RequestInit = {}): Promise<JsonResponse> {
        const response = await fetch(`${origin}${path}`, init);
        const text = await response.text();
        return {
          status: response.status,
          requestId: response.headers.get("x-request-id"),
          headers: response.headers,
          body: text === "" ? {} : object(JSON.parse(text)),
        };
      },
    };
    await body(harness);
  } finally {
    if (server !== undefined) {
      const listening = server;
      // Keep-alive sockets from `fetch` would otherwise hold `close` open until they time out.
      listening.closeAllConnections();
      await new Promise<void>((resolve) => listening.close(() => resolve()));
    }
    if (!storeClosed) store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export const OUTPUT = { width: 540, height: 960, fps: 30 } as const;

export function preparedRunBody(project = "demo", run = "chat.svrun"): string {
  return JSON.stringify({ mode: "prepared_run", project, run, output: OUTPUT });
}

export function cloneBody(url: string, instruction = "match the pacing of the reference"): string {
  return JSON.stringify({
    mode: "clone",
    reference: { type: "url", url },
    instruction,
    assets: [],
    output: OUTPUT,
  });
}

export const JSON_HEADERS: Readonly<Record<string, string>> = { "content-type": "application/json" };

export function postJson(body: string, headers: Readonly<Record<string, string>> = {}): RequestInit {
  return { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body };
}

/**
 * Counts rows through a second connection to the same file. The store deliberately exposes no
 * "list every job", so "exactly one row exists" is asserted against the database itself rather than
 * against the API that is under test — which is the only way for the idempotency test to mean
 * anything.
 */
export function countJobs(harness: Harness): number {
  const database = new DatabaseSync(harness.config.stateDatabasePath);
  try {
    const row = plainObject(database.prepare("SELECT COUNT(*) AS total FROM jobs").get());
    const total = row?.total;
    assert.equal(typeof total, "number", "COUNT(*) should return a number");
    return typeof total === "number" ? total : -1;
  } finally {
    database.close();
  }
}
