import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCourseWithMembers } from "../../repositories/chat-repository";
import { reserveAiAnswerUsage, releaseAiAnswerReservation } from "../../repositories/quota-repository";
import { AnswerCostLedger, startAnswerCostLedger, finishAnswerCostLedger } from "../../lib/answer-cost-ledger";
import { enforceThrottles } from "../../lib/rate-limit";
import { deadlineSignal } from "../../lib/request-timeout";
import type { McpToolCallContext } from "../../lib/mcp-tools";
import { createEvidenceSession } from "../../tools/session";
import { registerEvidenceTools } from "../../tools/mcp";
import type { ToolDefinition } from "../../tools/definition";

/** External callers select a course; the server derives owner and allowed videos. */
export function registerExternalEvidenceTools(server: McpServer, ctx: McpToolCallContext) {
  const templates = createEvidenceSession(ctx.env, { ownerUserId: ctx.userId, videoIds: [], courseId: 1 }, new AbortController().signal);
  const definitions: ToolDefinition[] = templates.tools.map(template => {
    const schema = template.schema.extend({ course_id: z.number().int().positive().safe() }).strict();
    return {
      name: template.name,
      description: `${template.description} External callers must provide course_id from list_courses. Usage limits in this description apply to this execution scope; account limits also apply across requests.`,
      schema,
      async invoke(input, execution) {
        const parsed = schema.parse(input);
        const course_id = z.number().int().positive().safe().parse(parsed.course_id);
        const { course_id: _courseId, ...args } = parsed;
        const limited = await enforceThrottles(ctx.env, [{ scope: "mcp_read_user", ident: ctx.userId }]);
        if (limited) return { status: "rate_limited", retry_after_seconds: limited.retryAfterSec };
        const course = await getCourseWithMembers(ctx.env, { courseId: course_id, userId: ctx.userId });
        execution.signal.throwIfAborted();
        if (!course) return { status: "unavailable", message: "Course is unavailable or access is denied." };
        const visual = template.name === "inspect_clip" || template.name === "focus_clip" || args.include_visuals === true;
        const paid = template.name === "search_scenes" || visual;
        if (paid) {
          // Charge the maximum requested images before work; this limit persists
          // across stateless HTTP requests and clients, unlike session counters.
          const cost = visual ? (template.name === "overview_video" || template.name === "focus_clip" ? 16 : 8) : 1;
          const throttled = await enforceThrottles(ctx.env, [{ scope: "mcp_evidence_user", ident: ctx.userId, cost }]);
          if (throttled) return { status: "rate_limited", retry_after_seconds: throttled.retryAfterSec };
        }
        const quota = paid ? await reserveAiAnswerUsage(ctx.env, course.userId) : undefined;
        if (quota && !("reservation" in quota)) return { status: "quota_exceeded", message: "AI usage quota is exhausted." };
        const reservation = quota && "reservation" in quota ? quota.reservation : undefined;
        const usage = new AnswerCostLedger();
        const lifecycle = new AbortController();
        const signal = deadlineSignal(180_000, AbortSignal.any([execution.signal, lifecycle.signal]));
        const session = createEvidenceSession(ctx.env, { ownerUserId: course.userId, courseId: course.id, videoIds: course.memberVideoIds }, signal, { usage });
        let succeeded = false;
        let ledgerStarted = false;
        try {
          if (reservation) {
            await startAnswerCostLedger(ctx.env, usage, { planCode: reservation.planCode, quotaSource: reservation.quotaSource, hasCourse: true, streamed: false });
            ledgerStarted = true;
          }
          const definition = session.tools.find(tool => tool.name === template.name);
          if (!definition) return { status: "unavailable", message: "Tool is unavailable." };
          const value = await definition.invoke(args, { ...execution, signal });
          succeeded = true;
          return value;
        } finally {
          const interrupted = signal.aborted;
          lifecycle.abort();
          await session.close();
          // A call that never completed provider work does not consume an AI unit.
          const consumed = usage.calls.some(call => call.status === "completed");
          if (reservation && !consumed) {
            try { await releaseAiAnswerReservation(ctx.env, reservation); }
            catch { console.error(JSON.stringify({ event: "mcp_evidence_quota_release_failed" })); }
          }
          if (ledgerStarted) {
            try { await finishAnswerCostLedger(ctx.env, usage, { status: interrupted ? "interrupted" : succeeded ? "completed" : "failed", quotaConsumed: consumed }); }
            catch { console.error(JSON.stringify({ event: "mcp_evidence_usage_finish_failed" })); }
          }
        }
      },
    };
  });
  registerEvidenceTools(server, definitions, ctx.signal);
}
