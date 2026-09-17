import type { Job, JobEvent } from "@hypit/job-core";
import type { JobStore } from "@hypit/job-store-sqlite";

import type { JobLogReader } from "./context.js";

/**
 * The default log source: the job's own event history, which is the one log the API can serve
 * without reading a file the worker owns. It is durable, ordered and already in the database the
 * request is holding open, so `GET /v1/jobs/:id/logs` answers from state rather than from I/O.
 *
 * A deployment that wants the Build's own execution log injects a reader that fetches it through
 * `@hypit/hypit-adapter`; the route sanitises whatever the reader returns either way, so a richer
 * source cannot widen what escapes.
 */
function renderEvent(event: JobEvent): string {
  const parts = [
    event.at,
    `seq=${event.seq}`,
    `${event.fromState ?? "-"}->${event.toState}`,
    `attempt=${event.attemptNo}`,
  ];
  if (event.reason !== null) parts.push(`reason=${event.reason}`);
  if (event.hypitBuildId !== null) parts.push(`build=${event.hypitBuildId}`);
  if (event.errorCode !== null) parts.push(`error=${event.errorCode}`);
  if (event.retryable !== null) parts.push(`retryable=${String(event.retryable)}`);
  // Serialised verbatim: the failure message inside it is exactly what the operator needs, and the
  // route redacts it on the way out rather than this reader deciding what is safe to keep.
  if (event.detailJson !== null) parts.push(`detail=${event.detailJson}`);
  return parts.join(" ");
}

export function eventLogReader(store: JobStore): JobLogReader {
  return (job: Job, tail: number): readonly string[] => {
    const events = store.listEvents(job.jobId);
    return events.slice(Math.max(0, events.length - tail)).map(renderEvent);
  };
}
