import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { JobStateTransitionError, redact } from "@hypit/job-core";
import { JobStoreError } from "@hypit/job-store-sqlite";

import { isLoopbackHost } from "./config.js";
import { resolveDependencies } from "./context.js";
import type { ApiDependencies, RequestContext, ResolvedDependencies } from "./context.js";
import { ApiError, apiError } from "./errors.js";
import { REQUEST_ID_HEADER, resolveRequestId, writeApiError } from "./respond.js";
import { createRouter } from "./router.js";
import type { Route } from "./router.js";
import { cancelJob } from "./routes/cancel-job.js";
import { createJob } from "./routes/create-job.js";
import { createRevision } from "./routes/create-revision.js";
import { getJob } from "./routes/get-job.js";
import { getJobLogs } from "./routes/get-job-logs.js";
import { getJobOutputs } from "./routes/get-job-outputs.js";
import { health } from "./routes/health.js";
import { ready } from "./routes/ready.js";

/**
 * The server: a router, a request id, an ingress gate, and one error funnel.
 *
 * It never calls `listen`. Binding is the caller's decision — the service entry point binds the
 * configured loopback host, and a test binds port 0 — and a factory that bound a port itself would
 * force every test to either race for 8787 or reimplement this wiring.
 */
const ROUTES: readonly Route<RequestContext>[] = [
  { method: "POST", path: "/v1/jobs", handler: createJob },
  { method: "GET", path: "/v1/jobs/:id", handler: getJob },
  { method: "GET", path: "/v1/jobs/:id/logs", handler: getJobLogs },
  { method: "POST", path: "/v1/jobs/:id/cancel", handler: cancelJob },
  { method: "GET", path: "/v1/jobs/:id/outputs", handler: getJobOutputs },
  { method: "POST", path: "/v1/jobs/:id/revisions", handler: createRevision },
  { method: "GET", path: "/health", handler: health },
  { method: "GET", path: "/ready", handler: ready },
];

const router = createRouter(ROUTES);

/** A base that is never used: only the path and query of the request line are read from it. */
const URL_BASE = "http://api.invalid";

function requestUrl(request: IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? "/", URL_BASE);
  } catch {
    return undefined;
  }
}

/**
 * Translates whatever a route threw into one of our own errors.
 *
 * An unexpected failure becomes a bare 500 whose message says nothing. A stack trace, a SQLite
 * message or a Node errno all carry filesystem paths, and this is the boundary where they would
 * escape to a caller; the detail goes to the log line instead, redacted.
 */
function toApiError(error: unknown, deps: ResolvedDependencies, requestId: string): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof JobStoreError) {
    if (error.code === "JOB_NOT_FOUND") return apiError(404, "JOB_NOT_FOUND", "job does not exist");
    return apiError(500, "INTERNAL", "the control plane could not complete this request");
  }
  // A refused transition means the job moved under the caller: a cancel that lost a race with the
  // worker, say. That is a conflict, not a server fault.
  if (error instanceof JobStateTransitionError) {
    return apiError(409, "INTERNAL", "the job changed state while this request was being handled");
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  deps.log(`${requestId} unhandled ${redact(detail)}`);
  return apiError(500, "INTERNAL", "the control plane could not complete this request");
}

/**
 * Contract non-negotiable 7. The listener is already loopback-only, so this is the second lock on the
 * same door: if a tunnel or a proxy is ever pointed at the port, a request from off-host is refused
 * while the flag stands, and the flag only comes down once the leaked credentials are rotated.
 */
export function ingressAllowed(remoteAddress: string | undefined, blocked: boolean): boolean {
  if (!blocked) return true;
  // An unknown peer is not a local peer. A socket with no address is a socket we cannot vouch for.
  return remoteAddress !== undefined && isLoopbackHost(remoteAddress);
}

function assertLocalIngress(request: IncomingMessage, deps: ResolvedDependencies): void {
  if (ingressAllowed(request.socket.remoteAddress, deps.config.blockedExternalIngress)) return;
  throw apiError(403, "EXTERNAL_INGRESS_BLOCKED", "this control plane serves loopback callers only");
}

async function dispatch(context: RequestContext): Promise<void> {
  assertLocalIngress(context.request, context.deps);
  const match = router.match(context.request.method ?? "GET", context.url.pathname);
  if (match.kind === "not-found") {
    throw apiError(404, "ROUTE_NOT_FOUND", "no such endpoint");
  }
  if (match.kind === "method-not-allowed") {
    const error = apiError(405, "METHOD_NOT_ALLOWED", `this endpoint accepts ${match.allowed.join(", ")}`);
    writeApiError(context.response, error, context.requestId, { allow: match.allowed.join(", ") });
    return;
  }
  await match.handler(context, match.params);
}

/**
 * How much of a refused body may still be read and thrown away, as a multiple of the cap.
 *
 * The body itself was never buffered — that is what the cap is for — but the sender is usually still
 * mid-upload when the 413 goes out, and closing a socket that still has unread bytes coming makes the
 * peer's TCP stack discard the answer it was just sent. Draining the remainder is what gets the 413
 * delivered; the bound is what keeps an endless stream from holding the connection open for it.
 */
const DISCARD_BUDGET = 8;

/**
 * How long a refused upload may go on being drained before the answer goes out regardless.
 *
 * A sender that declared an oversized `content-length` and then stopped would otherwise hold the
 * refusal open forever, so the drain is bounded by time as well as by bytes.
 */
const LINGER_MS = 500;

/**
 * Answer an oversized body only once the sender has stopped sending.
 *
 * Writing the 413 first and draining afterwards loses the answer: the response ends, the socket
 * closes with the upload still in flight, and the peer's TCP stack discards the bytes it had already
 * received in favour of a reset. The caller then sees `EPIPE` with no reason attached, which is the
 * one thing a refusal is supposed to provide. So the order is drain, then answer — bounded by the
 * byte budget above, by `LINGER_MS`, and by the sender simply finishing.
 */
function refuseOversized(context: RequestContext, failure: ApiError): void {
  const limit = context.deps.config.maxBodyBytes * DISCARD_BUDGET;
  let discarded = 0;
  let answered = false;
  const answer = (): void => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    if (context.response.headersSent) {
      context.response.end();
      return;
    }
    writeApiError(context.response, failure, context.requestId, { connection: "close" });
  };
  const timer = setTimeout(answer, LINGER_MS);
  // A pending drain must never be the reason a process stays alive.
  timer.unref();
  context.request.on("data", (chunk: Buffer) => {
    discarded += chunk.byteLength;
    if (discarded > limit) {
      answer();
      context.request.destroy();
    }
  });
  context.request.on("end", answer);
  context.request.on("aborted", answer);
  context.request.on("error", answer);
  context.request.resume();
}

function finish(context: RequestContext, error: unknown): void {
  const apiFailure = toApiError(error, context.deps, context.requestId);
  if (context.response.headersSent) {
    context.response.end();
    return;
  }
  if (apiFailure.code === "BODY_TOO_LARGE") {
    refuseOversized(context, apiFailure);
    return;
  }
  writeApiError(context.response, apiFailure, context.requestId, {});
}

export function createServer(dependencies: ApiDependencies): Server {
  const deps = resolveDependencies(dependencies);
  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const requestId = resolveRequestId(request.headers[REQUEST_ID_HEADER], deps.newRequestId);
    // Set before anything can fail, so every response carries it — including the ones written by
    // the error funnel, which is where a caller most needs a line to correlate.
    response.setHeader(REQUEST_ID_HEADER, requestId);
    const url = requestUrl(request);
    if (url === undefined) {
      // Everything else in this handler runs inside a promise chain that funnels its failures. A
      // throw out here would reach the `request` listener instead, and an uncaught exception in a
      // listener ends the process — so the one parse that can throw is handled where it happens.
      const failure = apiError(400, "REQUEST_TARGET_INVALID", "the request target could not be parsed");
      writeApiError(response, failure, requestId);
      deps.log(`${requestId} ${request.method ?? "GET"} <unparseable> 400`);
      return;
    }
    const context: RequestContext = { deps, request, response, requestId, url };
    dispatch(context)
      .catch((error: unknown) => finish(context, error))
      .finally(() => {
        deps.log(`${requestId} ${request.method ?? "GET"} ${redact(url.pathname)} ${response.statusCode}`);
      });
  });
}

export type ListeningServer = {
  readonly server: Server;
  readonly port: number;
};

/**
 * Binds the configured host. The loopback rule is checked again here rather than trusted from the
 * configuration: this is the line that actually opens a socket, and a rule that matters is worth
 * enforcing where it takes effect.
 */
export async function listen(server: Server, host: string, port: number): Promise<ListeningServer> {
  if (!isLoopbackHost(host)) {
    throw new Error(`refusing to bind ${host}: the control plane listens on loopback only`);
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server bound no TCP port");
  }
  return { server, port: address.port };
}
