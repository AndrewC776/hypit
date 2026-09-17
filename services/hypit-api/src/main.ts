/**
 * The API service entry point.
 *
 * Everything the service needs arrives through the environment, and nothing it needs is a secret:
 * paths, a loopback host, a port and a policy flag. That is what lets this run as a launchd job
 * whose plist is world readable — see `ops/launchd/README.md`.
 *
 * The project registry may be given either as inline JSON or as the path of a JSON file. A plist is
 * a poor place to inline a growing JSON object, and a file is a poor default for a test, so both are
 * accepted here and the library parser below keeps seeing exactly one shape.
 */
import { readFileSync } from "node:fs";

import { JobStore } from "@hypit/job-store-sqlite";

import { loadApiConfig } from "./config.js";
import type { Environment } from "./config.js";
import { createServer, listen } from "./server.js";

const REGISTRY_VARIABLE = "HYPIT_PROJECT_REGISTRY";

/** Reads the registry from a file when the value is a path, so a plist can name one. */
function resolveRegistry(env: Environment): Environment {
  const raw = env[REGISTRY_VARIABLE];
  if (raw === undefined || raw.trim() === "" || raw.trim().startsWith("{")) return env;
  return { ...env, [REGISTRY_VARIABLE]: readFileSync(raw, "utf8") };
}

function main(): void {
  const config = loadApiConfig(resolveRegistry(process.env as Environment));
  const store = new JobStore(config.stateDatabasePath);
  // The store owns the worker-liveness row; the library keeps this a dependency so a deployment
  // that runs its workers elsewhere can answer the same question differently.
  const server = createServer({
    config,
    store,
    workerHeartbeatAt: () => store.latestWorkerHeartbeat(),
  });

  const shutdown = (signal: string): void => {
    process.stdout.write(`hypit-api stopping on ${signal}\n`);
    // Connections are closed explicitly: a keep-alive socket would otherwise hold the close open
    // until it timed out, and launchd would kill the job before it finished tidying up.
    server.closeAllConnections();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  void listen(server, config.host, config.port).then((listening) => {
    process.stdout.write(
      `hypit-api listening on http://${config.host}:${listening.port}`
        + ` ingress=${config.blockedExternalIngress ? "blocked" : "allowed"}\n`,
    );
  }, (error: unknown) => {
    process.stderr.write(`hypit-api failed to listen: ${String(error)}\n`);
    process.exit(1);
  });
}

main();
