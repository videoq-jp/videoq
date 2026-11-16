/** Operator configuration only. Invalid nonempty values stop traffic too.
 * This rejects NEW work; it does not prove existing invocations are drained. */
export function applicationTrafficPaused(env: { MIGRATION_TRAFFIC_STATE?: string }): boolean {
  return env.MIGRATION_TRAFFIC_STATE !== undefined && env.MIGRATION_TRAFFIC_STATE !== "running";
}

export function migrationPausedResponse(): Response {
  return Response.json({ error: { code: "MIGRATION_PAUSED", message: "Service temporarily unavailable for database maintenance." } }, {
    status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" },
  });
}
