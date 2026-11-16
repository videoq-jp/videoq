import { applicationTrafficPaused, migrationPausedResponse } from "../lib/migration-traffic";
import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../types/bindings";
import { isChatExecutionRequest } from "../lib/chat-execution";

/**
 * Owns one ReAct answer's tools, sources, cancellation and response stream.
 * SQLite-backed DOs have a 30 s CPU budget on Workers Free; the edge fetch
 * handler has only 10 ms. No persistent DO rows, alarms or replay are needed:
 * the existing service commits the completed answer to Postgres before `done`.
 */
export class ChatExecution extends DurableObject<Bindings> {
  async fetch(request: Request): Promise<Response> {
    if (applicationTrafficPaused(this.env)) return migrationPausedResponse();
    if (!isChatExecutionRequest(request)) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    }
    // Use the same full HTTP pipeline: authentication, course access, request
    // limits and quota checks execute inside this invocation, never bypassed.
    const { createApp } = await import("../app");
    return createApp().fetch(request, this.env, {
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      passThroughOnException() {},
      props: {},
    });
  }
}
