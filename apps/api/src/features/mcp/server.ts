import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createManagementTools, ToolError, type ToolActorContext } from "../../tools/management";
import type { ToolDefinition, ToolExecution, ToolValue } from "../../tools/definition";
import { registerTools } from "../../tools/mcp";
import { enforceThrottles } from "../../lib/rate-limit";
import { createExternalEvidenceTools } from "./evidence-tools";

async function runTool(
  definition: ToolDefinition,
  input: unknown,
  execution: ToolExecution,
  ctx: ToolActorContext,
): Promise<ToolValue> {
  const name = definition.name;
  const startedAt = Date.now();
  let outcome = "success";
  try {
    const isWrite = definition.access === "write";
    const throttled = await enforceThrottles(ctx.env, [
      {
        scope: isWrite ? "mcp_write_user" : "mcp_read_user",
        ident: ctx.userId,
      },
    ]);
    if (throttled) {
      throw new ToolError(
        `MCP tool rate limit exceeded. Retry in ${throttled.retryAfterSec} seconds.`,
        {
          status: 429,
          code: "RATE_LIMITED",
          retry_after_seconds: throttled.retryAfterSec,
        },
      );
    }
    return await definition.invoke(input, execution);
  } catch (e) {
    outcome = "error";
    throw e;
  } finally {
    console.log(
      JSON.stringify({
        event: "mcp_tool_call",
        tool: name,
        outcome,
        durationMs: Date.now() - startedAt,
        authVia: ctx.authVia ?? "unknown",
        requestId: ctx.requestId,
      }),
    );
  }
}

/** Assemble the request-scoped catalog. Definitions enforce the actor’s authority at execution. */
export function createVideoqMcpServer(ctx: ToolActorContext): McpServer {
  const server = new McpServer({ name: "videoq-api", version: "0.3.0" });
  const management = createManagementTools(ctx).map(definition => ({
    ...definition,
    invoke: (input: unknown, execution: ToolExecution) => runTool(definition, input, execution, ctx),
  }));
  registerTools(server, [...management, ...createExternalEvidenceTools(ctx)], ctx.signal);
  return server;
}
