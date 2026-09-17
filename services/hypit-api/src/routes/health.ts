import type { RequestContext } from "../context.js";
import { writeJson } from "../respond.js";

/**
 * `GET /health`: is this process alive.
 *
 * It touches no database on purpose. A liveness probe that fails when SQLite is busy asks a
 * supervisor to restart a process that is working fine, which turns a slow query into an outage.
 * Whether the control plane can actually accept work is `/ready`'s question, and it is a different
 * one.
 */
export async function health(context: RequestContext): Promise<void> {
  writeJson(context.response, 200, {
    status: "ok",
    uptime_seconds: Math.floor(process.uptime()),
  });
}
